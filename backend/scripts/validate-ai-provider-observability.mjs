/**
 * AI provider observability + single-503-retry - Node side (the Python side, including the retry itself, is ai-service/tests/test_provider_observability.py).
 *
 * LOCAL ONLY: zero Gemini calls, zero external network (a loopback HTTP server stands in for the AI service), an ISOLATED local MongoDB database that is
 * dropped at the end (the Atlas URI is never used: MONGODB_URI is overwritten before anything connects). The backend under test is spawned as a child
 * process with stub authentication (the same pattern the other HTTP suites use).
 *
 * What it proves, end to end through the real Node request path:
 *   A. the request id Node's middleware generated reaches the AI service in `X-KOI-Request-Id` on the analysis call (and only a canonical uuid is ever sent);
 *   B. different requests carry different ids; a caller-supplied canonical uuid is honoured, a hostile one is replaced; the same id is the one on Node's own events;
 *   C. Node itself never retries: one AI-service request per analysis even when the service answers PROVIDER_UNAVAILABLE / PROVIDER_TIMEOUT;
 *   D. the public error behaviour is unchanged (same statuses, codes and safe messages), and persistence is unchanged (a failed analysis stores nothing and
 *      leaves exactly one rejected audit row per attempt; no Decision / Action / Outcome);
 *   E. nothing sensitive reaches the AI service in the new header or the logs, the request body is byte-for-byte the pre-change shape (no `learning`), Learning stays
 *      OFF; the safety policy, timeout values and event allow-list are unchanged.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const REPO = path.join(BACKEND, "..");
const DB_NAME = `koi_obs_${Date.now()}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${DB_NAME}`; // the isolated local database; never Atlas
const { createActor } = await import("./lib/authFixtures.mjs"); // sets NODE_ENV=test, the stub verifier and a suite secret (children inherit them)
delete process.env.KOI_LEARNING_CONTEXT_ENABLED;
const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../src/config/database.js");
const M = await import("../src/models/index.js");
const { deriveSafetyPolicy } = await import("../src/services/ai/safetyPolicy.js");
const { getAiAnalysisTimeoutMs, getAiTimeoutMs, getLearningContextEnabled, AI_PROVIDER_TIMEOUT_CEILING_MS } = await import("../src/config/runtimeConfig.js");
const { ALLOWED_FIELDS } = await import("../src/utils/logEvent.js");
const { requestAnalysisFromAiService, requestEmbeddingsFromAiService } = await import("../src/services/ai/aiServiceClient.js");

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); }
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the stand-in AI service -------------------------------------------------------------------------------------------------------------------
const seen = []; // one record per request the stub received
let mode = "unavailable";
const stub = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* none */ }
    seen.push({ path: req.url, headers: { ...req.headers }, body });
    const [status, code] = mode === "timeout" ? [504, "PROVIDER_TIMEOUT"] : [503, "PROVIDER_UNAVAILABLE"];
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code, message: "stub" } }));
  });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const STUB_URL = `http://127.0.0.1:${stub.address().port}`;

const withEnv = async (patch, fn) => {
  const before = {};
  for (const [k, v] of Object.entries(patch)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const quiet = async (fn) => { const orig = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = orig; } };

// ---- A. the client sends the id, and only a canonical uuid ------------------------------------------------------------------------------------
const CTX = { signal: { id: "s" } };
const HIST = { intelligence: [], decisions: [] };
await withEnv({ AI_SERVICE_URL: STUB_URL, AI_SERVICE_TOKEN: "stub-token-not-a-secret" }, async () => {
  const ID = "6f1c9a42-3b7e-4d0a-9c55-0a1b2c3d4e5f";
  seen.length = 0;
  await quiet(() => requestAnalysisFromAiService(CTX, [], "staff", HIST, undefined, { requestId: ID.toUpperCase() })).catch(() => {});
  check("A1 the analysis call sends the request id in X-KOI-Request-Id (lower-cased)", seen[0]?.headers["x-koi-request-id"] === ID, String(seen[0]?.headers["x-koi-request-id"]));
  check("A2 the existing headers are unchanged (content type and the service token are still sent)", seen[0]?.headers["content-type"] === "application/json" && seen[0]?.headers["x-koi-service-token"] === "stub-token-not-a-secret");
  for (const [label, value] of [["a non-uuid string", "not-a-uuid"], ["a workspace-id-shaped value", "507f1f77bcf86cd799439011"], ["a log-forging string", "x\r\n[KOI EVENT] {}"], ["undefined", undefined], ["a number", 7]]) {
    seen.length = 0;
    await quiet(() => requestAnalysisFromAiService(CTX, [], "staff", HIST, undefined, { requestId: value })).catch(() => {});
    check(`A3 ${label} is never sent as the request id`, seen.length === 1 && seen[0].headers["x-koi-request-id"] === undefined);
  }
  seen.length = 0;
  await quiet(() => requestAnalysisFromAiService(CTX, [], "staff", HIST)).catch(() => {});
  check("A4 a call without options still works and sends no id (backward compatible)", seen.length === 1 && seen[0].headers["x-koi-request-id"] === undefined);
  seen.length = 0;
  await quiet(() => requestEmbeddingsFromAiService(["x"])).catch(() => {});
  check("A5 the id is scoped to the analysis call: an embeddings call is unchanged", seen.length === 1 && seen[0].headers["x-koi-request-id"] === undefined);
  const body = (seen.length = 0, await quiet(() => requestAnalysisFromAiService(CTX, [], "staff", HIST, undefined, { requestId: ID })).catch(() => {}), seen[0]?.body);
  check("A6 the request BODY is byte-for-byte the pre-change shape: no id, no learning key", Object.keys(body ?? {}).sort().join(",") === "authorizedLevel,context,knowledge,operationalHistory" && !JSON.stringify(body).includes(ID));
});

// ---- B-D. the full request path through a real backend process ------------------------------------------------------------------------------------
const PORT = 5350;
const BASE = `http://localhost:${PORT}/api`;
const logDir = fs.mkdtempSync(path.join(process.env.TEMP ?? process.env.TMP ?? ".", "koi-obs-"));
const logPath = path.join(logDir, "backend.log");
const out = fs.openSync(logPath, "w");
const child = spawn(process.execPath, [path.join(BACKEND, "server.js")], {
  env: { ...process.env, PORT: String(PORT), LLM_PROVIDER: "gemini", AI_SERVICE_URL: STUB_URL, AI_SERVICE_TOKEN: "stub-token-not-a-secret", KOI_RATE_LIMIT_ENABLED: "false", CLIENT_URL: "http://localhost:5199" },
  stdio: ["ignore", out, out],
});
const call = async (method, url, who, body, headers = {}) => {
  const res = await fetch(`${BASE}${url}`, { method, headers: { ...who.headers, ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* none */ }
  return { status: res.status, json, code: json?.details?.code, requestId: res.headers.get("x-request-id") };
};
try {
  await connectDatabase();
  if (mongoose.connection.db.databaseName !== DB_NAME) throw new Error("refusing to run: not the isolated database");
  for (let i = 0; i < 160; i += 1) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* starting */ } await sleep(250); }
  const ws = await M.Workspace.create({ name: "Obs", slug: `obs-${Date.now()}`, status: "active" });
  const op = await createActor({ role: "operator", workspaceId: ws._id, label: "obs-op" });
  const wid = String(ws._id);
  const mkSignal = async (title) => (await call("POST", "/signals", op, { workspaceId: wid, type: "maintenance", title, description: `${title} (synthetic, for the observability suite)` })).json?.data?._id;
  const [s1, s2, s3, s4, s5] = [await mkSignal("Obs A"), await mkSignal("Obs B"), await mkSignal("Obs C"), await mkSignal("Obs D"), await mkSignal("Obs E")];
  const analyze = (signal, headers) => call("POST", `/intelligence/analyze/${signal}?workspaceId=${wid}`, op, undefined, headers);

  seen.length = 0;
  mode = "unavailable";
  const r1 = await analyze(s1);
  const r2 = await analyze(s2);
  const CALLER_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const r3 = await analyze(s3, { "X-Request-Id": CALLER_ID });
  const r4 = await analyze(s4, { "X-Request-Id": "workspace-507f1f77bcf86cd799439011" });
  mode = "timeout";
  const r5 = await analyze(s5);
  await sleep(500);
  const analysisCalls = seen.filter((s) => s.path === "/v1/intelligence/analyze");

  check("B1 every analysis response carries a uuid request id", [r1, r2, r3, r4, r5].every((r) => UUID.test(r.requestId ?? "")));
  check("B2 different requests received different ids", new Set([r1, r2, r4, r5].map((r) => r.requestId)).size === 4);
  check("B3 the id Node generated is the id the AI service received (same value, every request)", analysisCalls.length === 5 && [r1, r2, r3, r4, r5].every((r, i) => analysisCalls[i]?.headers["x-koi-request-id"] === r.requestId));
  check("B4 a caller-supplied canonical uuid is honoured end to end", r3.requestId === CALLER_ID && analysisCalls[2]?.headers["x-koi-request-id"] === CALLER_ID);
  check("B5 a hostile caller-supplied id is replaced by a generated uuid (and that one is forwarded)", UUID.test(r4.requestId) && r4.requestId !== "workspace-507f1f77bcf86cd799439011" && analysisCalls[3]?.headers["x-koi-request-id"] === r4.requestId);

  const log = fs.readFileSync(logPath, "utf8");
  const events = log.split(/\r?\n/).filter((l) => l.includes("[KOI EVENT]")).map((l) => { try { return JSON.parse(l.slice(l.indexOf("{"))); } catch { return null; } }).filter(Boolean);
  const rejected = events.filter((e) => e.event === "analysis.rejected");
  check("B6 Node's own analysis.rejected event carries the SAME id the AI service received (the two log streams join on it)", rejected.length === 5 && [r1, r2, r3, r4, r5].every((r) => rejected.some((e) => e.requestId === r.requestId)));

  check("C1 Node never retries: exactly one AI-service analysis request per analysis (5 analyses, 5 requests; 503 and 504 answers alike)", analysisCalls.length === 5);
  check("D1 the public error behaviour is unchanged: PROVIDER_UNAVAILABLE -> 502, PROVIDER_TIMEOUT -> 504, with the same safe messages",
    [r1, r2, r3, r4].every((r) => r.status === 502 && r.code === "PROVIDER_UNAVAILABLE" && r.json.message === "AI intelligence service is temporarily unavailable.") && r5.status === 504 && r5.code === "PROVIDER_TIMEOUT" && r5.json.message === "AI intelligence service timed out. Try again.");
  check("D2 the response bodies carry no provider text and no request id field (the id travels in the header only)", [r1, r2, r3, r4, r5].every((r) => !JSON.stringify(r.json).includes("stub") && !JSON.stringify(r.json).includes(r.requestId)));
  const wsId = ws._id;
  const counts = { intelligence: await M.Intelligence.countDocuments({ workspaceId: wsId }), admissions: await M.AnalysisAdmission.countDocuments({ workspaceId: wsId }), rejected: await M.AnalysisAdmission.countDocuments({ workspaceId: wsId, outcome: "rejected" }), decisions: await M.Decision.countDocuments({ workspaceId: wsId }), actions: await M.Action.countDocuments({ workspaceId: wsId }), outcomes: await M.Outcome.countDocuments({ workspaceId: wsId }) };
  check("D3 persistence is unchanged: nothing stored on failure, one rejected audit row per attempt, no Decision / Action / Outcome", counts.intelligence === 0 && counts.admissions === 5 && counts.rejected === 5 && counts.decisions === 0 && counts.actions === 0 && counts.outcomes === 0, JSON.stringify(counts));
  const rows = await M.AnalysisAdmission.find({ workspaceId: wsId }).lean();
  check("D4 the audit rows record the same failure classes as before (provider_unavailable x4, provider_timeout x1) and keep the Node requestId", rows.filter((r) => r.failureClass === "provider_unavailable").length === 4 && rows.filter((r) => r.failureClass === "provider_timeout").length === 1 && rows.every((r) => UUID.test(r.requestId ?? "")));
  check("D5 a repeat call on a failed Signal is a fresh single attempt (idempotency unchanged: still nothing stored, still exactly one AI request)", await (async () => { seen.length = 0; mode = "unavailable"; const r = await analyze(s1); await sleep(200); return r.status === 502 && seen.filter((s) => s.path === "/v1/intelligence/analyze").length === 1 && (await M.Intelligence.countDocuments({ workspaceId: wsId })) === 0; })());

  // ---- E. nothing sensitive; nothing else changed ---------------------------------------------------------------------------------------------------------
  const sensitive = ["stub-token-not-a-secret", "Bearer", "mongodb://", op.token];
  check("E1 the Node logs contain no token, bearer string, Mongo URI or service credential", sensitive.every((s) => !log.includes(s)));
  check("E2 the new header carries only a uuid: no workspace id, Signal id, user id or content", analysisCalls.every((c) => UUID.test(c.headers["x-koi-request-id"]) && ![wid, s1, s2, String(op.user._id)].some((id) => c.headers["x-koi-request-id"].includes(id))));
  check("E3 the request body sent to the AI service has no `learning` key on any call (Learning OFF) and the flag reads false", analysisCalls.every((c) => !("learning" in (c.body ?? {}))) && getLearningContextEnabled() === false && process.env.KOI_LEARNING_CONTEXT_ENABLED === undefined);
  check("E4 timeouts: base 20 s (retrieval/embedding per call), embedding-side ceiling 20 s - unchanged by Workstream 1; (Workstream 5C) the Node analysis wait is its own setting: 65 s = the 60 s analysis ceiling + 5 s", getAiTimeoutMs() === 20000 && getAiAnalysisTimeoutMs() === 65000 && AI_PROVIDER_TIMEOUT_CEILING_MS === 20000);
  const policy = (title, description, severity = "medium") => deriveSafetyPolicy({ signal: { title, description, severity } });
  check("E5 the safety policy is unchanged: gas / smoke / CO -> LIFE_SAFETY_HAZARD (escalation or dispatch, immediate); access refusal forbids dispatch; sparks stay NORMAL (the known gap, untouched); AC -> NORMAL",
    policy("Room 1", "strong gas smell").state === "LIFE_SAFETY_HAZARD" && policy("Room 2", "smoke from the vent").state === "LIFE_SAFETY_HAZARD" && policy("Room 3", "carbon monoxide alarm is sounding").state === "LIFE_SAFETY_HAZARD"
    && policy("Room 1", "gas smell, guest refuses entry").forbiddenActionTypes.includes("maintenance_dispatch") && policy("Room 1", "gas smell").minimumUrgency === "immediate"
    && policy("Room 4", "sparks and a burning smell from the wall socket").state === "NORMAL" && policy("Room 5", "the AC is not cooling").state === "NORMAL");
  check("E6 the structured-event allow-list is unchanged (requestId already existed; no sensitive field was added)", !ALLOWED_FIELDS.some((f) => /prompt|output|text|header|token|secret|password|key|workspace|guest|signal|user/i.test(f)) && ALLOWED_FIELDS.includes("requestId"));
  const clientSrc = fs.readFileSync(path.join(BACKEND, "src", "services", "ai", "aiServiceClient.js"), "utf8");
  check("E7 the Node client has no retry loop of its own (no for/while around the fetch, no retry or backoff identifier)", !/\bretry\b|\bretries\b|backoff|attempts\s*[<=>]/i.test(clientSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\/\/ .*$/gm, "")) && !/\bwhile\s*\(|\bfor\s*\(/.test(clientSrc));
} catch (error) {
  failed += 1;
  console.error("FAIL  suite crashed -", error?.stack ?? error);
} finally {
  try { child.kill(); } catch { /* gone */ }
  stub.close();
  try { fs.closeSync(out); fs.rmSync(logDir, { recursive: true, force: true }); } catch { /* best effort */ }
  try { await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  try { await mongoose.disconnect(); } catch { /* best effort */ }
}
console.log(`\nAI provider observability (Node) validation: ${passed} passed, ${failed} failed (isolated database ${DB_NAME} dropped; no Gemini call; no external network)`);
process.exit(failed === 0 ? 0 : 1);
