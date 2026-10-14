/**
 * Knowledge-visibility validation, database + HTTP part.
 *
 * Starts throwaway backend servers, one per authorized level (guest / staff /
 * restricted, plus an unset and an invalid value that must fail closed to
 * guest), all reading the same MongoDB and the same Python AI service
 * (started with LLM_PROVIDER=test EMBEDDING_PROVIDER=test - no external
 * provider is ever called). Everything is created inside stamped throwaway
 * workspaces and removed by workspaceId afterward; real operational data
 * (Guest / Stay / ImportBatch) is fingerprinted before and after.
 *
 * All fixtures are SYNTHETIC. Chunks carry hand-made vectors, so no real
 * document and no embedding provider is involved.
 *
 * Covers: retrieval enforcement per level, filtering BEFORE the candidate
 * cap, a caller not being able to choose its own level, the direct document
 * and chunk APIs, Intelligence provenance visibility, the classification
 * hook at chunking time, fail-closed service defaults, tenant isolation, and
 * Python's own defensive check.
 */
import { actorFor } from "./lib/authFixtures.mjs";
import { registerServerLevel } from "./lib/authFetch.mjs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  Workspace, Property, Signal, KnowledgeDocument, KnowledgeChunk, Intelligence, Guest, Stay, ImportBatch,
} from "../src/models/index.js";
import { createGeneratedIntelligence } from "../src/services/intelligenceService.js";
import { rebuildChunksForDocument } from "../src/services/knowledgeChunkService.js";
import { retrieveKnowledgeForSignal } from "../src/services/knowledgeRetrievalService.js";
import { analyzeSignal } from "../src/services/intelligenceAnalysisService.js";
import { createChunkClassifier } from "../src/services/knowledge/corpusClassification.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "server.js");
const PYTHON_BASE = process.env.PYTHON_BASE || "http://localhost:8000";
const PORTS = { guest: 5091, staff: 5092, restricted: 5093, unset: 5094, invalid: 5095 };

let passed = 0;
let failed = 0;
const ok = (name) => { passed += 1; console.log(`PASS  ${name}`); };
const fail = (name, detail = "") => { failed += 1; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); };
const check = (name, cond, detail = "") => (cond ? ok(name) : fail(name, detail));
const same = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
const sorted = (list) => [...list].sort();

const created = { workspaceIds: [] };
const servers = [];

async function startServer(name, port, level) {
  const env = { ...process.env, PORT: String(port), LLM_PROVIDER: "test-python", AI_SERVICE_URL: PYTHON_BASE };
  delete env.KNOWLEDGE_DEV_AUTHORIZED_LEVEL;
  if (level !== undefined) env.KNOWLEDGE_DEV_AUTHORIZED_LEVEL = level;
  const child = spawn(process.execPath, [SERVER_ENTRY], { env, stdio: "ignore" });
  servers.push(child);
  const base = `http://localhost:${port}/api`;
  const start = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${base}/health`)).ok) { registerServerLevel(base, level); return base; }
    } catch { /* not ready */ }
    if (Date.now() - start > 30000) throw new Error(`server ${name} did not become healthy`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function http(base, method, url, body, headers = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}

const vec = (seed) => Array.from({ length: 32 }, (_, i) => Math.sin(seed * 31 + i) + 0.001);

async function fingerprint() {
  const out = {};
  for (const [name, Model] of [["Guest", Guest], ["Stay", Stay], ["ImportBatch", ImportBatch]]) {
    const rows = await Model.find({}, { _id: 1, updatedAt: 1 }).sort({ _id: 1 }).lean();
    out[name] = `${rows.length}:${crypto.createHash("sha256").update(rows.map((r) => `${r._id}:${r.updatedAt?.getTime?.() ?? ""}`).join("|")).digest("hex").slice(0, 12)}`;
  }
  return out;
}

async function cleanup() {
  const ids = created.workspaceIds;
  await KnowledgeChunk.deleteMany({ workspaceId: { $in: ids } });
  await KnowledgeDocument.deleteMany({ workspaceId: { $in: ids } });
  await Intelligence.deleteMany({ workspaceId: { $in: ids } });
  await Signal.deleteMany({ workspaceId: { $in: ids } });
  await Property.deleteMany({ workspaceId: { $in: ids } });
  await Workspace.deleteMany({ _id: { $in: ids } });
}

async function main() {
  const health = await fetch(`${PYTHON_BASE}/v1/health`).then((r) => r.json()).catch(() => null);
  if (health?.status !== "healthy") {
    fail("Python AI service reachable", `${PYTHON_BASE} — start ai-service with LLM_PROVIDER=test EMBEDDING_PROVIDER=test`);
    return;
  }
  ok("Python AI service reachable");

  await connectDatabase();
  const before = await fingerprint();
  const stamp = Date.now();

  const bases = {
    restricted: await startServer("restricted", PORTS.restricted, "restricted"),
    staff: await startServer("staff", PORTS.staff, "staff"),
    guest: await startServer("guest", PORTS.guest, "guest"),
    unset: await startServer("unset", PORTS.unset, undefined),
    invalid: await startServer("invalid", PORTS.invalid, "admin"),
  };
  const admin = bases.restricted; // setup only; the restricted level can create and read everything

  const wsA = (await Workspace.create({ name: `7G Vis A ${stamp}`, slug: `7g-vis-a-${stamp}` }))._id;
  const wsB = (await Workspace.create({ name: `7G Vis B ${stamp}`, slug: `7g-vis-b-${stamp}` }))._id;
  const wsCap = (await Workspace.create({ name: `7G Vis Cap ${stamp}`, slug: `7g-vis-cap-${stamp}` }))._id;
  created.workspaceIds.push(wsA, wsB, wsCap);

  const createDoc = async (workspaceId, title, defaultVisibility, content) => {
    const res = await http(admin, "POST", "/knowledge-documents", {
      workspaceId: String(workspaceId), title, documentType: "sop", isTestData: true, content, ...(defaultVisibility ? { defaultVisibility } : {}),
    });
    if (res.status !== 201) fail(`fixture: create ${title}`, JSON.stringify(res.json));
    return res.json?.data?._id;
  };
  const chunk = (workspaceId, documentId, chunkIndex, text, visibility, seed) => ({
    documentId, version: 1, workspaceId, status: "active", chunkIndex, section: `S${chunkIndex}`, sectionPath: [`S${chunkIndex}`],
    text, visibility, embedding: vec(seed), embeddingModel: "deterministic-embedding-v1",
  });

  // ------------------------------------------------------------------ fixtures
  const MARK = { g1: "SYNTH-G1", s1: "SYNTH-S1", r1: "SYNTH-R1", gd: "SYNTH-GD", st: "SYNTH-ST", rd: "SYNTH-RD" };
  const docMix = await createDoc(wsA, "Mixed doc", "staff", `# One\n\nSYNTH-CONTENT-MIX ${MARK.g1} ${MARK.s1} ${MARK.r1}`);
  const docGuest = await createDoc(wsA, "Guest-default doc", "guest", `# One\n\nSYNTH-CONTENT-GUESTDOC ${MARK.gd}`);
  const docStaff = await createDoc(wsA, "Staff doc", "staff", `# One\n\nSYNTH-CONTENT-STAFFDOC ${MARK.st}`);
  const docRestr = await createDoc(wsA, "Restricted doc", "restricted", `# One\n\nSYNTH-CONTENT-RESTRDOC ${MARK.rd}`);
  const docDefault = await createDoc(wsA, "Doc with no explicit default", undefined, "# One\n\nSYNTH-CONTENT-DEFAULT");
  const docB = await createDoc(wsB, "Other tenant doc", "guest", "# One\n\nSYNTH-OTHER-TENANT");

  await KnowledgeChunk.insertMany([
    chunk(wsA, docMix, 0, `guest text ${MARK.g1}`, "guest", 1),
    chunk(wsA, docMix, 1, `staff text ${MARK.s1}`, "staff", 2),
    chunk(wsA, docMix, 2, `restricted text ${MARK.r1}`, "restricted", 3),
    chunk(wsA, docGuest, 0, `guest doc text ${MARK.gd}`, "guest", 4),
    chunk(wsA, docStaff, 0, `staff doc text ${MARK.st}`, "staff", 5),
    chunk(wsA, docRestr, 0, `restricted doc text ${MARK.rd}`, "restricted", 6),
    chunk(wsB, docB, 0, "guest text of ANOTHER TENANT", "guest", 7),
  ]);

  const signalRes = await http(admin, "POST", "/signals", { workspaceId: String(wsA), type: "maintenance", title: "AC not cooling", description: "Warm air." });
  const signalId = signalRes.json?.data?._id;
  check("fixtures created", !!(docMix && docGuest && docStaff && docRestr && docB && signalId));
  const W = `workspaceId=${wsA}`;

  // ----------------------------------------------------------- 1. retrieval
  // PHASE 13: GET /signals/:id/knowledge-retrieval is ADMIN-ONLY over HTTP, so a guest- or
  // staff-ceiling retrieval can no longer be made through the route. The level under test is
  // exercised through the SAME service the route calls (retrieveKnowledgeForSignal), with the
  // ceiling a role would supply: unset / invalid stand for a missing / unknown ceiling.
  process.env.AI_SERVICE_URL = PYTHON_BASE;
  const retrieve = async (level) => {
    const at = level === "unset" ? undefined : level === "invalid" ? "admin" : level;
    const out = await retrieveKnowledgeForSignal(String(signalId), String(wsA), at);
    return { status: 200, results: out.results || [], raw: JSON.stringify(out) };
  };
  const ids = (results) => sorted(results.map((r) => r.text.match(/SYNTH-[A-Z0-9]+/)?.[0]));

  const g = await retrieve("guest");
  const s = await retrieve("staff");
  const r = await retrieve("restricted");
  same("guest caller retrieves only guest chunks", ids(g.results), sorted([MARK.g1, MARK.gd]));
  same("staff caller retrieves guest + staff chunks", ids(s.results), sorted([MARK.g1, MARK.gd, MARK.s1, MARK.st]));
  check("restricted caller retrieves from all three levels (top-K = 5 of 6 eligible chunks)", r.results.length === 5 && ["guest", "staff", "restricted"].every((lvl) => r.results.some((x) => x.visibility === lvl)) && ids(r.results).every((m) => Object.values(MARK).includes(m)), JSON.stringify(ids(r.results)));
  check("guest response contains no staff or restricted text at all", ![MARK.s1, MARK.r1, MARK.st, MARK.rd].some((m) => g.raw.includes(m)));
  check("staff response contains no restricted text at all", ![MARK.r1, MARK.rd].some((m) => s.raw.includes(m)));
  check("every result reports a visibility no higher than the caller's", g.results.every((x) => x.visibility === "guest") && s.results.every((x) => ["guest", "staff"].includes(x.visibility)));
  check("results still expose sectionPath and scoring fields (contract preserved)", r.results.every((x) => Array.isArray(x.sectionPath) && typeof x.similarityScore === "number" && typeof x.retrievalScore === "number"));
  check("results stay sorted by retrievalScore descending", r.results.every((x, i, a) => i === 0 || a[i - 1].retrievalScore >= x.retrievalScore));

  // Another tenant's guest-visible chunk never appears (tenant isolation unchanged)
  check("tenant isolation: another workspace's guest chunk is never returned", ![g, s, r].some((x) => x.raw.includes("ANOTHER TENANT")));
  check("tenant isolation: cross-workspace document read is still a 404", (await http(admin, "GET", `/knowledge-documents/${docB}?${W}`)).status === 404);

  // ------------------------------------- 2. the caller cannot choose its own level
  // (Phase 13) Over HTTP, retrieval needs workspace:admin. A viewer or operator - however it labels
  // itself with query parameters or headers - is refused outright, and a token claim cannot change that.
  for (const [label, extra, headers] of [
    ["?authorizedLevel=restricted", "&authorizedLevel=restricted", {}],
    ["?level=restricted&visibility=restricted", "&level=restricted&visibility=restricted", {}],
    ["x-authorized-level header", "", { "x-authorized-level": "restricted" }],
    ["x-knowledge-level header", "", { "x-knowledge-level": "restricted", "x-role": "admin" }],
  ]) {
    for (const role of ["viewer", "operator"]) {
      const actor = await actorFor(role, String(wsA), "vis-nonadmin");
      const res = await fetch(`${bases.guest}/signals/${signalId}/knowledge-retrieval?${W}${extra}`, { headers: { ...actor.headers, ...headers } });
      check(`a ${role} is refused knowledge retrieval whatever level it claims (${label})`, res.status === 403, `HTTP ${res.status}`);
    }
  }
  {
    const actor = await actorFor("operator", String(wsA), "vis-nonadmin");
    const spoofBody = await fetch(`${bases.guest}/knowledge-documents`, { method: "POST", headers: { "Content-Type": "application/json", ...actor.headers }, body: JSON.stringify({ workspaceId: String(wsA), title: "spoof", documentType: "sop", isTestData: true, content: "SYNTH-SPOOF", authorizedLevel: "restricted", defaultVisibility: "restricted" }) });
    check("a non-admin cannot create knowledge at all, whatever level or visibility its body claims (403)", spoofBody.status === 403, `HTTP ${spoofBody.status}`);
  }
  same("an unset server level fails closed to guest", ids((await retrieve("unset")).results), sorted([MARK.g1, MARK.gd]));
  same("an invalid server level fails closed to guest", ids((await retrieve("invalid")).results), sorted([MARK.g1, MARK.gd]));

  // ---------------------------------------- 3. filtering happens BEFORE the cap
  {
    const capDoc = await createDoc(wsCap, "Cap doc", "staff", "# One\n\nSYNTH-CAP");
    const many = Array.from({ length: 205 }, (_, i) => chunk(wsCap, capDoc, i, `restricted filler ${i}`, "restricted", 100 + i));
    const guestOnes = Array.from({ length: 3 }, (_, i) => chunk(wsCap, capDoc, 205 + i, `guest survivor ${i}`, "guest", 400 + i));
    await KnowledgeChunk.insertMany([...many, ...guestOnes], { ordered: true }); // restricted rows have the LOWER _ids
    const capSignal = (await http(admin, "POST", "/signals", { workspaceId: String(wsCap), type: "maintenance", title: "Cap test", description: "x" })).json?.data?._id;
    const capGet = async (level) => (await retrieveKnowledgeForSignal(String(capSignal), String(wsCap), level)).results || [];
    const guestCap = await capGet("guest");
    same("cap: guest still gets all 3 guest chunks although 205 higher-level chunks come first by _id", sorted(guestCap.map((x) => x.text)), ["guest survivor 0", "guest survivor 1", "guest survivor 2"]);
    check("cap: staff sees the same 3 (no staff chunks exist)", (await capGet("staff")).length === 3);
    const restrictedCap = await capGet("restricted");
    check("cap: restricted still gets at most top-K = 5 from a capped candidate set", restrictedCap.length === 5, `got ${restrictedCap.length}`);
    check("cap: with the 200-candidate cap applied to the restricted set, later guest chunks are not candidates for it", restrictedCap.every((x) => x.visibility === "restricted"));
  }

  // -------------------------------------------------- 4. direct document API
  const docGet = async (level, id) => http(bases[level], "GET", `/knowledge-documents/${id}?${W}`);
  const has = (res, marker) => JSON.stringify(res.json).includes(marker);
  {
    const dm = { guest: await docGet("guest", docMix), staff: await docGet("staff", docMix), restricted: await docGet("restricted", docMix) };
    check("doc(default staff, contains restricted chunk): guest -> 404", dm.guest.status === 404);
    check("doc(default staff, contains restricted chunk): staff -> 200 but content withheld", dm.staff.status === 200 && dm.staff.json.data.content === undefined && dm.staff.json.data.contentRedacted === true && !has(dm.staff, "SYNTH-CONTENT-MIX"));
    check("doc(default staff, contains restricted chunk): restricted -> 200 with content", dm.restricted.status === 200 && has(dm.restricted, "SYNTH-CONTENT-MIX"));
    const dg = await docGet("guest", docGuest);
    check("doc(default guest, all-guest chunks): guest -> 200 with content", dg.status === 200 && has(dg, "SYNTH-CONTENT-GUESTDOC"));
    const ds = { guest: await docGet("guest", docStaff), staff: await docGet("staff", docStaff) };
    check("doc(default staff, staff chunks): guest -> 404, staff -> 200 with content", ds.guest.status === 404 && ds.staff.status === 200 && has(ds.staff, "SYNTH-CONTENT-STAFFDOC"));
    const dr = { guest: await docGet("guest", docRestr), staff: await docGet("staff", docRestr), restricted: await docGet("restricted", docRestr) };
    check("doc(default restricted): guest 404, staff 404, restricted 200", dr.guest.status === 404 && dr.staff.status === 404 && dr.restricted.status === 200);
    check("a hidden document's 404 is indistinguishable from a missing one", dm.guest.json.message === (await docGet("guest", "000000000000000000000000")).json.message);
    same("a document created without defaultVisibility gets 'staff'", (await docGet("restricted", docDefault)).json.data.defaultVisibility, "staff");
    check("a document with no chunks yet is readable by staff via its default, with content", (await docGet("staff", docDefault)).status === 200 && (await docGet("guest", docDefault)).status === 404);

    const list = async (level) => (await http(bases[level], "GET", `/knowledge-documents?${W}&limit=50`, null));
    const titles = (res) => sorted(res.json.data.map((d) => d.title));
    const lg = await list("guest");
    const ls = await list("staff");
    const lr = await list("restricted");
    same("list: guest sees only guest-default documents", titles(lg).filter((t) => t !== "spoof"), ["Guest-default doc"]);
    check("list: guest pagination total matches what is returned", lg.json.pagination.total === lg.json.data.length);
    check("list: staff sees guest + staff documents, none restricted-default", ls.json.data.every((d) => d.title !== "Restricted doc") && ls.json.data.some((d) => d.title === "Staff doc"));
    check("list: staff never receives the mixed document's content", ls.json.data.filter((d) => d.title === "Mixed doc").every((d) => d.content === undefined && d.contentRedacted === true));
    check("list: restricted sees every document with content", ["Mixed doc", "Restricted doc"].every((t) => lr.json.data.find((d) => d.title === t)?.content));
    check("list: no level ever receives another tenant's document", ![lg, ls, lr].some((x) => JSON.stringify(x.json).includes("SYNTH-OTHER-TENANT")));
    check("list: guest response never contains staff/restricted content markers", !["SYNTH-CONTENT-MIX", "SYNTH-CONTENT-STAFFDOC", "SYNTH-CONTENT-RESTRDOC", MARK.r1, MARK.st].some((m) => JSON.stringify(lg.json).includes(m)));
  }

  // -------------------------------------------------- 5. direct chunk API
  {
    const cg = async (level, id) => http(bases[level], "GET", `/knowledge-documents/${id}/chunks?${W}`);
    const cm = { guest: await cg("guest", docMix), staff: await cg("staff", docMix), restricted: await cg("restricted", docMix) };
    check("chunks(mixed doc): guest -> 404 (document above the level)", cm.guest.status === 404);
    same("chunks(mixed doc): staff sees only guest + staff chunks", sorted(cm.staff.json.data.map((c) => c.visibility)), ["guest", "staff"]);
    check("chunks(mixed doc): staff response has no restricted text and its total agrees", !has(cm.staff, MARK.r1) && cm.staff.json.pagination.total === 2);
    same("chunks(mixed doc): restricted sees all three", sorted(cm.restricted.json.data.map((c) => c.visibility)), ["guest", "restricted", "staff"]);
    const cgd = await cg("guest", docGuest);
    check("chunks(guest-default doc): guest sees its guest chunk", cgd.status === 200 && cgd.json.data.length === 1);
    check("chunks: every returned chunk carries its visibility", cm.restricted.json.data.every((c) => typeof c.visibility === "string"));
  }

  // ---------------------------- 6. chunk creation: default + classification hook
  {
    const docToChunk = await createDoc(wsA, "To chunk", "guest", "# 1. Alpha\n\nAlpha body line.\n\n# 2. Beta\n\nBeta body line.");
    const viaGuest = await http(bases.guest, "POST", `/knowledge-documents/${docToChunk}/chunks?${W}`);
    const stored = await KnowledgeChunk.find({ documentId: docToChunk }).sort({ chunkIndex: 1 }).lean();
    check("chunks created via the API take the document's defaultVisibility", stored.length === 2 && stored.every((c) => c.visibility === "guest"));
    check("the rebuild response only returns chunks the caller may see (an admin sees the guest chunks of a guest document)", viaGuest.status === 201 && viaGuest.json.data.chunks.every((c) => c.visibility === "guest"));

    const stricter = await createDoc(wsA, "To chunk staff", "staff", "# 1. Alpha\n\nAlpha body line.");
    await http(bases.guest, "POST", `/knowledge-documents/${stricter}/chunks?${W}`);
    const stricterStored = await KnowledgeChunk.find({ documentId: stricter }).lean();
    check("a staff-default document's chunks are staff, and a guest caller's rebuild response omits them", stricterStored.every((c) => c.visibility === "staff"));
    // (Phase 13) The rebuild route is ADMIN-ONLY, so its response is always at the admin's ceiling;
    // the guest-level view of a staff document is checked at the service instead.
    const rebuildGuestView = await rebuildChunksForDocument(stricter, String(wsA), { authorizedLevel: "guest" });
    check("...a guest-ceiling rebuild response contains no chunk text (service level)", rebuildGuestView.chunks.length === 0 && !JSON.stringify(rebuildGuestView).includes("Alpha body line."));

    const mapping = {
      preamble: { action: "exclude", visibility: "not applicable", reason: "preamble" },
      entries: [
        { number: "1", title: "Alpha", action: "include", visibility: "guest", reason: "r" },
        { number: "2", title: "Beta", action: "include", visibility: "staff", reason: "r" },
        { number: "3", title: "Gamma", action: "hold", visibility: "restricted", reason: "r" },
        { number: "4", title: "Delta", action: "exclude", visibility: "not applicable", reason: "r" },
      ],
    };
    const classifiedDoc = await createDoc(wsA, "Classified", "staff", "Preamble text.\n\n# 1. Alpha\n\nAlpha body.\n\n# 2. Beta\n\nBeta body.\n\n# 3. Gamma\n\nGamma body.\n\n# 4. Delta\n\nDelta body.\n\n# 5. Unlisted\n\nUnlisted body.");
    await rebuildChunksForDocument(classifiedDoc, String(wsA), { classify: createChunkClassifier(mapping), authorizedLevel: "restricted" });
    const cls = await KnowledgeChunk.find({ documentId: classifiedDoc }).sort({ chunkIndex: 1 }).lean();
    same("classification hook: only included sections are stored, with their reviewed visibility", cls.map((c) => [c.section, c.visibility]), [["1. Alpha", "guest"], ["2. Beta", "staff"]]);
    same("classification hook: chunk indexes stay contiguous after skipping held/excluded/unmapped chunks", cls.map((c) => c.chunkIndex), [0, 1]);
    check("classification hook: held, excluded, preamble and unmapped text is nowhere in the stored chunks", !cls.some((c) => /Gamma|Delta|Unlisted|Preamble/.test(c.text)));

    // embedding leaves visibility alone
    const emb = await http(admin, "POST", `/knowledge-documents/${classifiedDoc}/embeddings?${W}`);
    const afterEmbed = await KnowledgeChunk.find({ documentId: classifiedDoc }).sort({ chunkIndex: 1 }).lean();
    check("embedding succeeds and does not change any chunk's visibility", emb.status === 201 && afterEmbed.every((c, i) => c.visibility === cls[i].visibility && c.embeddingInputVersion === 1 && c.embedding?.length === 32));

    // validation
    const badCreate = await http(admin, "POST", "/knowledge-documents", { workspaceId: String(wsA), title: "bad", documentType: "sop", isTestData: true, content: "x", defaultVisibility: "public" });
    check("an invalid defaultVisibility is rejected on create (400)", badCreate.status === 400);
    const patchOk = await http(admin, "PATCH", `/knowledge-documents/${docDefault}?${W}`, { defaultVisibility: "guest" });
    const patchBad = await http(admin, "PATCH", `/knowledge-documents/${docDefault}?${W}`, { defaultVisibility: "everyone" });
    check("defaultVisibility can be updated to a valid value and rejects an invalid one", patchOk.status === 200 && patchOk.json.data.defaultVisibility === "guest" && patchBad.status === 400);
  }

  // ---------------------------------------- 7. Intelligence / provenance visibility
  {
    const mk = (summary, knowledgeVisibility, prov) => createGeneratedIntelligence({
      workspaceId: wsA, signalId, signal: { summary, type: "maintenance", severity: "low" },
      result: {
        summary, findings: [], risk: { level: "low", reason: "r" }, decision: { recommendation: "r", rationale: "r" },
        action: { label: "l", recommended: [] }, outcome: { expected: "e" }, confidence: 0.5, knowledgeProvenance: prov,
      },
      provider: "test", model: "m", knowledgeVisibility,
    });
    const provFor = (id, section) => [{ chunkId: id, knowledgeDocumentId: String(docMix), version: 1, scope: "workspace", section, chunkIndex: 0, similarityScore: 0.5, retrievalScore: 0.5 }];
    const iNone = await mk("SYNTH-I-NONE", undefined, undefined);
    const iGuest = await mk("SYNTH-I-GUEST", "guest", provFor("a", "GuestSection"));
    const iStaff = await mk("SYNTH-I-STAFF", "staff", provFor("b", "StaffSection"));
    const iRestr = await mk("SYNTH-I-RESTRICTED", "restricted", provFor("c", "RestrictedSection"));
    const listI = async (level) => http(bases[level], "GET", `/intelligence?${W}&limit=100`);
    const summaries = (res) => sorted(res.json.data.map((x) => x.intelligence?.summary).filter((x) => x && x.startsWith("SYNTH-I-")));
    same("intelligence list: guest sees only records with no or guest knowledge", summaries(await listI("guest")), ["SYNTH-I-GUEST", "SYNTH-I-NONE"]);
    same("intelligence list: staff also sees staff-derived records", summaries(await listI("staff")), ["SYNTH-I-GUEST", "SYNTH-I-NONE", "SYNTH-I-STAFF"]);
    same("intelligence list: restricted sees all", summaries(await listI("restricted")), ["SYNTH-I-GUEST", "SYNTH-I-NONE", "SYNTH-I-RESTRICTED", "SYNTH-I-STAFF"]);
    const lg = await listI("guest");
    check("intelligence list: guest response has no staff/restricted summary or section label", !["SYNTH-I-STAFF", "SYNTH-I-RESTRICTED", "StaffSection", "RestrictedSection"].some((m) => JSON.stringify(lg.json).includes(m)));
    check("intelligence list: pagination total matches what a guest can see", lg.json.pagination.total === lg.json.data.length);
    const byId = (level, rec) => http(bases[level], "GET", `/intelligence/${rec._id}?${W}`);
    check("intelligence by id: guest gets 404 for staff- and restricted-derived records", (await byId("guest", iStaff)).status === 404 && (await byId("guest", iRestr)).status === 404);
    check("intelligence by id: staff gets 404 for a restricted-derived record but 200 for staff", (await byId("staff", iRestr)).status === 404 && (await byId("staff", iStaff)).status === 200);
    check("intelligence by id: restricted reads everything, with provenance", (await byId("restricted", iRestr)).json?.data?.knowledgeProvenance?.[0]?.section === "RestrictedSection");
    check("intelligence by id: records that used no knowledge stay visible to a guest (existing behaviour unchanged)", (await byId("guest", iNone)).status === 200);
    check("a hidden record's 404 matches a missing record's 404", (await byId("guest", iStaff)).json.message === (await http(bases.guest, "GET", `/intelligence/000000000000000000000000?${W}`)).json.message);
    check("POST /intelligence cannot set knowledgeVisibility from a body", await (async () => {
      const res = await http(admin, "POST", "/intelligence", { workspaceId: String(wsA), knowledgeVisibility: "guest", knowledgeProvenance: provFor("z", "Forged") });
      return res.status === 201 && res.json.data.knowledgeVisibility === undefined && res.json.data.knowledgeProvenance === undefined;
    })());

    // real generation at each level: stored knowledgeVisibility follows what was retrieved
    // (Phase 13) HTTP generation needs intelligence:generate, which no guest-ceiling role holds, so the
    // level under test is exercised through the same service the route calls (analyzeSignal, the canonical Phase 24 path).
    process.env.LLM_PROVIDER = "test-python";
    const gen = async (level) => {
      try {
        return { status: 200, body: (await analyzeSignal(String(signalId), String(wsA), { authorizedLevel: level })).record };
      } catch (error) {
        return { status: error.statusCode ?? 500, body: undefined };
      }
    };
    const generatedIds = {};
    for (const level of ["guest", "staff", "restricted"]) {
      const { status, body } = await gen(level);
      generatedIds[level] = body?._id;
      const saved = body?._id ? await Intelligence.findById(body._id).lean() : null;
      const allowed = { guest: ["guest"], staff: ["guest", "staff"], restricted: ["guest", "staff", "restricted"] }[level];
      const usedTexts = (body?.knowledgeProvenance || []).map((p) => p.chunkId);
      const chunkLevels = (await KnowledgeChunk.find({ _id: { $in: usedTexts } }).lean()).map((c) => c.visibility);
      check(`generation at ${level}: succeeds`, status === 200, `status ${status}`);
      check(`generation at ${level}: stored knowledgeVisibility is the highest retrieved level`, saved?.knowledgeVisibility === level, `stored ${saved?.knowledgeVisibility}`);
      check(`generation at ${level}: provenance cites only chunks the caller may see`, chunkLevels.every((l) => allowed.includes(l)));
    }
    check("a record generated at restricted level is hidden from a guest reader and from a staff reader", !!generatedIds.restricted && (await byId("guest", { _id: generatedIds.restricted })).status === 404 && (await byId("staff", { _id: generatedIds.restricted })).status === 404);
    check("a record generated at staff level is visible to staff but not to a guest", !!generatedIds.staff && (await byId("staff", { _id: generatedIds.staff })).status === 200 && (await byId("guest", { _id: generatedIds.staff })).status === 404);
  }

  // ------------------------------------------ 8. service-level fail-closed defaults
  {
    process.env.AI_SERVICE_URL = PYTHON_BASE;
    const { retrieveKnowledgeForSignal } = await import("../src/services/knowledgeRetrievalService.js");
    for (const lvl of [undefined, null, "", "admin", "GUEST"]) {
      const out = await retrieveKnowledgeForSignal(String(signalId), String(wsA), lvl);
      check(`service default: level ${JSON.stringify(lvl)} retrieves guest chunks only`, out.results.length >= 2 && out.results.every((x) => x.visibility === "guest") && out.results.some((x) => x.text.includes(MARK.g1)), JSON.stringify(out.results.map((x) => [x.visibility, x.text.slice(0, 20)])));
    }
    const staffOut = await retrieveKnowledgeForSignal(String(signalId), String(wsA), "staff");
    check("service: an explicit staff level retrieves staff chunks", staffOut.results.some((x) => x.visibility === "staff") && !staffOut.results.some((x) => x.visibility === "restricted"));
  }

  // ------------------------------------------------ 9. Python's own defensive check
  {
    const res = await fetch(`${PYTHON_BASE}/v1/knowledge-retrieval`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queryText: "q", authorizedLevel: "guest",
        candidates: [{ chunkId: "a", embedding: vec(1), scope: "workspace", visibility: "guest", embeddingModel: "deterministic-embedding-v1" }, { chunkId: "b", embedding: vec(2), scope: "workspace", visibility: "restricted", embeddingModel: "deterministic-embedding-v1" }],
      }),
    });
    const json = await res.json();
    same("Python ignores a candidate above authorizedLevel even if Node had sent it", json.results.map((x) => x.chunkId), ["a"]);
  }

  // ------------------- 9b. the v2 profile through the REAL ingestion path (synthetic mirror)
  {
    // Section headings mirror the approved mapping (titles only); bodies are invented.
    // Section 7 is a parent with no body of its own, as in the real document.
    const HEADINGS = [
      ["# 1. Property Master", 1], ["# 2. Property Structure & Inventory", 1], ["# 3. Facilities & Accommodation Model", 1],
      ["# 4. Current Rate Card & Occupancy-Based 3BHK Tariff", 1], ["# 5. Laundry", 1], ["# 6. Standard Stay Timings & Add-on Charges", 1],
      ["# 7. Booking & Check-in/Check-out Operations", 0], ["## 7.1 Booking", 1], ["## 7.2 Check-in", 1], ["## 7.3 Check-out & Post Check-out", 1],
      ["# 8. Early Check-in / Late Checkout", 1], ["# 9. Booking Modification & Extension", 1], ["# 10. Cancellation & Refund", 1],
      ["# 11. Guest Rules", 1], ["# 12. Food & Beverage", 1], ["# 13. Housekeeping", 1], ["# 14. Guest Complaints", 1], ["# 15. Maintenance", 1],
      ["# 16. Service Recovery / Compensation", 1], ["# 17. Damage / Missing Items / Lost Key", 1], ["# 18. Payment / Billing Disputes", 1],
      ["# 19. Staff Roles & Escalation — Staff Knowledge", 1], ["# 20. Daily Operational Pattern — Staff Knowledge", 1],
      ["# 21. Current Data / Knowledge Boundaries", 1], ["# 22. Emergency Procedures — PROVISIONAL / HOLD", 1],
      ["# 23. Restricted Information — Not for Guest RAG", 1], ["# 24. Excluded From Business Knowledge Corpus", 1],
      ["# 25. A Brand New Unreviewed Section", 1],
    ];
    const V2_SYNTH = `SYNTHETIC TITLE BLOCK\n\n${HEADINGS.map(([h, body]) => (body ? `${h}\n\nInvented body for ${h.replace(/^#+\s*/, "")}.\n` : `${h}\n`)).join("\n")}`;
    const EXPECT_GUEST = ["1.", "2.", "3.", "4.", "5.", "6.", "10.", "11."];
    const EXPECT_STAFF = ["7.1", "7.2", "7.3", "8.", "9.", "12.", "13.", "14.", "15.", "16.", "17.", "18.", "19.", "20."];
    const WITHHELD = ["21.", "22.", "23.", "24.", "25.", "SYNTHETIC TITLE"];
    const prop = (await http(admin, "POST", "/properties", { workspaceId: String(wsA), name: "Synthetic Property", code: `SP${stamp}` })).json?.data?._id;
    const post = (body) => http(admin, "POST", "/knowledge-documents", { workspaceId: String(wsA), documentType: "sop", isTestData: true, ...body });
    const rebuild = (id, ws = wsA) => http(admin, "POST", `/knowledge-documents/${id}/chunks?workspaceId=${ws}`);

    // --- the profile is selected from the document's explicit identity, with no classifier passed by the caller
    const v2 = await post({ title: "Synthetic v2 mirror", content: V2_SYNTH, corpusProfile: "kolam-gandhi-v2", propertyId: prop });
    check("profile doc: created; corpusProfile recorded and default visibility taken from the profile", v2.status === 201 && v2.json.data.corpusProfile === "kolam-gandhi-v2" && v2.json.data.defaultVisibility === "staff", JSON.stringify(v2.json));
    const v2Id = v2.json.data._id;
    const built = await rebuild(v2Id);
    const stored = await KnowledgeChunk.find({ documentId: v2Id }).sort({ chunkIndex: 1 }).lean();
    const has = (section, prefixes) => prefixes.some((p) => section.startsWith(p));
    check("the real rebuild path applied the v2 mapping automatically (22 stored, 8 guest, 14 staff, 0 restricted)",
      built.status === 201 && stored.length === 22 && stored.filter((c) => c.visibility === "guest").length === 8 && stored.filter((c) => c.visibility === "staff").length === 14 && !stored.some((c) => c.visibility === "restricted"),
      `stored=${stored.length} ${JSON.stringify(stored.map((c) => c.visibility))}`);
    check("included sections received exactly their approved visibility",
      stored.every((c) => (has(c.section, EXPECT_GUEST) ? c.visibility === "guest" : has(c.section, EXPECT_STAFF) ? c.visibility === "staff" : false)), JSON.stringify(stored.map((c) => [c.section, c.visibility])));
    check("sections 8 and 12 (mixed) are staff", ["8.", "12."].every((n) => stored.find((c) => c.section.startsWith(n))?.visibility === "staff"));
    check("excluded and held sections (21, 22, 23, 24, title block) are not stored", !stored.some((c) => has(c.section, WITHHELD)) && !stored.some((c) => /Invented body for (21|22|23|24)\./.test(c.text)));
    check("an unknown section (25) fails closed: it is not stored at any visibility", !stored.some((c) => c.section.startsWith("25.")));
    same("chunk indexes stay contiguous after removals", stored.map((c) => c.chunkIndex), Array.from({ length: 22 }, (_, i) => i));
    check("the rebuild response reports what was stored and withheld", built.json.data.classification?.stored === 22 && built.json.data.classification?.withheld === 6 && built.json.data.classification?.profile === "kolam-gandhi-v2", JSON.stringify(built.json.data.classification));
    check("sectionPath is unchanged (children keep their parent, e.g. 7.1)", JSON.stringify(stored.find((c) => c.section === "7.1 Booking")?.sectionPath) === JSON.stringify(["7. Booking & Check-in/Check-out Operations", "7.1 Booking"]));
    check("existing scoping is unchanged: every chunk carries the document's workspace, property, status and version",
      stored.every((c) => String(c.workspaceId) === String(wsA) && String(c.propertyId) === String(prop) && c.status === "active" && c.version === 1 && !c.unitId));
    check("rebuilding is idempotent (same 22 chunks, same visibilities)", await (async () => { await rebuild(v2Id); const again = await KnowledgeChunk.find({ documentId: v2Id }).sort({ chunkIndex: 1 }).lean(); return again.length === 22 && again.every((c, i) => c.visibility === stored[i].visibility && c.section === stored[i].section); })());
    check("cross-workspace rebuild of a profile document is still a 404 and stores nothing new", (await rebuild(v2Id, wsB)).status === 404);

    // --- visibility never enters the embedding text; embedding path unchanged
    const emb = await http(admin, "POST", `/knowledge-documents/${v2Id}/embeddings?workspaceId=${wsA}`);
    const embedded = await KnowledgeChunk.find({ documentId: v2Id }).sort({ chunkIndex: 1 }).lean();
    const sample = embedded.find((c) => c.section === "1. Property Master");
    const direct = async (t) => (await (await fetch(`${PYTHON_BASE}/v1/embeddings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ texts: [t] }) })).json()).embeddings[0];
    const { buildEmbeddingText } = await import("../src/services/knowledge/embeddingText.js");
    const contextual = buildEmbeddingText(sample);
    check("embedding succeeds for the 22 stored chunks with embeddingInputVersion 1", emb.status === 201 && embedded.length === 22 && embedded.every((c) => c.embeddingInputVersion === 1 && c.embedding?.length === 32));
    check("the stored vector is the embedding of sectionPath + text only", JSON.stringify(sample.embedding) === JSON.stringify(await direct(contextual)));
    check("...and NOT of text carrying its visibility", JSON.stringify(sample.embedding) !== JSON.stringify(await direct(`${sample.visibility}\n${contextual}`)) && !/guest|staff|restricted/i.test(contextual.replace(sample.text, "")));
    check("embedding left every chunk's visibility as classified", embedded.every((c, i) => c.visibility === stored[i].visibility));

    // --- the raw source text of a PROFILED document is never returned, at any level
    {
      const RAW = /Invented body for|SYNTHETIC TITLE BLOCK/;
      const V2_HASH = (await KnowledgeDocument.findById(v2Id).lean()).contentHash;
      const dbBefore = await KnowledgeDocument.findById(v2Id).lean();
      const read = async (level) => http(bases[level], "GET", `/knowledge-documents/${v2Id}?${W}`);
      const guestRead = await read("guest");
      const staffRead = await read("staff");
      const restrictedRead = await read("restricted");
      check("profiled doc: guest cannot read it at all (404), so no content", guestRead.status === 404 && !RAW.test(JSON.stringify(guestRead.json)));
      for (const [level, res] of [["staff", staffRead], ["restricted", restrictedRead]]) {
        check(`profiled doc: ${level} gets 200 with content omitted and contentRedacted: true`, res.status === 200 && res.json.data.content === undefined && res.json.data.contentRedacted === true, JSON.stringify(res.json?.data && Object.keys(res.json.data)));
        check(`profiled doc: ${level} response contains none of the source text (held/excluded/title material)`, !RAW.test(JSON.stringify(res.json)) && !/PROVISIONAL|Excluded From Business Knowledge/.test(JSON.stringify(res.json.data.content ?? "")));
        check(`profiled doc: ${level} still gets its metadata`, res.json.data.title === "Synthetic v2 mirror" && res.json.data.corpusProfile === "kolam-gandhi-v2" && res.json.data.defaultVisibility === "staff" && res.json.data.version === 1 && String(res.json.data.workspaceId) === String(wsA) && res.json.data.contentHash === V2_HASH && res.json.data.ingestionStatus === "ready" && res.json.data._id === String(v2Id));
      }
      for (const level of ["staff", "restricted"]) {
        const list = await http(bases[level], "GET", `/knowledge-documents?${W}&limit=100`);
        const item = list.json.data.find((d) => d._id === String(v2Id));
        check(`profiled doc: the ${level} list shows it with metadata but no content`, !!item && item.content === undefined && item.contentRedacted === true && item.title === "Synthetic v2 mirror" && !RAW.test(JSON.stringify(item)));
      }
      const patched = await http(admin, "PATCH", `/knowledge-documents/${v2Id}?${W}`, { title: "Synthetic v2 mirror" });
      check("profiled doc: the PATCH response is redacted too (even at restricted)", patched.status === 200 && patched.json.data.content === undefined && patched.json.data.contentRedacted === true);
      check("profiled doc: the create response was redacted too", v2.json.data.content === undefined && v2.json.data.contentRedacted === true);
      const doomed = await post({ title: "Synthetic doomed profiled doc", content: V2_SYNTH, corpusProfile: "kolam-gandhi-v2" });
      const deleted = await http(admin, "DELETE", `/knowledge-documents/${doomed.json.data._id}?${W}`);
      check("profiled doc: the DELETE response (which echoes the document) is redacted at every level", deleted.status === 200 && deleted.json.data.content === undefined && deleted.json.data.contentRedacted === true && !RAW.test(JSON.stringify(deleted.json)));

      // stored source is untouched
      const dbAfter = await KnowledgeDocument.findById(v2Id).lean();
      check("the stored MongoDB content is NOT deleted or altered: full source text still present, identical hash", dbAfter.content === V2_SYNTH && dbAfter.content === dbBefore.content && dbAfter.contentHash === V2_HASH && /Invented body for 22\./.test(dbAfter.content) && /Invented body for 24\./.test(dbAfter.content));

      // approved chunks stay readable through the chunk endpoints, by visibility
      const chunksAt = async (level) => http(bases[level], "GET", `/knowledge-documents/${v2Id}/chunks?${W}&limit=100`);
      const cGuest = await chunksAt("guest");
      const cStaff = await chunksAt("staff");
      const cRestricted = await chunksAt("restricted");
      check("profiled doc chunks: guest is refused (the document's default is staff), exactly as before", cGuest.status === 404);
      check("profiled doc chunks: staff sees all 22 approved chunks (8 guest + 14 staff), none withheld", cStaff.status === 200 && cStaff.json.data.length === 22 && cStaff.json.data.filter((c) => c.visibility === "guest").length === 8 && !cStaff.json.data.some((c) => WITHHELD.some((w) => c.section.startsWith(w))));
      check("profiled doc chunks: restricted sees the same 22", cRestricted.status === 200 && cRestricted.json.data.length === 22);
      check("chunks still expose their own text to a level that may see them (chunk visibility rule unchanged)", cStaff.json.data.every((c) => typeof c.text === "string" && c.text.length > 0) && !cStaff.json.data.some((c) => /Invented body for (21|22|23|24|25)\./.test(c.text)));
      const guestRetrieval = { json: { data: await retrieveKnowledgeForSignal(String(signalId), String(wsA), "guest") } };
      const fromV2 = guestRetrieval.json.data.results.filter((r) => r.knowledgeDocumentId === String(v2Id));
      check("retrieval still serves this document's guest chunks to a guest, and never its staff chunks", fromV2.every((r) => r.visibility === "guest") && guestRetrieval.json.data.results.every((r) => r.visibility === "guest"));
      check("tenant isolation: another workspace still cannot read the profiled document, its list entry, or its chunks", (await http(admin, "GET", `/knowledge-documents/${v2Id}?workspaceId=${wsB}`)).status === 404
        && !(await http(admin, "GET", `/knowledge-documents?workspaceId=${wsB}&limit=100`)).json.data.some((d) => d._id === String(v2Id))
        && (await http(admin, "GET", `/knowledge-documents/${v2Id}/chunks?workspaceId=${wsB}`)).status === 404);
    }

    // --- unrelated documents never get the Kolam mapping
    const lookalike = await post({ title: "Synthetic v2 mirror", sourceFilename: "Kolam_Gandhi_SOP_v2_Business_Knowledge.docx", content: V2_SYNTH });
    const lookId = lookalike.json.data._id;
    const lookBuilt = await rebuild(lookId);
    const lookStored = await KnowledgeChunk.find({ documentId: lookId }).sort({ chunkIndex: 1 }).lean();
    check("a lookalike (same title and filename, NO corpusProfile) does not use the mapping: nothing is withheld, no classification is reported",
      lookStored.length === 28 && lookStored.some((c) => c.section.startsWith("22.")), `stored ${lookStored.length}`);
    check("...it stores the excluded/held/unknown sections too, all at the document's default (staff), none guest", lookStored.some((c) => c.section.startsWith("21.")) && lookStored.some((c) => c.section.startsWith("25.")) && lookStored.every((c) => c.visibility === "staff"));
    check("...and its rebuild response carries no classification block", lookBuilt.json.data.classification === undefined);
    const guestDoc = await post({ title: "Unrelated guest-default doc", content: V2_SYNTH, defaultVisibility: "guest" });
    await rebuild(guestDoc.json.data._id);
    check("an unrelated document's visibility comes only from its own default (guest here), never from the Kolam mapping", (await KnowledgeChunk.find({ documentId: guestDoc.json.data._id }).lean()).every((c) => c.visibility === "guest"));

    // --- unprofiled documents keep their existing content behaviour
    {
      const asAdmin = await http(admin, "GET", `/knowledge-documents/${lookId}?${W}`);
      const asStaff = await http(bases.staff, "GET", `/knowledge-documents/${lookId}?${W}`);
      const asGuest = await http(bases.guest, "GET", `/knowledge-documents/${lookId}?${W}`);
      check("unprofiled doc (default staff): restricted and staff still receive the full content", asAdmin.status === 200 && asAdmin.json.data.content === V2_SYNTH && asStaff.status === 200 && asStaff.json.data.content === V2_SYNTH && asStaff.json.data.contentRedacted === undefined);
      check("unprofiled doc (default staff): a guest is still refused (404)", asGuest.status === 404);
      const asGuestOfGuestDoc = await http(bases.guest, "GET", `/knowledge-documents/${guestDoc.json.data._id}?${W}`);
      check("unprofiled doc (default guest, all-guest chunks): a guest still receives the full content", asGuestOfGuestDoc.status === 200 && asGuestOfGuestDoc.json.data.content === V2_SYNTH);
      const unprofiledList = await http(bases.staff, "GET", `/knowledge-documents?${W}&limit=100`);
      check("unprofiled docs in the list still carry content for a level that may see them", unprofiledList.json.data.filter((d) => d._id === String(lookId)).every((d) => d.content === V2_SYNTH));
    }

    // --- profile validation and immutability
    check("an unregistered corpusProfile is rejected on create (400)", (await post({ title: "x", content: "y", corpusProfile: "nope" })).status === 400);
    check("a prototype-key corpusProfile is rejected too", (await post({ title: "x", content: "y", corpusProfile: "constructor" })).status === 400);
    check("a defaultVisibility that contradicts the profile is rejected (400)", (await post({ title: "x", content: "y", corpusProfile: "kolam-gandhi-v2", defaultVisibility: "guest" })).status === 400);
    check("stating the profile's own default explicitly is accepted", (await post({ title: "x2", content: "y2", corpusProfile: "kolam-gandhi-v2", defaultVisibility: "staff" })).status === 201);
    check("corpusProfile cannot be changed by PATCH (400) and stays as it was", (await http(admin, "PATCH", `/knowledge-documents/${v2Id}?${W}`, { corpusProfile: "kolam-gandhi-v2" })).status === 400 && (await KnowledgeDocument.findById(v2Id).lean()).corpusProfile === "kolam-gandhi-v2");
    // a stored profile id that is no longer registered stops the rebuild instead of chunking without it
    await KnowledgeDocument.updateOne({ _id: v2Id }, { $set: { corpusProfile: "retired-profile" } });
    const beforeRetired = await KnowledgeChunk.countDocuments({ documentId: v2Id });
    const retired = await rebuild(v2Id);
    check("an unregistered stored profile refuses to rebuild (error) and leaves existing chunks untouched", retired.status === 500 && (await KnowledgeChunk.countDocuments({ documentId: v2Id })) === beforeRetired, `status ${retired.status}`);

    // --- the production upload endpoint (extract -> create -> rebuild -> embed), profile passed as a form field
    const upload = async (fields, name) => {
      const form = new FormData();
      form.append("file", new Blob([V2_SYNTH], { type: "text/markdown" }), name);
      for (const [k, v] of Object.entries({ workspaceId: String(wsA), documentType: "sop", isTestData: "true", ...fields })) form.append(k, v);
      const res = await fetch(`${admin}/knowledge-documents/upload`, { method: "POST", body: form });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const up = await upload({ title: "Synthetic upload mirror", corpusProfile: "kolam-gandhi-v2" }, "synthetic-v2-mirror.md");
    const upStored = up.json?.data?._id ? await KnowledgeChunk.find({ documentId: up.json.data._id }).sort({ chunkIndex: 1 }).lean() : [];
    const upDoc = up.json?.data?._id ? await KnowledgeDocument.findById(up.json.data._id).lean() : null;
    check("upload endpoint: 201, classified automatically (22 stored: 8 guest, 14 staff)", up.status === 201 && upStored.length === 22 && upStored.filter((c) => c.visibility === "guest").length === 8 && upStored.filter((c) => c.visibility === "staff").length === 14, `status ${up.status} stored ${upStored.length} ${JSON.stringify(up.json?.message)}`);
    check("upload endpoint: the response for a profiled upload carries no source text", up.json?.data?.content === undefined && up.json?.data?.contentRedacted === true && !/Invented body for/.test(JSON.stringify(up.json)));
    check("upload endpoint: the profiled upload's full source text (incl. held/excluded sections) is still stored in MongoDB", await (async () => { const c = (await KnowledgeDocument.findById(up.json.data._id).lean()).content; return /Invented body for 22\./.test(c) && /Invented body for 24\./.test(c) && /SYNTHETIC TITLE BLOCK/.test(c); })());
    check("upload endpoint: withheld sections absent, indexes contiguous, embedded at version 1, ingestion ready",
      !upStored.some((c) => has(c.section, WITHHELD)) && JSON.stringify(upStored.map((c) => c.chunkIndex)) === JSON.stringify(Array.from({ length: 22 }, (_, i) => i)) && upStored.every((c) => c.embeddingInputVersion === 1 && c.embedding?.length === 32) && upDoc?.ingestionStatus === "ready");
    const upPlain = await upload({ title: "Synthetic upload no profile" }, "some-other-document.md");
    const upPlainStored = upPlain.json?.data?._id ? await KnowledgeChunk.find({ documentId: upPlain.json.data._id }).lean() : [];
    check("upload endpoint: the same content WITHOUT a profile is not classified (all staff by default, nothing withheld)", upPlain.status === 201 && upPlainStored.length > 22 && upPlainStored.every((c) => c.visibility === "staff"), `status ${upPlain.status} stored ${upPlainStored.length}`);
    check("upload endpoint: an unregistered profile is rejected (400) and creates nothing", await (async () => {
      const before = await KnowledgeDocument.countDocuments({ workspaceId: wsA });
      const res = await upload({ title: "Synthetic bad profile", corpusProfile: "nope" }, "bad.md");
      return res.status === 400 && (await KnowledgeDocument.countDocuments({ workspaceId: wsA })) === before;
    })());
  }

  // ------------------------------------------------------- 10. operational data untouched
  const after = await fingerprint();
  same("operational Guest/Stay/ImportBatch records are unchanged by this suite", after, before);
}

let exitCode = 1;
try {
  await main();
  exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  fail("suite crashed", error?.stack || String(error));
} finally {
  for (const child of servers) child.kill();
  try { await cleanup(); } catch (error) { console.error("cleanup failed:", error?.message); }
  await disconnectDatabase();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(exitCode);
}
