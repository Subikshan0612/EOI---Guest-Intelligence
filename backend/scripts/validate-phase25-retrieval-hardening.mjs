/**
 * Phase 25 validation: retrieval hardening.
 *
 *   A  candidate selection: workspace + visibility filtering, deterministic order, PAGING (no silent 200 cap), ceiling fails closed
 *   B  similarity: cosine correctness on constructed vectors, accepted / rejected / exact boundary, deterministic ties
 *   C  relevance floor: below excluded, above included, all-below -> "no relevant knowledge", weak chunk never reaches the model
 *   D  top-K: only K survive, stable order, duplicates
 *   E  embedding compatibility: other model / other dimension / unlabeled are never compared; nothing comparable fails closed
 *   F  isolation: foreign-workspace and forbidden-visibility chunks never reach the model, however similar; forged controls ignored
 *   G  PII: guest e-mail / phone / name never enter the retrieval query or any model request
 *   H  LLM boundary: the EXACT model request holds only the final top-K evidence, with no vectors or model labels
 *   I  empty retrieval: explicit, safe, nothing fabricated
 *   J  no operational record is modified; no foreign workspace is touched; the database returns to its baseline
 *
 * SELF-CONTAINED AND PROVIDER-SAFE: this suite starts its OWN ai-service on a private port with LLM_PROVIDER=test,
 * EMBEDDING_PROVIDER=test and an EMPTY key forced in the process environment (which wins over any .env), puts a recording proxy in
 * front of it, and starts its own backends with NODE_ENV=test (which refuses a non-loopback AI_SERVICE_URL - checked below).
 * It never talks to any other ai-service. All fixtures live in throwaway workspaces and are removed by id.
 *
 * NOTE on similarity values: the test embedder is hash-based, so text similarity means nothing. Chunk vectors here are CONSTRUCTED
 * with exact target cosines relative to the query's own test embedding; the suite proves pipeline behavior, not semantic quality.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import * as Models from "../src/models/index.js";
import { Guest, Intelligence, KnowledgeChunk, KnowledgeDocument, Property, Signal, Stay, Unit, Workspace } from "../src/models/index.js";
import { DEFAULT_RETRIEVAL_MIN_SIMILARITY, getRetrievalMinSimilarity } from "../src/config/runtimeConfig.js";
import { MAX_ELIGIBLE_CANDIDATES, TOP_K, buildRetrievalQueryText, selectRelevantResults, verifyAndBuildResults } from "../src/services/knowledgeRetrievalService.js";
import { cleanupAuthFixtures, createActor } from "./lib/authFixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(__dirname, "..");
const AI_DIR = path.join(BACKEND, "..", "ai-service");
const PYTHON = process.platform === "win32" ? path.join(AI_DIR, ".venv", "Scripts", "python.exe") : path.join(AI_DIR, ".venv", "bin", "python");
const AI_PORT = 5992;
const PROXY_PORT = 5991;
const PORTS = { main: 5993, boundaryEq: 5994, boundaryUp: 5995, external: 5996 };
const TEST_MODEL = "deterministic-embedding-v1";

let passed = 0;
let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
};

const M = {
  email: "TEST_GUEST_EMAIL_123@example.invalid",
  phone: "TEST_GUEST_PHONE_456",
  first: "TESTGUESTFIRSTNAME",
  last: "TESTGUESTLASTNAME",
  foreign: "P25-FOREIGN-CHUNK-MARKER",
  restricted: "P25-RESTRICTED-CHUNK-MARKER",
  weak: "P25-WEAK-CHUNK-MARKER",
};

const ids = { workspaces: [] };
const recorded = [];
const children = [];
let proxyServer;

// ------------------------------------------------------------------ vector helpers
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const norm = (a) => Math.sqrt(dot(a, a));
const cosine = (a, b) => dot(a, b) / (norm(a) * norm(b));
const unit = (a) => a.map((x) => x / norm(a));
/** A vector with cosine exactly `c` (to double precision) against the unit vector q. */
function atCosine(q, c, k = 0) {
  const e = q.map((_, i) => (i === k ? 1 : 0));
  const proj = dot(e, q);
  const u = unit(e.map((x, i) => x - proj * q[i]));
  return q.map((x, i) => c * x + Math.sqrt(1 - c * c) * u[i]);
}

// ------------------------------------------------------------------ infrastructure
function startProxy() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      let parsed = null;
      try {
        parsed = JSON.parse(body.toString() || "null");
      } catch {
        parsed = null;
      }
      const entry = { url: req.url, body: parsed, text: body.toString(), response: null, status: 0 };
      recorded.push(entry);
      try {
        const upstream = await fetch(`http://127.0.0.1:${AI_PORT}${req.url}`, { method: req.method, headers: { "content-type": "application/json" }, body: body.length ? body : undefined });
        const text = await upstream.text();
        entry.status = upstream.status;
        try {
          entry.response = JSON.parse(text);
        } catch {
          entry.response = null;
        }
        res.writeHead(upstream.status, { "content-type": "application/json" });
        res.end(text);
      } catch {
        res.writeHead(502);
        res.end("{}");
      }
    });
  });
  return new Promise((resolve) => server.listen(PROXY_PORT, "127.0.0.1", () => resolve(server)));
}

async function waitFor(url, ms = 30000) {
  const start = Date.now();
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not ready
    }
    if (Date.now() - start > ms) throw new Error(`not healthy: ${url}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function startBackend(port, minSimilarity) {
  const env = { ...process.env, PORT: String(port), NODE_ENV: "test", LLM_PROVIDER: "test-python", AI_SERVICE_URL: `http://localhost:${PROXY_PORT}`, KOI_RATE_LIMIT_ENABLED: "false", KNOWLEDGE_DEV_AUTHORIZED_LEVEL: "restricted" };
  delete env.KOI_RETRIEVAL_MIN_SIMILARITY; // the harness default (-1) must NOT leak into this suite: unset = the production default
  if (minSimilarity !== undefined) env.KOI_RETRIEVAL_MIN_SIMILARITY = String(minSimilarity);
  const child = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env, stdio: "ignore" });
  children.push(child);
  return child;
}

const api = (port) => `http://localhost:${port}/api`;
async function call(port, actor, method, url, { headers = {}, body } = {}) {
  const init = { method, headers: { ...actor.headers, ...headers } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${api(port)}${url}`, init);
  const raw = await response.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  return { status: response.status, json, raw, data: json?.data, message: json?.message };
}

const TRACKED = ["User", "WorkspaceMembership", "Workspace", "Property", "Unit", "Guest", "Stay", "Signal", "Intelligence", "Decision", "Action", "Outcome", "KnowledgeDocument", "KnowledgeChunk", "ImportBatch", "Conversation", "Message"];
const counts = async () => Object.fromEntries(await Promise.all(TRACKED.map(async (name) => [name, await Models[name].countDocuments({})])));
const stable = (v) => JSON.stringify(v);
const hashRows = (rows) => `${rows.length}:${crypto.createHash("sha256").update(rows.map((r) => `${r._id}:${r.updatedAt?.getTime?.() ?? ""}`).join("|")).digest("hex").slice(0, 16)}`;

async function cleanup() {
  await connectDatabase();
  await cleanupAuthFixtures();
  const ws = { $in: ids.workspaces };
  const props = (await Property.find({ workspaceId: ws }, { _id: 1 }).lean()).map((p) => p._id);
  await Intelligence.deleteMany({ workspaceId: ws });
  await KnowledgeChunk.deleteMany({ workspaceId: ws });
  await KnowledgeDocument.deleteMany({ workspaceId: ws });
  await Signal.deleteMany({ workspaceId: ws });
  await Stay.deleteMany({ workspaceId: ws });
  await Guest.deleteMany({ workspaceId: ws });
  await Unit.deleteMany({ propertyId: { $in: props } });
  await Property.deleteMany({ workspaceId: ws });
  await Models.WorkspaceMembership.deleteMany({ workspaceId: ws });
  await Workspace.deleteMany({ _id: ws });
  await disconnectDatabase();
}

// ------------------------------------------------------------------ pure unit checks (no server)
function unitChecks() {
  const min = (raw) => {
    const before = process.env.KOI_RETRIEVAL_MIN_SIMILARITY;
    if (raw === undefined) delete process.env.KOI_RETRIEVAL_MIN_SIMILARITY;
    else process.env.KOI_RETRIEVAL_MIN_SIMILARITY = raw;
    const value = getRetrievalMinSimilarity();
    if (before === undefined) delete process.env.KOI_RETRIEVAL_MIN_SIMILARITY;
    else process.env.KOI_RETRIEVAL_MIN_SIMILARITY = before;
    return value;
  };
  check("C config: the provisional default is 0.25 when unset, blank, non-numeric or out of range (a typo never disables the floor)", DEFAULT_RETRIEVAL_MIN_SIMILARITY === 0.25 && [undefined, "", "  ", "abc", "2", "-1.5", "NaN", "Infinity"].every((raw) => min(raw) === 0.25));
  check("C config: a deliberate in-range value is honoured (0.4, 0, -1)", min("0.4") === 0.4 && min("0") === 0 && min("-1") === -1);
  check("D constants: top-K is 5 and the eligible-candidate ceiling is 2000", TOP_K === 5 && MAX_ELIGIBLE_CANDIDATES === 2000);

  const r = (chunkId, similarityScore, scope = "workspace", boost = 1) => ({ chunkId, scope, similarityScore, retrievalScore: similarityScore * boost });
  const pick = (list, opts) => selectRelevantResults(list, { topK: 5, ...opts });
  const list = [r("a", 0.9), r("b", 0.25), r("c", 0.2499999999), r("d", 0.7), r("e", 0.7), r("f", -0.3), r("g", Number.NaN)];
  const out = pick(list, { minSimilarity: 0.25 });
  check("B/C floor: similarity >= threshold is kept (boundary INCLUSIVE), just below is rejected, negative and NaN are rejected", stable(out.selected.map((x) => x.chunkId)) === stable(["a", "d", "e", "b"]) && out.belowThreshold === 3);
  check("B ties: equal scores are ordered by chunk id ascending", stable(out.selected.filter((x) => x.similarityScore === 0.7).map((x) => x.chunkId)) === stable(["d", "e"]));
  const shuffles = Array.from({ length: 30 }, (_, i) => [...list].sort((x, y) => ((x.chunkId.charCodeAt(0) * (i + 7)) % 11) - ((y.chunkId.charCodeAt(0) * (i + 7)) % 11)));
  check("B/D determinism: the selection does not depend on the input order (30 permutations)", shuffles.every((s) => stable(pick(s, { minSimilarity: 0.25 }).selected.map((x) => x.chunkId)) === stable(out.selected.map((x) => x.chunkId))));
  const many = Array.from({ length: 12 }, (_, i) => r(`k${String(i).padStart(2, "0")}`, 0.5 + i * 0.01));
  check("D top-K: only the K most similar survive, best first", stable(pick(many, { minSimilarity: 0 }).selected.map((x) => x.chunkId)) === stable(["k11", "k10", "k09", "k08", "k07"]));
  check("D duplicates: a repeated chunk id is used once", pick([r("x", 0.9), r("x", 0.9), r("y", 0.8)], { minSimilarity: 0 }).selected.length === 2);
  check("D duplicates: identical TEXT under different chunk ids is NOT collapsed (distinct scope-labelled evidence)", pick([r("u", 0.9, "unit"), r("w", 0.9, "workspace")], { minSimilarity: 0 }).selected.length === 2);
  check("C floor is applied to the RAW cosine, not the scope-boosted score", pick([r("boosted", 0.2, "unit", 1.15)], { minSimilarity: 0.22 }).selected.length === 0);
  check("C nothing above the floor -> an empty selection (no fabricated evidence)", pick([r("p", 0.1), r("q", -0.2)], { minSimilarity: 0.25 }).selected.length === 0);

  const chunkOf = (id, model) => ({ _id: id, documentId: "d", version: 1, section: "s", sectionPath: [], visibility: "staff", chunkIndex: 0, text: "t", embeddingModel: model });
  const eligible = new Map([["m", chunkOf("m", "model-a")], ["n", chunkOf("n", "model-b")]]);
  const python = [{ chunkId: "m", scope: "workspace", similarityScore: 0.5, retrievalScore: 0.5 }, { chunkId: "n", scope: "workspace", similarityScore: 0.5, retrievalScore: 0.5 }, { chunkId: "zz", scope: "workspace", similarityScore: 0.9, retrievalScore: 0.9 }];
  check("E Node re-check: a result whose chunk was embedded by another model than the query's is dropped; an unknown chunk id is dropped", stable(verifyAndBuildResults(python, eligible, { queryModel: "model-a" }).map((x) => x.chunkId)) === stable(["m"]));
  check("E without a query model the legacy behavior is unchanged (unknown ids dropped only)", verifyAndBuildResults(python, eligible).length === 2);

  const context = { signal: { type: "maintenance", title: "AC down", description: "Warm air", guestId: "g", stayId: "s" }, guest: { firstName: M.first, lastName: M.last, email: M.email, phone: M.phone }, stay: { reservationId: "RSV-1" }, unit: { unitNumber: "301" }, property: { name: "Kolam" } };
  const query = buildRetrievalQueryText(context);
  check("G the retrieval query is built ONLY from the Signal's type, title and description", query === "maintenance. AC down. Warm air");
  check("G ...so no guest e-mail / phone / name marker (nor reservation, unit or property text) can enter it", ![M.email, M.phone, M.first, M.last, "RSV-1", "301", "Kolam"].some((v) => query.includes(v)));
}

// ------------------------------------------------------------------ main
async function main() {
  // provider safety: this suite's OWN ai-service, providers forced through the process environment
  const ai = spawn(PYTHON, ["-m", "uvicorn", "app.main:app", "--port", String(AI_PORT), "--host", "127.0.0.1"], { cwd: AI_DIR, env: { ...process.env, LLM_PROVIDER: "test", EMBEDDING_PROVIDER: "test", GEMINI_API_KEY: "" }, stdio: "ignore" });
  children.push(ai);
  await waitFor(`http://127.0.0.1:${AI_PORT}/v1/health`);
  proxyServer = await startProxy();
  const probe = await fetch(`http://127.0.0.1:${AI_PORT}/v1/embeddings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ texts: ["p25 provider probe"] }) }).then((r) => r.json());
  check("provider safety: this suite's ai-service embeds with the deterministic TEST model (forced test providers, empty key)", probe.model === TEST_MODEL && probe.embeddings[0].length === 32);
  const embed = async (text) => (await fetch(`http://127.0.0.1:${AI_PORT}/v1/embeddings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ texts: [text] }) }).then((r) => r.json())).embeddings[0];

  // NODE_ENV=test refuses a non-loopback AI service: a server pointed at one must not start
  const external = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, PORT: String(PORTS.external), NODE_ENV: "test", LLM_PROVIDER: "test-python", AI_SERVICE_URL: "https://ai.example.invalid" }, stdio: "ignore" });
  const externalExit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("still-running"), 20000);
    external.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (externalExit === "still-running") external.kill();
  check("provider safety: a backend configured with a NON-loopback AI service refuses to start under NODE_ENV=test", externalExit !== "still-running" && externalExit !== 0, `exit ${externalExit}`);

  unitChecks();

  await connectDatabase();
  const before = await counts();
  const stamp = Date.now();

  // ---------------------------------------------------------------- fixtures
  const mkWs = async (label) => {
    const w = await Workspace.create({ name: `P25 ${label} ${stamp}`, slug: `p25-${label}-${stamp}` });
    ids.workspaces.push(w._id);
    const prop = await Property.create({ workspaceId: w._id, name: `P25 Property ${label} ${stamp}`, code: `P25${label.toUpperCase()}${stamp}` });
    const unitDoc = await Unit.create({ propertyId: prop._id, unitNumber: `P25-${label}` });
    const operator = await createActor({ role: "operator", workspaceId: w._id, label: `p25-op-${label}` });
    const admin = await createActor({ role: "admin", workspaceId: w._id, label: `p25-adm-${label}` });
    return { ws: w, prop, unit: unitDoc, operator, admin, A: String(w._id) };
  };
  const mkDoc = async (w, title) => {
    const d = await KnowledgeDocument.create({ workspaceId: w.ws._id, title: `P25 ${title} ${stamp}`, documentType: "sop", content: "placeholder", contentHash: `p25-${crypto.randomBytes(6).toString("hex")}`, isTestData: true, defaultVisibility: "staff", sourceType: "manual-entry" });
    return d;
  };
  let chunkCounter = 0;
  const chunkDoc = (w, doc, o) => ({ documentId: doc._id, version: 1, workspaceId: w.ws._id, status: "active", chunkIndex: (chunkCounter += 1), section: o.section ?? "P25", text: o.text ?? "P25 chunk", visibility: o.visibility ?? "staff", embedding: o.vector, ...(o.model === null ? {} : { embeddingModel: o.model ?? TEST_MODEL }), embeddingInputVersion: 1, ...(o.scope === "unit" ? { propertyId: w.prop._id, unitId: w.unit._id } : {}) });
  const signalFields = (w, extra = {}) => ({ workspaceId: w.ws._id, propertyId: w.prop._id, unitId: w.unit._id, type: "maintenance", severity: "high", source: "staff", title: "P25 AC not cooling", description: "Warm air blowing from the unit.", ...extra });
  const QUERY = "maintenance. P25 AC not cooling. Warm air blowing from the unit.";
  const q = unit(await embed(QUERY));

  // ---- W1: the relevance / compatibility / isolation workspace
  const w1 = await mkWs("w1");
  const guest = await Guest.create({ workspaceId: w1.ws._id, firstName: M.first, lastName: M.last, email: M.email, phone: M.phone });
  const stay = await Stay.create({ workspaceId: w1.ws._id, guestId: guest._id, propertyId: w1.prop._id, unitId: w1.unit._id, status: "checked_in", checkIn: new Date("2030-01-01"), checkOut: new Date("2030-01-04") });
  const doc1 = await mkDoc(w1, "w1");
  const v = (c, k = 0) => atCosine(q, c, k);
  const c = {
    hi: { vector: v(0.9), text: "P25 hi" },
    mid: { vector: v(0.6, 1), text: "P25 mid" },
    tie1: { vector: v(0.7, 2), text: "P25 tie 1" },
    above: { vector: v(0.3, 3), text: "P25 above" },
    edge: { vector: v(0.25, 4), text: "P25 edge" },
    below: { vector: v(0.2, 5), text: `P25 below ${M.weak}` },
    low: { vector: v(0.1, 6), text: `P25 low ${M.weak}` },
    orth: { vector: v(0, 7), text: `P25 orthogonal ${M.weak}` },
    neg: { vector: v(-0.5, 8), text: `P25 negative ${M.weak}` },
    restricted: { vector: v(0.95, 9), visibility: "restricted", text: `P25 ${M.restricted}` },
    otherModel: { vector: v(0.97, 10), model: "other-embedding-model", text: "P25 other model" },
    wrongDim: { vector: [0.3, 0.4, 0.5], text: "P25 wrong dimension" },
    unlabeled: { vector: v(0.96, 11), model: null, text: "P25 unlabeled" },
  };
  c.tie2 = { vector: [...c.tie1.vector], text: "P25 tie 2" };
  const docs1 = {};
  const insert = async (w, doc, spec) => {
    const created = [];
    for (const [key, o] of Object.entries(spec)) created.push([key, await KnowledgeChunk.create(chunkDoc(w, doc, o))]);
    return Object.fromEntries(created.map(([key, chunk]) => [key, String(chunk._id)]));
  };
  Object.assign(docs1, await insert(w1, doc1, c));

  // ---- foreign workspace: the MOST similar chunk in the whole database (0.99), guest-visible
  const wb = await mkWs("wb");
  const docB = await mkDoc(wb, "wb");
  const foreignIds = await insert(wb, docB, { foreign: { vector: v(0.99, 12), visibility: "guest", text: `P25 ${M.foreign}` } });
  const foreignSignal = await Signal.create(signalFields(wb, { title: "P25 foreign signal" }));

  const sig = { main: await Signal.create(signalFields(w1, { guestId: guest._id, stayId: stay._id })), forged: await Signal.create(signalFields(w1)), admin: await Signal.create(signalFields(w1)) };
  const fingerprints = async () => ({
    signals: hashRows(await Signal.find({ workspaceId: { $in: [w1.ws._id, wb.ws._id] } }, { _id: 1, updatedAt: 1 }).sort({ _id: 1 }).lean()),
    guests: hashRows(await Guest.find({ workspaceId: { $in: [w1.ws._id, wb.ws._id] } }, { _id: 1, updatedAt: 1 }).sort({ _id: 1 }).lean()),
    stays: hashRows(await Stay.find({ workspaceId: { $in: [w1.ws._id, wb.ws._id] } }, { _id: 1, updatedAt: 1 }).sort({ _id: 1 }).lean()),
    chunks: hashRows(await KnowledgeChunk.find({ workspaceId: { $in: [w1.ws._id, wb.ws._id] } }, { _id: 1, updatedAt: 1 }).sort({ _id: 1 }).lean()),
    documents: hashRows(await KnowledgeDocument.find({ workspaceId: { $in: [w1.ws._id, wb.ws._id] } }, { _id: 1, updatedAt: 1 }).sort({ _id: 1 }).lean()),
    properties: hashRows(await Property.find({ workspaceId: { $in: [w1.ws._id, wb.ws._id] } }, { _id: 1, updatedAt: 1 }).sort({ _id: 1 }).lean()),
    foreign: hashRows(await KnowledgeChunk.find({ workspaceId: wb.ws._id }, { _id: 1, updatedAt: 1 }).lean()),
  });
  const fpBefore = await fingerprints();

  // measured similarities: Python's OWN arithmetic on the constructed vectors (direct call, no Node)
  const direct = await fetch(`http://127.0.0.1:${AI_PORT}/v1/knowledge-retrieval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ queryText: QUERY, authorizedLevel: "restricted", candidates: ["hi", "mid", "tie1", "tie2", "above", "edge", "below", "low", "orth", "neg"].map((k) => ({ chunkId: docs1[k], embedding: c[k].vector, scope: "workspace", visibility: "staff", embeddingModel: TEST_MODEL })) }),
  }).then((r) => r.json());
  const sim = Object.fromEntries(direct.results.map((r) => [Object.keys(docs1).find((k) => docs1[k] === r.chunkId), r.similarityScore]));
  const nameOf = (id) => Object.entries({ ...docs1, ...foreignIds }).find(([, value]) => value === id)?.[0] ?? id;

  // B. cosine correctness against an independent computation on constructed vectors
  check("B cosine: Python's similarity equals an independent JS computation for every constructed vector (|diff| < 1e-12)", Object.keys(sim).length === 10 && Object.entries(sim).every(([k, s]) => Math.abs(s - cosine(q, c[k].vector)) < 1e-12), stable(sim));
  check("B cosine: the constructed cosines are the intended ones (0.9, 0.6, 0.7, 0.3, 0.25, 0.2, 0.1, 0, -0.5)", [["hi", 0.9], ["mid", 0.6], ["tie1", 0.7], ["above", 0.3], ["edge", 0.25], ["below", 0.2], ["low", 0.1], ["orth", 0], ["neg", -0.5]].every(([k, want]) => Math.abs(sim[k] - want) < 1e-12));
  check("B ties: two chunks with identical vectors score identically", sim.tie1 === sim.tie2);

  // the expected final set at the DEFAULT floor (0.25), for an OPERATOR (staff ceiling), by an independent rule
  const scored = ["hi", "mid", "tie1", "tie2", "above", "edge", "below", "low", "orth", "neg"]; // compatible + visible to staff
  const expectedFor = (floor) => scored.filter((k) => sim[k] >= floor).sort((a, b) => sim[b] - sim[a] || (docs1[a] < docs1[b] ? -1 : 1)).slice(0, 5).map((k) => docs1[k]);
  const expectedDefault = expectedFor(DEFAULT_RETRIEVAL_MIN_SIMILARITY);
  check("C expected: at the default floor the strong chunks are in and the weak ones are out (by construction)", ["hi", "mid", "tie1", "tie2", "above"].every((k) => expectedDefault.includes(docs1[k])) && ["below", "low", "orth", "neg"].every((k) => !expectedDefault.includes(docs1[k])));

  // ---------------------------------------------------------------- servers
  const mainServer = startBackend(PORTS.main); // the PRODUCTION default floor
  const eqServer = startBackend(PORTS.boundaryEq, sim.edge); // the floor set EXACTLY at the edge chunk's similarity
  const upServer = startBackend(PORTS.boundaryUp, sim.edge + 1e-9); // a hair above it
  await Promise.all([PORTS.main, PORTS.boundaryEq, PORTS.boundaryUp].map((p) => waitFor(`${api(p)}/health`)));
  void mainServer;
  void eqServer;
  void upServer;
  const mark = () => recorded.length;
  const since = (n) => recorded.slice(n);
  const analyzeReq = (n) => since(n).find((r) => r.url === "/v1/intelligence/analyze")?.body;
  const retrievalReqs = (n) => since(n).filter((r) => r.url === "/v1/knowledge-retrieval");
  const textSince = (n) => since(n).map((r) => r.text).join("\n");
  const sentIds = (n) => (analyzeReq(n)?.knowledge || []).map((k) => k.chunkId);
  const dev = (port, w, signal, extra = "") => call(port, w.admin, "GET", `/signals/${signal._id}/knowledge-retrieval?workspaceId=${w.A}${extra}`);

  // ---------------------------------------------------------------- A. candidate selection (operator = staff ceiling)
  let n = mark();
  const main = await call(PORTS.main, w1.operator, "POST", `/intelligence/analyze/${sig.main._id}?workspaceId=${w1.A}`);
  check("A the analysis is created (201)", main.status === 201, `HTTP ${main.status}: ${main.raw.slice(0, 200)}`);
  const retrievals = retrievalReqs(n);
  const candidateIds = retrievals.flatMap((r) => r.body.candidates.map((x) => x.chunkId));
  check("A workspace filter: no chunk of another workspace was ever a candidate", !candidateIds.includes(foreignIds.foreign));
  check("A visibility filter: the restricted chunk is not a candidate for an operator (staff ceiling)", !candidateIds.includes(docs1.restricted));
  check("A the candidate pool is exactly the eligible, embedded chunks (13: staff-visible in workspace A), in ascending _id order", candidateIds.length === 13 && stable(candidateIds) === stable([...candidateIds].sort()), `${candidateIds.length}`);
  check("A retrieval request: authorizedLevel is the role's ceiling (staff) and each candidate carries its embedding-model label", retrievals[0].body.authorizedLevel === "staff" && retrievals[0].body.candidates.every((x) => typeof x.embeddingModel === "string" && x.embeddingModel.length > 0));
  check("A the unlabeled chunk is sent with a placeholder label that can never equal a real model", retrievals[0].body.candidates.find((x) => x.chunkId === docs1.unlabeled)?.embeddingModel === "(unlabeled)");

  // ---------------------------------------------------------------- C/H. what reached the model
  const req1 = analyzeReq(n);
  const sent1 = sentIds(n);
  check("H the model request holds ONLY the final evidence: exactly the chunks that reached the floor, best first", stable(sent1) === stable(expectedDefault), `sent ${stable(sent1.map(nameOf))} expected ${stable(expectedDefault.map(nameOf))}`);
  check("C weak chunks (below the floor) never reach the model: not their ids", ["below", "low", "orth", "neg"].every((k) => !sent1.includes(docs1[k])));
  check("C ...and no rejected chunk's text is in the analyze request", !JSON.stringify(req1).includes(M.weak));
  check("F the highest-similarity chunk in the database (workspace B, 0.99) never reaches the model", !JSON.stringify(req1).includes(M.foreign) && !sent1.includes(foreignIds.foreign));
  check("F a restricted chunk (0.95) never reaches an operator's model request", !JSON.stringify(req1).includes(M.restricted) && !sent1.includes(docs1.restricted));
  check("E incompatible chunks never reach the model: other model (0.97), unlabeled (0.96), other dimension", [docs1.otherModel, docs1.unlabeled, docs1.wrongDim].every((id) => !sent1.includes(id)));
  const allowedKeys = ["chunkId", "knowledgeDocumentId", "version", "scope", "visibility", "section", "sectionPath", "chunkIndex", "text", "similarityScore", "retrievalScore"];
  check("H every evidence item carries only the grounding fields: no embedding vector, no embedding-model label", (req1?.knowledge || []).every((k) => Object.keys(k).every((key) => allowedKeys.includes(key))) && !JSON.stringify(req1).includes("embeddingModel"));
  // Phase 27: the canonical path now always attaches `operationalHistory` (bounded, validated); updated to
  // match that intentional addition, still failing on any other/unexpected key.
  check("H the model request has exactly {context, knowledge, authorizedLevel, operationalHistory}", stable(Object.keys(req1).sort()) === stable(["authorizedLevel", "context", "knowledge", "operationalHistory"]));
  check("H the public response does not show similarity scores inside evidence text", !main.data.analysis.evidence.some((e) => /retrieval score|similarity/i.test(e)) && !/similarityScore|retrievalScore\b.*knowledgeDocumentId/.test(main.raw));
  check("H provenance in the response cites only the evidence that reached the model", stable((main.data.knowledgeProvenance || []).map((p) => p.chunkId)) === stable(sent1));

  // G. PII: nothing of the guest anywhere in either request, and the query is exactly the signal's own text
  const allText = textSince(n).toLowerCase();
  for (const [label, value] of [["e-mail", M.email], ["phone", M.phone], ["first name", M.first], ["last name", M.last]]) check(`G guest ${label} marker is absent from the retrieval query and every model request`, !allText.includes(value.toLowerCase()));
  check("G the retrieval query text is exactly the Signal's type, title and description", retrievals[0].body.queryText === QUERY);

  // ---------------------------------------------------------------- D. top-K, and the diagnostics / determinism through the admin endpoint
  const devA = await dev(PORTS.main, w1, sig.main);
  const devB = await dev(PORTS.main, w1, sig.main);
  check("A determinism: two identical retrievals return identical results (ids, order, scores)", devA.status === 200 && stable(devA.data.results.map((r) => [r.chunkId, r.similarityScore, r.retrievalScore])) === stable(devB.data.results.map((r) => [r.chunkId, r.similarityScore, r.retrievalScore])));
  const diag = devA.data.diagnostics;
  check("E diagnostics (admin, restricted ceiling): 14 eligible, 14 evaluated, 3 incompatible (other model, unlabeled, other dimension)", diag.eligibleCandidates === 14 && diag.evaluatedCandidates === 14 && diag.incompatibleCandidates === 3, stable(diag));
  const belowFor = (floor) => [...scored.map((k) => sim[k]), 0.95].filter((s) => s < floor).length; // + the restricted chunk (admin sees it)
  check("C diagnostics: the floor and top-K in force are reported, and the below-floor chunks are counted exactly", diag.minSimilarity === DEFAULT_RETRIEVAL_MIN_SIMILARITY && diag.topK === 5 && diag.belowThreshold === belowFor(DEFAULT_RETRIEVAL_MIN_SIMILARITY), stable(diag));
  check("F an admin (restricted ceiling) sees the restricted chunk its own workspace holds (and still no foreign chunk)", devA.data.results.some((r) => r.chunkId === docs1.restricted) && !devA.data.results.some((r) => r.chunkId === foreignIds.foreign));
  check("B ordering: results are sorted by retrieval score, ties by chunk id", devA.data.results.every((r, i, list) => i === 0 || list[i - 1].retrievalScore > r.retrievalScore || (list[i - 1].retrievalScore === r.retrievalScore && list[i - 1].chunkId < r.chunkId)));
  check("C status: a normal retrieval reports status ok", devA.data.status === "ok");

  // B/C exact boundary, in a dedicated workspace holding only a strong chunk and the edge chunk (top-K cannot hide the edge chunk)
  const w6 = await mkWs("w6");
  const doc6 = await mkDoc(w6, "w6");
  const ids6 = await insert(w6, doc6, { strong: { vector: v(0.9, 1), text: "P25 w6 strong" }, edge: { vector: c.edge.vector, text: "P25 w6 edge" } });
  const sig6 = await Signal.create(signalFields(w6));
  const dev6 = await dev(PORTS.main, w6, sig6);
  const eqRes = await dev(PORTS.boundaryEq, w6, sig6);
  const upRes = await dev(PORTS.boundaryUp, w6, sig6);
  check("B/C boundary: with the floor EXACTLY at the edge chunk's similarity the edge chunk is kept (>=, inclusive)", eqRes.data.results.some((r) => r.chunkId === ids6.edge) && eqRes.data.diagnostics.minSimilarity === sim.edge && eqRes.data.diagnostics.belowThreshold === 0, stable(eqRes.data.diagnostics));
  check("B/C boundary: with the floor a hair (1e-9) above it the edge chunk is rejected and the strong one stays", !upRes.data.results.some((r) => r.chunkId === ids6.edge) && upRes.data.results.some((r) => r.chunkId === ids6.strong) && upRes.data.diagnostics.belowThreshold === 1, stable(upRes.data.diagnostics));
  check("B/C boundary: at the production default (0.25) the edge chunk follows its measured similarity", dev6.data.results.some((r) => r.chunkId === ids6.edge) === (sim.edge >= DEFAULT_RETRIEVAL_MIN_SIMILARITY));

  // F. forged retrieval controls
  n = mark();
  const forgedQuery = "&minSimilarity=-1&similarityThreshold=-1&topK=50&limit=50&embeddingModel=other-embedding-model&visibility=restricted&level=restricted&authorizedLevel=restricted&scope=all&candidates=all";
  const forgedHeaders = { "x-min-similarity": "-1", "x-top-k": "50", "x-role": "admin", "x-knowledge-level": "restricted", "x-workspace-id": wb.A, "x-embedding-model": "other-embedding-model" };
  const forgedBody = { minSimilarity: -1, topK: 50, embeddingModel: "other-embedding-model", visibility: "restricted", workspaceId: wb.A, candidateChunkIds: [foreignIds.foreign, docs1.restricted] };
  const forged = await call(PORTS.main, w1.operator, "POST", `/intelligence/analyze/${sig.forged._id}?workspaceId=${w1.A}${forgedQuery}`, { headers: forgedHeaders, body: forgedBody });
  check("F forged floor / top-K / model / visibility / candidate controls via query + headers + body: still 201 at the staff level", forged.status === 201 && forged.data.analysisLevel === "staff");
  check("F ...and the model request is IDENTICAL to the unforged one (same evidence, same order, no foreign or restricted chunk)", stable(sentIds(n)) === stable(sent1));
  const nForgedWs = mark();
  const forgedWs = await call(PORTS.main, w1.operator, "POST", `/intelligence/analyze/${foreignSignal._id}?workspaceId=${wb.A}`, { body: { workspaceId: wb.A } });
  check("F naming the foreign workspace as the selector is refused (404) with no AI call", forgedWs.status === 404 && mark() === nForgedWs);
  const devForged = await dev(PORTS.main, w1, sig.main, forgedQuery);
  check("F the admin retrieval endpoint ignores forged floor / top-K / model controls (same results and diagnostics)", devForged.status === 200 && stable(devForged.data.results.map((r) => r.chunkId)) === stable(devA.data.results.map((r) => r.chunkId)) && devForged.data.diagnostics.minSimilarity === DEFAULT_RETRIEVAL_MIN_SIMILARITY && devForged.data.diagnostics.topK === 5);

  // ---------------------------------------------------------------- W2: every candidate below the floor
  const w2 = await mkWs("w2");
  const doc2 = await mkDoc(w2, "w2");
  const ids2 = await insert(w2, doc2, { low: { vector: v(0.1, 1), text: `P25 ${M.weak} low` }, neg: { vector: v(-0.4, 2), text: `P25 ${M.weak} neg` } });
  const sig2 = await Signal.create(signalFields(w2));
  n = mark();
  const r2 = await call(PORTS.main, w2.operator, "POST", `/intelligence/analyze/${sig2._id}?workspaceId=${w2.A}`);
  const req2 = analyzeReq(n);
  check("I all candidates below the floor: generation still succeeds (201)", r2.status === 201);
  check("I ...the model request carries an EMPTY knowledge list (nothing was forced in)", Array.isArray(req2?.knowledge) && req2.knowledge.length === 0 && !JSON.stringify(req2).includes(M.weak));
  check("I ...no knowledge provenance is fabricated, and the stored analysis cites no chunk", r2.data.knowledgeProvenance === undefined && ((await Intelligence.findById(r2.data._id).lean()).analysis.usedKnowledgeChunkIds ?? []).length === 0 && !(await Intelligence.findById(r2.data._id).lean()).knowledgeProvenance?.length);
  check("I ...the analysis says explicitly that no documented knowledge was retrieved", r2.data.analysis.evidence.some((e) => /No relevant documented Business Knowledge was retrieved/.test(e)) && r2.data.analysis.confidence === "low");
  const dev2 = await dev(PORTS.main, w2, sig2);
  check("I status is explicit: no_relevant_knowledge, with both candidates counted as below the floor", dev2.data.status === "no_relevant_knowledge" && dev2.data.results.length === 0 && dev2.data.diagnostics.belowThreshold === 2 && dev2.data.diagnostics.eligibleCandidates === 2);
  void ids2;

  // ---------------------------------------------------------------- W4: no candidates at all
  const w4 = await mkWs("w4");
  const sig4 = await Signal.create(signalFields(w4));
  n = mark();
  const r4 = await call(PORTS.main, w4.operator, "POST", `/intelligence/analyze/${sig4._id}?workspaceId=${w4.A}`);
  check("I no eligible knowledge at all: generation succeeds with an empty knowledge list, no Python retrieval call needed", r4.status === 201 && (analyzeReq(n)?.knowledge || []).length === 0 && retrievalReqs(n).length === 0);
  check("I status is explicit: no_eligible_knowledge", (await dev(PORTS.main, w4, sig4)).data.status === "no_eligible_knowledge");

  // ---------------------------------------------------------------- W5: nothing comparable
  const w5 = await mkWs("w5");
  const doc5 = await mkDoc(w5, "w5");
  await insert(w5, doc5, { a: { vector: v(0.9, 1), model: "retired-embedding-model" }, b: { vector: [0.1, 0.2, 0.3], model: "retired-embedding-model" } });
  const sig5 = await Signal.create(signalFields(w5));
  n = mark();
  const r5 = await call(PORTS.main, w5.operator, "POST", `/intelligence/analyze/${sig5._id}?workspaceId=${w5.A}`);
  check("E nothing comparable (every eligible embedding is from another model / dimension): generation FAILS CLOSED (502, retrieval-unavailable marker)", r5.status === 502 && /KNOWLEDGE_RETRIEVAL_UNAVAILABLE/.test(r5.message || ""), `${r5.status} ${r5.message}`);
  check("E ...it is NOT reported as 'no relevant knowledge': the model was never called and nothing was stored", analyzeReq(n) === undefined && (await Intelligence.countDocuments({ signalIds: sig5._id })) === 0);

  // ---------------------------------------------------------------- W3: top-K and ties
  const w3 = await mkWs("w3");
  const doc3 = await mkDoc(w3, "w3");
  const spec3 = {};
  [[0.9, "d90"], [0.85, "d85"], [0.8, "d80"], [0.7, "d70"], [0.65, "d65"], [0.6, "d60"], [0.55, "d55"]].forEach(([cos, key], i) => { spec3[key] = { vector: v(cos, i), text: `P25 ${key}` }; });
  spec3.t1 = { vector: v(0.75, 8), text: "P25 t1" };
  spec3.t2 = { vector: [...spec3.t1.vector], text: "P25 t2" };
  spec3.t3 = { vector: [...spec3.t1.vector], text: "P25 t3" };
  const ids3 = await insert(w3, doc3, spec3);
  const sig3 = await Signal.create(signalFields(w3));
  n = mark();
  const r3 = await call(PORTS.main, w3.operator, "POST", `/intelligence/analyze/${sig3._id}?workspaceId=${w3.A}`);
  const sent3 = sentIds(n);
  check("D top-K: 10 chunks pass the floor, only 5 reach the model", r3.status === 201 && sent3.length === 5);
  check("D ordering: best first; three exact ties straddle the cut and the two LOWEST chunk ids win", stable(sent3) === stable([ids3.d90, ids3.d85, ids3.d80, ids3.t1, ids3.t2]) && ids3.t1 < ids3.t2 && ids3.t2 < ids3.t3);
  check("D the chunks that did not make the cut (a tied chunk, 0.70 and below) are absent from the request text", !JSON.stringify(analyzeReq(n)).includes("P25 t3") && !JSON.stringify(analyzeReq(n)).includes("P25 d70"));

  // ---------------------------------------------------------------- W7: paging (the old code scored only the first 200 chunks by _id)
  const w7 = await mkWs("w7");
  const doc7 = await mkDoc(w7, "w7");
  const filler = Array.from({ length: 450 }, (_, i) => chunkDoc(w7, doc7, { vector: v(0.05, i % 30), text: `P25 filler ${i}` }));
  await KnowledgeChunk.insertMany(filler);
  const best = await KnowledgeChunk.create(chunkDoc(w7, doc7, { vector: v(0.95, 31), text: "P25 best-but-last" }));
  const sig7 = await Signal.create(signalFields(w7));
  n = mark();
  const r7 = await call(PORTS.main, w7.operator, "POST", `/intelligence/analyze/${sig7._id}?workspaceId=${w7.A}`);
  const pages = retrievalReqs(n);
  check("A paging: 451 eligible chunks are scored in three Python requests of 200, 200 and 51", pages.length === 3 && stable(pages.map((p) => p.body.candidates.length)) === stable([200, 200, 51]), stable(pages.map((p) => p.body.candidates.length)));
  const pagedIds = pages.flatMap((p) => p.body.candidates.map((x) => x.chunkId));
  check("A paging: every eligible chunk is a candidate exactly once, in ascending _id order across pages", pagedIds.length === 451 && new Set(pagedIds).size === 451 && stable(pagedIds) === stable([...pagedIds].sort()));
  check("A paging: the most relevant chunk is the LAST one by _id (beyond the former 200-chunk cap) and it IS retrieved and used", r7.status === 201 && stable(sentIds(n)) === stable([String(best._id)]));

  // ---------------------------------------------------------------- W8: the ceiling fails closed
  const w8 = await mkWs("w8");
  const doc8 = await mkDoc(w8, "w8");
  await KnowledgeChunk.insertMany(Array.from({ length: MAX_ELIGIBLE_CANDIDATES + 1 }, (_, i) => chunkDoc(w8, doc8, { vector: v(0.05, i % 30), text: `P25 ceiling ${i}` })));
  const sig8 = await Signal.create(signalFields(w8));
  n = mark();
  const r8 = await call(PORTS.main, w8.operator, "POST", `/intelligence/analyze/${sig8._id}?workspaceId=${w8.A}`);
  check("A ceiling: more eligible chunks than the ceiling FAILS CLOSED (502, retrieval-unavailable) instead of scoring only part of them", r8.status === 502 && /KNOWLEDGE_RETRIEVAL_UNAVAILABLE/.test(r8.message || ""), `${r8.status} ${r8.message}`);
  check("A ceiling: exactly ten pages were scored before refusing, the model was never called, nothing was stored", retrievalReqs(n).length === 10 && analyzeReq(n) === undefined && (await Intelligence.countDocuments({ signalIds: sig8._id })) === 0);

  // ---------------------------------------------------------------- J. mutation / baseline
  const adminRun = await call(PORTS.main, w1.admin, "POST", `/intelligence/analyze/${sig.admin._id}?workspaceId=${w1.A}`);
  const adminSent = (adminRun.data?.knowledgeProvenance || []).map((p) => p.chunkId);
  check("F an admin's generation (restricted ceiling) may use its OWN restricted chunk, and never the foreign one", adminRun.status === 201 && adminSent.includes(docs1.restricted) && !adminSent.includes(foreignIds.foreign));
  const fpAfter = await fingerprints();
  check("J no Signal, Guest, Stay, Property, KnowledgeDocument or KnowledgeChunk was modified by any retrieval or generation", stable(fpAfter) === stable(fpBefore), `${stable(fpBefore)} vs ${stable(fpAfter)}`);
  check("J the foreign workspace's chunks are byte-for-byte untouched", fpAfter.foreign === fpBefore.foreign);
  const created = await Intelligence.find({ workspaceId: { $in: ids.workspaces } }).lean();
  check("J the only records created are Intelligence for the analyses this suite requested (main, forged, w2, w4, w3, w7, admin)", created.length === 7 && created.every((i) => i.provider === "test" && i.model === "deterministic-stub"), `${created.length}`);
  check("no external AI: every analysis was produced by the deterministic test provider (checked above) and every embedding by 'deterministic-embedding-v1'", recorded.filter((r) => r.url === "/v1/knowledge-retrieval" && r.response).every((r) => r.response.model === TEST_MODEL));

  await cleanup();
  await connectDatabase();
  const after = await counts();
  check("database counts are back to the baseline after cleanup", stable(after) === stable(before), `before=${stable(before)} after=${stable(after)}`);
}

main()
  .catch((error) => {
    console.error(error);
    failed += 1;
  })
  .finally(async () => {
    for (const child of children) {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
    proxyServer?.close();
    try {
      await cleanup();
    } catch {
      // best effort
    }
    console.log(`\nPhase 25 retrieval hardening validation: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
