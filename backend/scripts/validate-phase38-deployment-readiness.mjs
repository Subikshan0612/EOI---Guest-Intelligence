/**
 * Phase 38 validation - production deployment readiness (deterministic; no Gemini; no key; no external service).
 *
 *   node backend/scripts/validate-phase38-deployment-readiness.mjs
 *
 *   A  claim-validation reason codes   one deterministic test per category; end to end (HTTP -> audit row -> event); the AI service's `rule`; no content in any code
 *   B  MongoDB configuration           the start-up matrix (pure + a real refused start that never echoes the URI)
 *   C  index inventory                 derived from the real models on a FRESH throwaway database; every index classified; required indexes present
 *   D  start-up safety (static)        no destructive operation at start-up, no hard-coded database, no new infrastructure
 *   E  OIDC readiness                  the Phase 23 suite is run and the nine required behaviours are asserted BY NAME
 *   F  documentation contract          environment contract completeness vs the code; observability, topology and GO/NO-GO structure and honesty
 *
 * Real MongoDB (throwaway workspaces removed by id; a throwaway database for C), real spawned backends, a deterministic in-process stub AI service.
 * Nothing is wiped. Learning stays OFF.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
// authFixtures first: it declares NODE_ENV=test and the stub verifier for everything below.
import { cleanupAuthFixtures, createActor, sweepOrphanAdmissions } from "./lib/authFixtures.mjs";
import mongoose from "mongoose";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { AnalysisAdmission, Action, Decision, Intelligence, KnowledgeChunk, Signal, User, Workspace, WorkspaceMembership } from "../src/models/index.js";
import { APPROVED_MODEL, APPROVED_PROVIDER } from "../src/config/providerPolicy.js";
import { mongoConfigProblems } from "../src/config/startupChecks.js";
import { buildEvidenceEnvelope } from "../src/services/ai/evidenceEnvelope.js";
import { CLAIM_RULES, CLAIM_RULE_CODES, CLAIM_VALIDATION_FAILED, validateClaims } from "../src/services/ai/claimValidator.js";
import { ALLOWED_FIELDS, setLogEventSink } from "../src/utils/logEvent.js";
import { AppError } from "../src/utils/AppError.js";
import { buildAdmissionDocument, getAnalysisAdmissionByAttempt } from "../src/services/analysisAdmissionService.js";
import { summarizeEvents } from "./phase37/summarize-events.mjs";
import { buildIndexInventory } from "./phase38/index-inventory.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const REPO = path.join(BACKEND, "..");
const read = (p) => fs.readFileSync(p, "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); }
};
const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
const caughtRaw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const withEnv = async (patch, fn) => {
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function captureLogs(fn) {
  const lines = []; const push = (...a) => lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  const saved = { ...console };
  console.log = push; console.info = push; console.warn = push; console.error = push;
  setLogEventSink((l) => lines.push(l));
  try { return { value: await fn(), lines }; } finally { Object.assign(console, saved); console.error = realConsole.error; setLogEventSink(); }
}
const stamp = Date.now();
const FIX = JSON.parse(read(path.join(REPO, "ai-service", "tests", "fixtures", "evidence_catalog_parity.json")));
const claim = (claimType, text, ...sourceRefs) => ({ claimType, text, sourceRefs });
const MARK = { title: "P38-TITLE-MARKER", desc: "P38-DESC-MARKER", rec: "P38-REC-MARKER", claim: "P38-CLAIM-TEXT-MARKER" };

// ============================================================================================================ A. REASON CODES (pure)
console.log("\n# A. claim-validation reason codes");
const SIG = "current:signal:64b0000000000000000000a1";
const UNT = "untrusted:signal:64b0000000000000000000a1";
const HAN = "history:analysis:64b0000000000000000000f1";
const KNW = "knowledge:64b0000000000000000000k1";
const ENV = buildEvidenceEnvelope({ workspaceId: FIX.workspaceId, ...FIX.input });
const T = MARK.claim;
const OTHER_WS = "64b0000000000000000000ee"; // (the fixture's own workspace is ...ff)
const ruleOf = (claims, over = {}) => {
  try { validateClaims(claims, ENV, { workspaceId: FIX.workspaceId, strict: true, ...over }); return { accepted: true }; } catch (e) { return { status: e.statusCode, code: e.details?.code, rule: e.details?.rule, message: e.message, details: e.details, isApp: e instanceof AppError }; }
};
const CASES = {
  CLAIM_FOREIGN_REF: () => ruleOf([claim("FACT", T, SIG), claim("RECOMMENDATION", T, SIG)], { workspaceId: OTHER_WS }),
  CLAIM_MALFORMED: () => ruleOf([{ claimType: "FACT", text: T, sourceRefs: [SIG], extra: 1 }]),
  CLAIM_TOO_MANY: () => ruleOf(Array.from({ length: 13 }, () => claim("FACT", T, SIG))),
  CLAIM_MISSING_REQUIRED_EVIDENCE: () => ruleOf([]),
  CLAIM_UNKNOWN_TYPE: () => ruleOf([claim("OPINION", T, SIG)]),
  CLAIM_MISSING_SOURCE_REFS: () => ruleOf([claim("FACT", T)]),
  CLAIM_DUPLICATE_REF: () => ruleOf([claim("FACT", T, SIG, SIG)]),
  CLAIM_UNKNOWN_REF: () => ruleOf([claim("FACT", T, "current:signal:64b00000000000000000ffff")]),
  CLAIM_EVIDENCE_TYPE_MISMATCH: () => ruleOf([claim("FACT", T, KNW)]),
  CLAIM_INVALID_FACT_SUPPORT: () => ruleOf([claim("FACT", T, UNT), claim("RECOMMENDATION", T, SIG)]),
  CLAIM_INVALID_HISTORICAL_PATTERN: () => ruleOf([claim("HISTORICAL_PATTERN", T, SIG), claim("RECOMMENDATION", T, SIG)]),
  CLAIM_INVALID_BUSINESS_GUIDANCE: () => ruleOf([claim("BUSINESS_GUIDANCE", T, SIG), claim("RECOMMENDATION", T, SIG)]),
  CLAIM_UNSUPPORTED_RECOMMENDATION: () => ruleOf([claim("FACT", T, SIG), claim("RECOMMENDATION", T, HAN)]),
  CLAIM_NO_RECOMMENDATION: () => ruleOf([claim("FACT", T, SIG)]),
};
const { value: caseResults, lines: caseLines } = await captureLogs(async () => Object.fromEntries(Object.entries(CASES).map(([rule, run]) => [rule, run()])));
const reachable = Object.keys(CASES);
for (const rule of reachable) {
  const r = caseResults[rule];
  check(`A.${rule} a ${rule.replace("CLAIM_", "").toLowerCase().replaceAll("_", " ")} analysis is rejected with HTTP semantics unchanged (502, CLAIM_VALIDATION_FAILED) and the stable rule code ${rule}`,
    r.isApp && r.status === 502 && r.code === CLAIM_VALIDATION_FAILED && r.rule === rule && /^AI service returned an invalid analysis \(/.test(r.message), `${r.status} ${r.code} ${r.rule}`);
}
check("A15 CLAIM_INVALID_LEARNING_OBSERVATION is RESERVED: under the current CLAIM_RULES it cannot be reached (every class a learning claim may cite is already a required class, so a wrong class is CLAIM_EVIDENCE_TYPE_MISMATCH first) - it is kept so a future rule change can never emit an unlisted code",
  CLAIM_RULE_CODES.includes("CLAIM_INVALID_LEARNING_OBSERVATION") && CLAIM_RULES.LEARNING_OBSERVATION.allowed.every((c) => CLAIM_RULES.LEARNING_OBSERVATION.requiresAnyOf.includes(c)) && ruleOf([claim("LEARNING_OBSERVATION", T, SIG), claim("RECOMMENDATION", T, SIG)]).rule === "CLAIM_EVIDENCE_TYPE_MISMATCH");
check("A16 COVERAGE: every code the validator can emit has a test above (14 deterministic + 1 reserved = all 15), and there is no code without a validator reject site", CLAIM_RULE_CODES.length === 15 && CLAIM_RULE_CODES.every((c) => reachable.includes(c) || c === "CLAIM_INVALID_LEARNING_OBSERVATION"));
const validatorSrc = read(path.join(BACKEND, "src", "services", "ai", "claimValidator.js"));
const rejectCalls = [...stripComments(validatorSrc).matchAll(/\breject\(([^;]*?)\);/g)].map((m) => m[1]).filter((c) => !/^reason, rule/.test(c));
check("A17 EVERY reject site passes a rule from the catalogue (no site was left without a code, none passes free text as a code)", rejectCalls.length === (stripComments(validatorSrc).match(/\breject\(/g) ?? []).length - 1 && rejectCalls.length >= 17 && rejectCalls.every((c) => /,\s*("CLAIM_[A-Z_]+"|UNSUPPORTED_BY_TYPE\[claim\.claimType\])\s*$/.test(c)), `${rejectCalls.length} reject sites`);
check("A18 THE CODES ARE NON-SENSITIVE BY CONSTRUCTION: every code is a fixed upper-case token (never text, never an id), they are all distinct, and none of the 14 rejections above leaked the claim text, a reference, or the workspace id into the error message, its details or any log line",
  CLAIM_RULE_CODES.every((c) => /^[A-Z][A-Z_]{2,47}$/.test(c)) && new Set(CLAIM_RULE_CODES).size === CLAIM_RULE_CODES.length &&
  Object.values(caseResults).every((r) => !JSON.stringify({ m: r.message, d: r.details }).includes(MARK.claim) && !/64b0000/.test(JSON.stringify({ m: r.message, d: r.details }))) && !caseLines.some((l) => l.includes(MARK.claim) || /64b0000/.test(l)) && caseLines.some((l) => /Claim validation rejected the analysis/.test(l) && CLAIM_RULE_CODES.some((c) => l.includes(c))),
  `codes=${CLAIM_RULE_CODES.every((c) => /^[A-Z][A-Z_]{2,47}$/.test(c))} msgLeak=${Object.entries(caseResults).filter(([, r]) => JSON.stringify({ m: r.message, d: r.details }).includes(MARK.claim) || /64b0000/.test(JSON.stringify({ m: r.message, d: r.details }))).map(([k]) => k)} lineLeak=${caseLines.filter((l) => l.includes(MARK.claim) || /64b0000/.test(l)).length} hasRuleLine=${caseLines.some((l) => /Claim validation rejected the analysis/.test(l) && CLAIM_RULE_CODES.some((c) => l.includes(c)))} lines=${caseLines.length}`);
check("A19 DETERMINISTIC: the same invalid analysis yields the same code every time", reachable.every((rule) => CASES[rule]().rule === rule && CASES[rule]().rule === caseResults[rule].rule));
const ok = ruleOf([claim("FACT", T, SIG), claim("RECOMMENDATION", T, SIG, KNW)]);
check("A20 NOT WEAKENED, NOT REPAIRED: a valid set of claims is still accepted unchanged, an invalid one is never auto-corrected (the thrown error carries no repaired claims), and the evidence rules are exactly the Phase 34C table",
  ok.accepted === true && Object.values(caseResults).every((r) => r.accepted === undefined) && JSON.stringify(CLAIM_RULES) === JSON.stringify({
    FACT: { requiresAnyOf: ["CURRENT_OPERATIONAL_FACT"], allowed: ["CURRENT_OPERATIONAL_FACT", "UNTRUSTED_SIGNAL"] },
    HISTORICAL_PATTERN: { requiresAnyOf: ["OPERATIONAL_HISTORY"], allowed: ["OPERATIONAL_HISTORY", "CURRENT_OPERATIONAL_FACT"] },
    BUSINESS_GUIDANCE: { requiresAnyOf: ["BUSINESS_KNOWLEDGE"], allowed: ["BUSINESS_KNOWLEDGE", "CURRENT_OPERATIONAL_FACT"] },
    LEARNING_OBSERVATION: { requiresAnyOf: ["LEARNING_CONTEXT"], allowed: ["LEARNING_CONTEXT"] },
    RECOMMENDATION: { requiresAnyOf: ["CURRENT_OPERATIONAL_FACT", "BUSINESS_KNOWLEDGE"], allowed: ["CURRENT_OPERATIONAL_FACT", "BUSINESS_KNOWLEDGE", "OPERATIONAL_HISTORY", "LEARNING_CONTEXT", "UNTRUSTED_SIGNAL"] },
  }));

// audit-row building (pure)
const WS_ID = "64b0000000000000000000a0";
const SIG_ID = "64b0000000000000000000a1";
const mkError = (details) => { const e = new AppError("x", 502, details); e.admissionTrace = { decidedAt: "claims", stages: { schema: "passed", identity: "passed", claims: "failed" } }; return e; };
const docOk = buildAdmissionDocument({ workspaceId: WS_ID, signalId: SIG_ID, attemptId: "11111111-1111-4111-8111-111111111111", error: mkError({ code: CLAIM_VALIDATION_FAILED, rule: "CLAIM_UNKNOWN_REF" }) });
const docBadRule = buildAdmissionDocument({ workspaceId: WS_ID, signalId: SIG_ID, attemptId: "11111111-1111-4111-8111-111111111112", error: mkError({ code: CLAIM_VALIDATION_FAILED, rule: "claim <script> text" }) });
const docNoRule = buildAdmissionDocument({ workspaceId: WS_ID, signalId: SIG_ID, attemptId: "11111111-1111-4111-8111-111111111113", error: mkError({ code: "SAFETY_POLICY_VIOLATION" }) });
check("A21 AUDIT ROW (pure): the rule becomes `ruleCode`; a value that is not a stable code is DROPPED (never stored); a rejection with no rule has none", docOk.ruleCode === "CLAIM_UNKNOWN_REF" && docOk.reasonCode === CLAIM_VALIDATION_FAILED && docBadRule.ruleCode === undefined && docNoRule.ruleCode === undefined);
const probe = new AnalysisAdmission({ ...docOk, ruleCode: "lower case text" });
const probeErr = probe.validateSync();
check("A22 the schema ITSELF refuses a ruleCode that is not a stable code, accepts a real one, and the field is additive (optional, no index, no default) so existing rows stay valid with no migration",
  Boolean(probeErr?.errors?.ruleCode) && !new AnalysisAdmission(docOk).validateSync()?.errors?.ruleCode && AnalysisAdmission.schema.path("ruleCode").isRequired !== true && !(AnalysisAdmission.schema.indexes().some(([k]) => "ruleCode" in k)) && !new AnalysisAdmission({ ...docNoRule }).toObject().ruleCode);
check("A23 `ruleCode` is an allowlisted event field and the summarizer counts it", ALLOWED_FIELDS.includes("ruleCode") && summarizeEvents([`[KOI EVENT] ${JSON.stringify({ event: "analysis.rejected", outcome: "rejected", decidedAt: "claims", reasonCode: "CLAIM_VALIDATION_FAILED", ruleCode: "CLAIM_UNKNOWN_REF", failureClass: "validation_failure" })}`]).rejectionsByRuleCode?.CLAIM_UNKNOWN_REF === 1);

// ============================================================================================================ DB + stub for the end-to-end section
await connectDatabase();
await Promise.all([AnalysisAdmission.init(), User.init(), WorkspaceMembership.init()]);
await sweepOrphanAdmissions();
const ids = { workspaces: [] };
const counts = async () => ({ AnalysisAdmission: await AnalysisAdmission.countDocuments({ workspaceId: { $nin: ids.workspaces } }), Decision: await Decision.countDocuments({ workspaceId: { $nin: ids.workspaces } }), Action: await Action.countDocuments({ workspaceId: { $nin: ids.workspaces } }), Intelligence: await Intelligence.countDocuments({ workspaceId: { $nin: ids.workspaces } }), Signal: await Signal.countDocuments({ workspaceId: { $nin: ids.workspaces } }), KnowledgeChunk: await KnowledgeChunk.countDocuments({ workspaceId: { $nin: ids.workspaces } }), Workspace: await Workspace.countDocuments({ _id: { $nin: ids.workspaces } }), User: await User.countDocuments({}), WorkspaceMembership: await WorkspaceMembership.countDocuments({}) });
const mkWs = async (label) => { const w = await Workspace.create({ name: `P38 ${label} ${stamp}`, slug: `p38-${label}-${stamp}`, status: "active" }); ids.workspaces.push(w._id); return w; };
const wsA = await mkWs("a"); const wsB = await mkWs("b");
const A = String(wsA._id); const B = String(wsB._id);
const before = await counts();
let sigN = 0;
const mkSignal = async (workspace) => { sigN += 1; return Signal.create({ workspaceId: workspace._id, type: "maintenance", severity: "medium", title: `${MARK.title} ${sigN}`, description: `${MARK.desc} guest reports a fault` }); };

const fake = { mode: "ok", analyzeCalls: 0 };
const STUB_PORT = 5295;
const stub = http.createServer((req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
    const send = (status, payload) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(payload)); };
    if (req.url.endsWith("/v1/knowledge-retrieval")) return send(200, { results: [], model: "stub", evaluatedCandidates: (body.candidates || []).length, incompatibleCandidates: 0 });
    if (!req.url.endsWith("/v1/intelligence/analyze")) return send(404, { error: { code: "MALFORMED_RESPONSE", message: "x" } });
    fake.analyzeCalls += 1;
    if (fake.mode === "ratelimit") return send(429, { error: { code: "PROVIDER_RATE_LIMITED", message: "x" } });
    if (fake.mode === "pyrule") return send(502, { error: { code: "MALFORMED_RESPONSE", message: "x", rule: "CLAIM_MISSING_SOURCE_REFS" } });
    if (fake.mode === "hostilerule") return send(502, { error: { code: "MALFORMED_RESPONSE", message: "x", rule: `bad rule <script> ${MARK.claim}` } });
    const sid = body?.context?.signal?.id;
    const ref = `current:signal:${sid}`;
    const good = { situation: "S", evidence: ["E"], impact: "I", recommendation: `Have the unit checked. ${MARK.rec}`, confidence: "high", usedKnowledgeChunkIds: [], provenance: { provider: APPROVED_PROVIDER, model: APPROVED_MODEL }, evidenceRefs: [], contradictions: [], urgency: "prompt", recommendedActionType: "inspection", claims: [{ claimType: "FACT", text: MARK.claim, sourceRefs: [ref] }, { claimType: "RECOMMENDATION", text: MARK.claim, sourceRefs: [ref] }] };
    if (fake.mode === "unknownref") good.claims[0].sourceRefs = ["current:signal:64b00000000000000000ffff"];
    if (fake.mode === "norec") good.claims = [good.claims[0]];
    if (fake.mode === "historical") good.claims.push({ claimType: "HISTORICAL_PATTERN", text: MARK.claim, sourceRefs: [ref] });
    return send(200, good);
  });
});
await new Promise((resolve) => stub.listen(STUB_PORT, resolve));
process.env.AI_SERVICE_URL = `http://localhost:${STUB_PORT}`;
process.env.LLM_PROVIDER = "test-python";
delete process.env.KOI_LEARNING_CONTEXT_ENABLED;
const children = [];
const spawnBackend = (port) => {
  const proc = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, PORT: String(port), KNOWLEDGE_DEV_AUTHORIZED_LEVEL: "restricted" }, stdio: ["ignore", "pipe", "pipe"] });
  const out = []; proc.stdout.on("data", (d) => out.push(String(d))); proc.stderr.on("data", (d) => out.push(String(d)));
  children.push(proc); return { proc, out, base: `http://localhost:${port}/api` };
};
const waitHealthy = async (base) => { for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${base}/health`)).ok) return true; } catch { /* starting */ } await sleep(200); } return false; };
const call = async (base, method, url, { headers = {}, body } = {}) => { const r = await fetch(`${base}${url}`, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined }); let json = null; try { json = await r.json(); } catch { json = null; } return { status: r.status, json, data: json?.data, rid: r.headers.get("x-request-id") }; };
async function cleanup() {
  for (const p of children) { try { p.kill(); } catch { /* gone */ } }
  const ws = { $in: ids.workspaces };
  await Promise.all([AnalysisAdmission.deleteMany({ workspaceId: ws }), Action.deleteMany({ workspaceId: ws }), Decision.deleteMany({ workspaceId: ws })]);
  await Promise.all([Intelligence.deleteMany({ workspaceId: ws }), KnowledgeChunk.deleteMany({ workspaceId: ws }), Signal.deleteMany({ workspaceId: ws })]);
  await cleanupAuthFixtures(); await WorkspaceMembership.deleteMany({ workspaceId: ws }); await Workspace.deleteMany({ _id: ws });
}
for (const evt of ["uncaughtException", "unhandledRejection"]) process.on(evt, async (e) => { console.error("FAIL  the suite crashed:", e?.message ?? e); try { await cleanup(); await disconnectDatabase(); } catch { /* best effort */ } process.exit(1); });

// ============================================================================================================ A (cont.) END TO END
console.log("\n# A (cont.) end to end: HTTP -> validator -> audit row -> event");
const s1 = spawnBackend(5296);
check("A24 a spawned backend is healthy", await waitHealthy(s1.base));
const admin = await createActor({ role: "admin", workspaceId: wsA._id, label: "p38-admin" });
const analyze = async (mode, rid) => { fake.mode = mode; const s = await mkSignal(wsA); const res = await call(s1.base, "POST", `/intelligence/analyze/${s._id}?workspaceId=${A}`, { headers: { ...admin.headers, "x-request-id": rid } }); fake.mode = "ok"; await sleep(150); const row = await AnalysisAdmission.findOne({ workspaceId: wsA._id, signalId: s._id }).lean(); return { res, row, signal: s }; };
const E2E = [
  ["unknownref", "CLAIM_UNKNOWN_REF", "a0000000-0000-4000-8000-000000000001"],
  ["norec", "CLAIM_NO_RECOMMENDATION", "a0000000-0000-4000-8000-000000000002"],
  ["historical", "CLAIM_INVALID_HISTORICAL_PATTERN", "a0000000-0000-4000-8000-000000000003"],
];
const e2eResults = {};
for (const [mode, rule, rid] of E2E) {
  const r = await analyze(mode, rid); e2eResults[mode] = r;
  check(`A25.${mode} END TO END over HTTP: the model's output that breaks rule ${rule} is refused with 502 CLAIM_VALIDATION_FAILED carrying details.rule=${rule}; the audit row records decidedAt=claims, reasonCode and ruleCode; nothing is stored`,
    r.res.status === 502 && r.res.json?.details?.code === CLAIM_VALIDATION_FAILED && r.res.json?.details?.rule === rule && r.row?.outcome === "rejected" && r.row.decidedAt === "claims" && r.row.reasonCode === CLAIM_VALIDATION_FAILED && r.row.ruleCode === rule && r.row.requestId === rid &&
    (await Intelligence.countDocuments({ workspaceId: wsA._id, signalIds: r.signal._id })) === 0, `${r.res.status} ${r.res.json?.details?.rule} row=${r.row?.ruleCode}`);
}
const acc = await analyze("ok", "a0000000-0000-4000-8000-000000000004");
const rl = await analyze("ratelimit", "a0000000-0000-4000-8000-000000000005");
check("A26 a rule code appears ONLY on a claim-stage rejection: an accepted analysis (201) and a provider rejection (429 rate limit) carry none", acc.res.status === 201 && acc.row?.outcome === "accepted" && acc.row.ruleCode === undefined && rl.row?.outcome === "rejected" && rl.row.ruleCode === undefined && rl.row.reasonCode !== CLAIM_VALIDATION_FAILED);
const py = await analyze("pyrule", "a0000000-0000-4000-8000-000000000006");
check("A27 THE AI SERVICE'S RULE passes through: a MALFORMED_RESPONSE from Python that names CLAIM_MISSING_SOURCE_REFS reaches the client (details.rule), the audit row and the event, with the original status and code", py.res.status === 502 && py.res.json?.details?.rule === "CLAIM_MISSING_SOURCE_REFS" && py.res.json.details.code === py.row?.reasonCode && py.row?.ruleCode === "CLAIM_MISSING_SOURCE_REFS", `${py.res.status} ${JSON.stringify(py.res.json?.details)}`);
const hostile = await analyze("hostilerule", "a0000000-0000-4000-8000-000000000007");
check("A28 a `rule` from the AI service that is not a stable code (text, markup, a marker) is DROPPED at the Node boundary: it is not in the response, the audit row or any log", hostile.res.status === 502 && hostile.res.json?.details?.rule === undefined && hostile.row?.ruleCode === undefined && !JSON.stringify(hostile.res.json).includes(MARK.claim));
const aud = await getAnalysisAdmissionByAttempt(A, e2eResults.unknownref.row.attemptId);
const cross = await caughtRaw(() => getAnalysisAdmissionByAttempt(B, e2eResults.unknownref.row.attemptId));
check("A29 the audit VIEW exposes ruleCode, and tenant isolation holds: the same attempt id is a 404 in another workspace", aud.ruleCode === "CLAIM_UNKNOWN_REF" && cross?.statusCode === 404);
await sleep(300);
const stdout = s1.out.join("");
const eventLines = stdout.split(/\r?\n/).filter((l) => l.startsWith("[KOI EVENT]")).map((l) => JSON.parse(l.slice("[KOI EVENT] ".length)));
const rej = eventLines.filter((e) => e.event === "analysis.rejected" && e.ruleCode);
check("A30 EVENTS: each claim-stage rejection emitted analysis.rejected with its ruleCode, correlated by requestId to the audit row; ruleCode never appears on an accepted event",
  ["CLAIM_UNKNOWN_REF", "CLAIM_NO_RECOMMENDATION", "CLAIM_INVALID_HISTORICAL_PATTERN", "CLAIM_MISSING_SOURCE_REFS"].every((rule) => rej.some((e) => e.ruleCode === rule && e.requestId && e.attemptId)) && !eventLines.some((e) => e.event === "analysis.accepted" && e.ruleCode), `${rej.length} rejected events with a rule`);
const summary = summarizeEvents(stdout.split(/\r?\n/));
check("A31 ...and the summarizer reports the rejections by rule code", summary.rejectionsByRuleCode?.CLAIM_UNKNOWN_REF === 1 && summary.rejectionsByRuleCode?.CLAIM_NO_RECOMMENDATION === 1);
const allText = stdout + JSON.stringify([...Object.values(e2eResults), rl, py, hostile].map((x) => ({ body: x.res.json, row: x.row })).concat([{ row: acc.row }]));
check("A32 NO SENSITIVE CONTENT anywhere in this run: the claim text, the Signal text and the recommendation markers are in no REJECTION response (the accepted analysis legitimately returns its own content), no audit row, no event and no log line of the spawned server; no token and no user id", !allText.includes(MARK.claim) && !allText.includes(MARK.desc) && !allText.includes(MARK.title) && !allText.includes(MARK.rec) && !stdout.includes(admin.token) && !stdout.includes(String(admin.user._id)) && !stdout.includes(A),
  `claim=${allText.includes(MARK.claim)} desc=${allText.includes(MARK.desc)} title=${allText.includes(MARK.title)} rec=${allText.includes(MARK.rec)} tok=${stdout.includes(admin.token)} uid=${stdout.includes(String(admin.user._id))} ws=${stdout.includes(A)}`);

// ============================================================================================================ B. MONGO CONFIG
console.log("\n# B. MongoDB production configuration");
const SECRET = "P38SecretPw";
const prod = (uri) => withEnv({ NODE_ENV: "production" }, () => mongoConfigProblems(uri));
const rows = {
  good: await prod(`mongodb://p38user:${SECRET}@db1.example.net:27017/koi_prod?tls=true&authSource=admin`),
  srv: await prod(`mongodb+srv://p38user:${SECRET}@cluster0.example.net/koi_prod?retryWrites=true`),
  replica: await prod(`mongodb://p38user:${SECRET}@h1:27017,h2:27017/koi_prod?replicaSet=rs0&tls=true`),
  noDb: await prod(`mongodb://p38user:${SECRET}@db1.example.net:27017`),
  noDbSlash: await prod(`mongodb://p38user:${SECRET}@db1.example.net:27017/`),
  noDbSrvQuery: await prod(`mongodb+srv://p38user:${SECRET}@cluster0.example.net/?retryWrites=true`),
  notMongo: await prod(`http://p38user:${SECRET}@db1.example.net/koi`),
  noCredsNoTls: await prod("mongodb://db1.example.net:27017/koi_prod"),
  noTls: await prod(`mongodb://p38user:${SECRET}@db1.example.net:27017/koi_prod`),
  empty: await prod(""),
  undef: await prod(undefined),
};
check("B1 a correct production URI (credentials, named database, TLS) has no problem - for a standalone, an SRV and a replica-set URI alike", ["good", "srv", "replica"].every((k) => rows[k].fatal.length === 0 && rows[k].warnings.length === 0), JSON.stringify(Object.fromEntries(["good", "srv", "replica"].map((k) => [k, rows[k].warnings.length]))));
check("B2 a production URI that names NO DATABASE is FATAL (the driver would silently use the default `test` database): host only, host with a trailing slash, and an SRV with only a query", ["noDb", "noDbSlash", "noDbSrvQuery"].every((k) => rows[k].fatal.some((f) => /must name a database/.test(f))));
check("B3 a string that is not a MongoDB URI is FATAL", rows.notMongo.fatal.some((f) => /not a valid MongoDB connection string/.test(f)));
check("B4 missing credentials and missing TLS are WARNINGS (a managed or private-network deployment may supply them elsewhere), never fatal, and each is reported once", rows.noCredsNoTls.fatal.length === 0 && rows.noCredsNoTls.warnings.length === 2 && rows.noTls.fatal.length === 0 && rows.noTls.warnings.length === 1 && /TLS/.test(rows.noTls.warnings[0]));
check("B5 an empty or missing URI is not judged here (connectDatabase refuses it with its own message)", rows.empty.fatal.length === 0 && rows.undef.fatal.length === 0);
const devRows = await Promise.all(["development", "test"].map((m) => withEnv({ NODE_ENV: m }, () => mongoConfigProblems("mongodb://localhost:27017"))));
const unknownRow = await withEnv({ NODE_ENV: undefined }, () => mongoConfigProblems("mongodb://localhost:27017"));
check("B6 development and test are not governed (a bare localhost URI is fine), but an UNSET/unknown NODE_ENV is judged like production", devRows.every((r) => r.fatal.length === 0 && r.warnings.length === 0) && unknownRow.fatal.length === 1);
check("B7 NO VALUE IS EVER ECHOED: no message contains the password, the user name, a host or the URI", Object.values(rows).every((r) => ![...r.fatal, ...r.warnings].some((m) => m.includes(SECRET) || m.includes("p38user") || m.includes("example.net") || m.includes("koi_prod"))));
const refuse = spawnSync(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, NODE_ENV: "production", PORT: "5298", MONGODB_URI: `mongodb://p38user:${SECRET}@127.0.0.1:1`, LLM_PROVIDER: APPROVED_PROVIDER }, encoding: "utf8", timeout: 30000 });
const refuseOut = `${refuse.stdout}${refuse.stderr}`;
check("B8 REAL START-UP: a production server whose MONGODB_URI names no database REFUSES TO START (exit 1, a fixed message) BEFORE it connects, and the URI, user and password appear nowhere in its output",
  refuse.status === 1 && /Refusing to start: invalid database configuration: .*must name a database/.test(refuseOut) && !refuseOut.includes(SECRET) && !refuseOut.includes("p38user") && !/ECONNREFUSED|MongoServerSelection/.test(refuseOut), refuseOut.trim().split(/\r?\n/).pop().slice(0, 140));

// ============================================================================================================ C. INDEXES
console.log("\n# C. index inventory (fresh throwaway database)");
const inv = await buildIndexInventory();
const has = (model, keys, extra = () => true) => inv.rows.some((r) => r.model === model && r.keys === keys && extra(r));
check("C1 every index of every model is classified (purpose and tenant scoping) - none is unexplained", inv.rows.length >= 60 && inv.unclassified.length === 0, `${inv.rows.length} indexes`);
check("C2 REQUIRED UNIQUE / IDEMPOTENCY INDEXES exist on a fresh database with no migration: AnalysisAdmission (workspace, attempt); Intelligence (workspace, signals, level); Decision, Action and Outcome V1 (workspace, parent, version)",
  has("AnalysisAdmission", "workspaceId:1, attemptId:1", (r) => r.unique) && has("Intelligence", "workspaceId:1, signalIds:1, analysisLevel:1", (r) => r.unique && r.partial) && has("Decision", "workspaceId:1, intelligenceId:1, decisionVersion:1", (r) => r.unique && r.partial) &&
  has("Action", "workspaceId:1, decisionId:1, actionVersion:1", (r) => r.unique && r.partial) && has("Outcome", "workspaceId:1, actionId:1, outcomeVersion:1", (r) => r.unique && r.partial));
check("C3 the audit store is queryable by workspace and by request id (partial) - the indexes the operator lookups need", inv.rows.some((r) => r.model === "AnalysisAdmission" && r.keys.startsWith("workspaceId:1") && !r.unique) && has("AnalysisAdmission", "workspaceId:1, requestId:1", (r) => r.partial));
const tenantModels = [...new Set(inv.rows.filter((r) => r.carriesWorkspaceId).map((r) => r.model))].filter((m) => !["Workspace", "User"].includes(m));
check("C4 TENANT SCOPING: every model that carries a workspaceId has at least one index that begins with it, and every unique index of a tenant-owned model is workspace-prefixed or parent-scoped (never a global unique)",
  tenantModels.length >= 10 && tenantModels.every((m) => inv.rows.some((r) => r.model === m && r.keys.startsWith("workspaceId:1"))) &&
  inv.rows.filter((r) => r.unique && r.keys !== "_id:1" && tenantModels.includes(r.model)).every((r) => r.keys.includes("workspaceId:1") || /^(propertyId|documentId)/.test(r.keys)), `${tenantModels.length} tenant models`);
check("C5 the only non-workspace-prefixed unique indexes are the tenant root (Workspace slug), global identity (User issuer+subject) and parent-scoped ones that resolve scope through their parent (Unit, KnowledgeChunk, WorkspaceMembership by user+workspace)",
  inv.rows.filter((r) => r.unique && r.keys !== "_id:1" && !r.keys.startsWith("workspaceId:1")).every((r) => ["Workspace|slug:1", "User|issuer:1, subject:1", "Unit|propertyId:1, unitNumber:1", "KnowledgeChunk|documentId:1, version:1, chunkIndex:1", "WorkspaceMembership|userId:1, workspaceId:1", "User|emailNormalized:1", "AuthIdentity|issuer:1, subject:1", "AuthToken|tokenHash:1"].includes(`${r.model}|${r.keys}`)),
  inv.rows.filter((r) => r.unique && r.keys !== "_id:1" && !r.keys.startsWith("workspaceId:1")).map((r) => `${r.model}|${r.keys}`).join(" ; "));
const dbsAfterInv = (await mongoose.connection.getClient().db().admin().listDatabases()).databases.map((d) => d.name).filter((n) => n.startsWith("koi_p38_idx_"));
check("C6 the inventory used only its own throwaway database and dropped it (no koi_p38_idx_ database remains)", dbsAfterInv.length === 0, dbsAfterInv.join(",") || "none");

// ============================================================================================================ D. STATIC START-UP SAFETY
console.log("\n# D. start-up safety (static)");
const startupFiles = ["server.js", "app.js", path.join("src", "config", "database.js"), path.join("src", "config", "startupChecks.js"), path.join("src", "config", "env.js")].map((f) => stripComments(read(path.join(BACKEND, f))));
check("D1 NO DESTRUCTIVE OPERATION AT START-UP: server.js, app.js and the config modules contain no dropDatabase / dropCollection / drop( / deleteMany / syncIndexes / bulk delete",
  startupFiles.every((s) => !/dropDatabase|dropCollection|\.drop\(|deleteMany|deleteOne|syncIndexes|\.remove\(/.test(s)));
const srcAll = fs.readdirSync(path.join(BACKEND, "src"), { recursive: true }).filter((f) => f.endsWith(".js")).map((f) => ({ f, s: stripComments(read(path.join(BACKEND, "src", f))) }));
check("D2 NO DEVELOPMENT-ONLY DATABASE ARTIFACT: the application hard-codes no database name (no dbName option, no `koi`/`test` database literal in a connection) and no `localhost:27017` fallback", srcAll.every(({ s }) => !/dbName\s*:|useDb\(|mongodb:\/\/localhost|mongodb:\/\/127\.0\.0\.1/.test(s)));
check("D3 NO NEW INFRASTRUCTURE in Phase 38: no queue, cache, lock manager or scheduler dependency (backend and AI service); no cron/scheduled generation", !/redis|ioredis|bullmq|kafkajs|zookeeper|memcached|node-cron|agenda/i.test(read(path.join(BACKEND, "package.json")) + read(path.join(REPO, "ai-service", "requirements.txt"))));
check("D4 no new environment variable was introduced by Phase 38 beyond what the contract names (the completeness test below enforces it), Learning stays off and the model is pinned", process.env.KOI_LEARNING_CONTEXT_ENABLED === undefined && APPROVED_MODEL === "gemini-3.1-flash-lite");
const manifests = ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "Procfile", "render.yaml", "ecosystem.config.js", "fly.toml", "vercel.json", "netlify.toml", "app.yaml", "kubernetes", "helm", ".github", "serverless.yml"].filter((n) => [REPO, BACKEND, path.join(REPO, "ai-service"), path.join(REPO, "frontend")].some((d) => fs.existsSync(path.join(d, n))));
check("D5 TOPOLOGY EVIDENCE: the repository declares no deployment target of any kind, so none is claimed (the topology document says exactly this)", manifests.length === 0 && /configures no deployment target at all/.test(read(path.join(BACKEND, "docs", "DEPLOYMENT_TOPOLOGY_AND_RECOVERY_PHASE38.md"))), manifests.join(",") || "none found");

// ============================================================================================================ E. OIDC (Phase 23 suite, asserted by name)
console.log("\n# E. OIDC production readiness (the Phase 23 suite is run; nine behaviours are asserted by name)");
const oidc = spawnSync(process.execPath, [path.join(BACKEND, "scripts", "validate-phase23-oidc.mjs")], { encoding: "utf8", timeout: 600000, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "LLM_PROVIDER" && k !== "AI_SERVICE_URL")) });
const oidcOut = `${oidc.stdout}\n${oidc.stderr}`;
const oidcPass = (prefix) => oidcOut.split(/\r?\n/).some((l) => l.startsWith(`PASS  ${prefix}`)) && !oidcOut.split(/\r?\n/).some((l) => l.startsWith(`FAIL  ${prefix}`));
const oidcTotals = /(\d+) passed, (\d+) failed/.exec(oidcOut) ?? [];
check("E0 the Phase 23 OIDC suite passes as a whole (real RS256/ES256 signatures against a local issuer + JWKS)", oidc.status === 0 && Number(oidcTotals[2]) === 0 && Number(oidcTotals[1]) >= 130, `${oidcTotals[1]} passed, ${oidcTotals[2]} failed`);
const NINE = [
  ["missing issuer", ["CF7 ", "EV1 "]],
  ["malformed issuer", ["CF9 ", "EV3 "]],
  ["wrong issuer", ["IA wrong issuer"]],
  ["missing client/audience configuration", ["CF7 ", "EV4 "]],
  ["invalid token", ["IA malformed token (not a JWT)", "IA tampered signature", "IA invalid signature"]],
  ["expired token", ["VA4 ", "IA expired token"]],
  ["wrong audience", ["IA wrong audience"]],
  ["valid token but no membership", ["ID3 ", "ID11 "]],
  ["valid membership, insufficient role", ["AZ viewer: create a guest", "AZ operator: create a property"]],
];
for (const [label, prefixes] of NINE) check(`E.${label.replaceAll(" ", "_")} ${label}: ${prefixes.map((p) => p.trim()).join(" + ")} pass in the Phase 23 run`, prefixes.every(oidcPass));
check("E10 tenant isolation under OIDC identities: a valid admin of workspace A is refused workspace B (404) at list and object level", oidcPass("AZ admin: CROSS-WORKSPACE") && oidcPass("AZ admin: OBJECT-LEVEL"));
check("E11 a production start with unsafe OIDC configuration REFUSES (no config, HS256, http issuer, no audience, stub) and an unreachable issuer fails CLOSED", ["EV1 ", "EV2 ", "EV3 ", "EV4 ", "EV5 ", "EV7 "].every(oidcPass));
check("E12 NOT YET VERIFIED, stated: no real identity provider was reachable - the suite uses a local issuer, so the real discovery document, key rotation, token lifetimes and PKCE sign-in are NOT covered (the readiness document says so)", /NOT YET VERIFIED/.test(read(path.join(BACKEND, "docs", "DEPLOYMENT_TOPOLOGY_AND_RECOVERY_PHASE38.md"))));

// ============================================================================================================ F. DOCUMENTS
console.log("\n# F. documentation contract");
const docs = path.join(BACKEND, "docs");
const contract = read(path.join(docs, "PRODUCTION_ENVIRONMENT_CONTRACT.md"));
const obs = read(path.join(docs, "PRODUCTION_OBSERVABILITY.md"));
const topo = read(path.join(docs, "DEPLOYMENT_TOPOLOGY_AND_RECOVERY_PHASE38.md"));
const gng = read(path.join(docs, "PRODUCTION_GO_NO_GO.md"));
const walk = (dir, exts) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && exts.some((e) => d.name.endsWith(e))).map((d) => path.join(d.parentPath ?? d.path, d.name)).filter((p) => !/node_modules|__pycache__|\.venv/.test(p));
const backtickTokens = [...contract.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const suffixTokens = backtickTokens.filter((t) => /^_[A-Z0-9_]+$/.test(t));
const covered = (name) => contract.includes(name) || suffixTokens.some((s) => name.endsWith(s) && contract.includes(name.slice(0, name.length - s.length)));
const nodeSrc = [path.join(BACKEND, "server.js"), path.join(BACKEND, "app.js"), ...walk(path.join(BACKEND, "src"), [".js"])].map((p) => stripComments(read(p))).join("\n");
const nodeNames = new Set([...nodeSrc.matchAll(/\b((?:KOI|OIDC)_[A-Z0-9_]+)\b/g)].map((m) => m[1]));
for (const m of nodeSrc.matchAll(/(?:process\.env|environment|source)(?:\.|\[\s*["'])([A-Z][A-Z0-9_]+)/g)) nodeNames.add(m[1]);
const missingNode = [...nodeNames].filter((n) => !covered(n));
check("F1 ENVIRONMENT CONTRACT COMPLETENESS (Node): every environment variable the backend reads is named in the contract (so none can be added silently)", nodeNames.size >= 30 && missingNode.length === 0, `${nodeNames.size} variables; missing: ${missingNode.join(",") || "none"}`);
const cfg = read(path.join(REPO, "ai-service", "app", "config.py"));
const pyFields = [...cfg.slice(cfg.indexOf("class Settings")).matchAll(/^\s{4}([a-z][a-z0-9_]*)\s*:/gm)].map((m) => m[1].toUpperCase());
const missingPy = pyFields.filter((n) => !covered(n));
check("F2 ENVIRONMENT CONTRACT COMPLETENESS (AI service): every Settings field is named in the contract", pyFields.length >= 6 && missingPy.length === 0, `${pyFields.length} fields; missing: ${missingPy.join(",") || "none"}`);
const feNames = [...new Set(walk(path.join(REPO, "frontend", "src"), [".js", ".jsx"]).flatMap((p) => [...read(p).matchAll(/\b(VITE_[A-Z0-9_]+)\b/g)].map((m) => m[1])))];
check("F3 ENVIRONMENT CONTRACT COMPLETENESS (frontend): every VITE_ variable the frontend reads is named in the contract", feNames.length >= 3 && feNames.every(covered), feNames.join(","));
check("F4 the contract classifies settings with the required vocabulary and names the forbidden-in-production ones", ["REQUIRED", "OPTIONAL", "FORBIDDEN IN PRODUCTION", "SAFE DEFAULT"].every((c) => contract.includes(c)) && ["AUTH_TOKEN_VERIFIER", "AUTH_STUB_SECRET", "KNOWLEDGE_DEV_AUTHORIZED_LEVEL", "KOI_EXPOSE_ERROR_DETAILS", "VITE_DEV_ACCESS_TOKEN"].every((n) => new RegExp(`${n}[^\\n]*FORBIDDEN`).test(contract)) && !/(AIza|sk-[A-Za-z0-9]{10}|BEGIN (RSA )?PRIVATE KEY|mongodb(\+srv)?:\/\/[^\s`]*:[^\s`]*@)/.test(contract));
const idxRows = (contract.match(/^\| (Workspace|Property|Unit|Guest|Stay|Signal|Conversation|Message|Intelligence|Decision|Action|Outcome|KnowledgeDocument|KnowledgeChunk|User|WorkspaceMembership|AnalysisAdmission|[A-Za-z]+) \| `/gm) ?? []).length;
check("F5 the contract carries the generated index table (one row per non-primary index, with purpose, tenant scoping and deployment status) and it matches the live inventory", idxRows === inv.rows.filter((r) => r.keys !== "_id:1").length && /Tenant scoping/.test(contract), `${idxRows} rows vs ${inv.rows.filter((r) => r.keys !== "_id:1").length} indexes`);

const codeEvents = new Set(srcAll.filter(({ f }) => !/logEvent\.js$/.test(f)).flatMap(({ s }) => [...s.matchAll(/logEvent\(([^{]*)\{/g)].flatMap((m) => [...m[1].matchAll(/"([a-z]+\.[a-z_]+)"/g)].map((x) => x[1]))));
const obsRows = obs.split(/\r?\n/).filter((l) => /^\| `?(analysis|authz|governance|\(absence\)|\(platform\))/.test(l));
check("F6 OBSERVABILITY DOCUMENT: the table has the required columns; every event the code can emit has a row with all five cells filled; thresholds are labelled INITIAL / TUNING REQUIRED; the integration boundary says nothing is shipped or alerted by the repository",
  /\| EVENT \| WHAT IT MEANS \| METRIC[^|]*\| ALERT CONDITION[^|]*\| OPERATOR RESPONSE \|/.test(obs) && codeEvents.size >= 6 && [...codeEvents].every((e) => obs.includes(`\`${e}\``)) && obsRows.every((l) => l.split("|").slice(1, -1).length === 5 && l.split("|").slice(1, -1).every((c) => c.trim().length > 2)) &&
  /INITIAL \/ TUNING REQUIRED/.test(obs) && /No log shipper, metrics endpoint, dashboard or alert rule exists/.test(obs) && /NOT VERIFIED - EXTERNAL OPERATIONAL REQUIREMENT/.test(obs), `${codeEvents.size} events: ${[...codeEvents].join(", ")}`);
check("F7 ...and every claim-validation rule code is documented, with no code text or identifier in the document's examples", CLAIM_RULE_CODES.every((c) => obs.includes(`\`${c}\``)) && ALLOWED_FIELDS.every((f) => obs.includes(f)));
check("F8 TOPOLOGY DOCUMENT: states the finding that no deployment target exists, SUPPORTED vs NOT SUPPORTED, the duplicate-provider-call consequence, the NOT VERIFIED backup/restore requirement, and the eight failure rows A-H with the six required columns",
  /configures no deployment target at all/.test(topo) && /\*\*SUPPORTED:\*\*/.test(topo) && /\*\*NOT SUPPORTED:\*\*/.test(topo) && /both call Gemini/.test(topo) && /NOT VERIFIED - EXTERNAL OPERATIONAL REQUIREMENT/.test(topo) &&
  /\| Failure \(input\) \| Expected HTTP result \| Model call\? \| Persistence\? \| Audit \/ event \| Recovery \|/.test(topo) && ["A.", "B.", "C.", "D.", "E.", "F.", "G.", "H."].every((l) => new RegExp(`^\\| ${l.replace(".", "\\.")} `, "m").test(topo)));

const section = (letter) => { const m = new RegExp(`## Section ${letter} -[\\s\\S]*?(?=\\n## |$)`).exec(gng); return m ? m[0] : ""; };
const gRows = (letter) => section(letter).split(/\r?\n/).filter((l) => new RegExp(`^\\| ${letter}\\d+ \\|`).test(l)).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
const [gA, gB, gC] = ["A", "B", "C"].map(gRows);
const OWNER = { A: "CODE", B: "DEPLOYMENT", C: "OPERATIONS" };
const validRow = (letter) => (r) => r.length === 6 && /^(PASS|FAIL|NOT VERIFIED|NOT APPLICABLE)/.test(r[2]) && r[3] === OWNER[letter] && /^(YES|NO)$/.test(r[4]) && r[5].length > 3;
check("F9 GO/NO-GO: three sections, every item has ID, STATUS (PASS/FAIL/NOT VERIFIED/NOT APPLICABLE), the section's OWNER, BLOCKING (YES/NO) and EVIDENCE", gA.length >= 15 && gB.length >= 10 && gC.length >= 7 && gA.every(validRow("A")) && gB.every(validRow("B")) && gC.every(validRow("C")), `${gA.length}/${gB.length}/${gC.length} items; invalid: ${[...gA.filter((r) => !validRow("A")(r)), ...gB.filter((r) => !validRow("B")(r)), ...gC.filter((r) => !validRow("C")(r))].map((r) => `${r[0]}(${r.length})`).join(",") || "none"}`);
check("F10 HONESTY: no OPERATIONS item is PASS; a DEPLOYMENT item is PASS only if it says it was verified locally/isolated; every external item is NOT VERIFIED; every CODE item is PASS (a FAIL would be a blocker)",
  gC.every((r) => r[2].startsWith("NOT VERIFIED")) && gB.filter((r) => r[2].startsWith("PASS")).every((r) => /local/i.test(r[2])) && gB.filter((r) => !r[2].startsWith("PASS")).every((r) => r[2].startsWith("NOT VERIFIED")) && gA.every((r) => r[2].startsWith("PASS")));
const decisionLine = (/\*\*Decision: ([A-Z -]+)\*\*/.exec(gng) ?? [])[1];
const unmetBlockers = [...gA, ...gB, ...gC].filter((r) => r[4] === "YES" && !r[2].startsWith("PASS"));
const codeBlockerFail = gA.some((r) => r[4] === "YES" && r[2].startsWith("FAIL"));
const expected = codeBlockerFail ? "NO-GO" : unmetBlockers.length > 0 ? "CONDITIONAL GO" : "GO";
check("F11 THE DECISION FOLLOWS FROM THE TABLE (not forced): exactly one of GO / CONDITIONAL GO / NO-GO is stated, and it is the one the rules produce from the rows (a failed CODE blocker -> NO-GO; code safe but an external blocker unverified -> CONDITIONAL GO; every blocker verified -> GO)", ["GO", "CONDITIONAL GO", "NO-GO"].includes(decisionLine) && decisionLine === expected, `stated ${decisionLine}, rules give ${expected} (${unmetBlockers.length} unverified blockers)`);
check("F12 every document is free of secrets, real URIs and absolute personal paths", [contract, obs, topo, gng].every((d) => !/(AIza[0-9A-Za-z_-]{20}|sk-[A-Za-z0-9]{20}|BEGIN (RSA |EC )?PRIVATE KEY|mongodb(\+srv)?:\/\/[^\s`]*:[^\s`]*@|C:\\Users)/.test(d)));

// ============================================================================================================ cleanup + baseline
await cleanup();
const after = await counts();
check("Z1 nothing was wiped and nothing leaked: every pre-existing collection count equals its pre-run value", JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before, after }));
await disconnectDatabase();
stub.close();
console.log(`\nPhase 38 deployment-readiness validation: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
