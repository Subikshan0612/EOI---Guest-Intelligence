/**
 * Phase 53D - FINAL REAL-GEMINI END-TO-END SMOKE (API level), with the production-boundary and governance checks. It is a NEW artifact: the frozen Phase 53A/B/C datasets, rubrics, hashes and
 * results are only READ (the frozen rubric2 scoring function is imported unchanged to apply the same gates).
 *
 *   report -> POST /api/conversations/intake -> internal Signal -> POST /api/intelligence/analyze/:signalId (real context, real retrieval) -> REAL AI service -> gemini-3.1-flash-lite
 *   -> Node validation -> (Phase 53D) server-side prose boundary -> persisted Intelligence -> [human] Decision propose/approve -> [human] Action propose/approve -> [human] Outcome -> fresh re-read
 *
 * ISOLATION: a throwaway database on the local loopback MongoDB; a backend of its own on its own port (stub auth, NODE_ENV=test); a counting HTTP proxy to the REAL AI service
 * (the proxy keeps the model's raw answer BEFORE Node's boundary, as an evaluator artifact only). Atlas is never contacted. Learning is never enabled (the flag is deleted from this process and
 * from the child's environment). NO automatic retry: one analysis attempt per scenario.
 *
 * Usage: node scripts/phase53/run-e2e-53d.mjs [--serve]   (--serve: after the run keep the backend + data up and start the Vite dev server against it for the browser pass; stop with Ctrl+C / kill)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..", "..");
const REPO = path.join(BACKEND, "..");
const OUT = path.join(here, "out4");
fs.mkdirSync(OUT, { recursive: true });
const SERVE = process.argv.includes("--serve");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DB_NAME = `koi_p53d_e2e_${Date.now()}`;
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${DB_NAME}`;

const { createActor } = await import("../lib/authFixtures.mjs");
delete process.env.KOI_RETRIEVAL_MIN_SIMILARITY; // the REAL relevance floor and REAL embeddings
delete process.env.KOI_LEARNING_CONTEXT_ENABLED; // Learning stays OFF everywhere
const mongoose = (await import("mongoose")).default;
const { connectDatabase } = await import("../../src/config/database.js");
const M = await import("../../src/models/index.js");
const { containsInternalReference } = await import("../../src/services/ai/proseReferenceSanitizer.js");
const { SCENARIOS, KNOWLEDGE_DOCS, CATEGORY_NAMES } = await import("./dataset2.mjs");
const { scoreRun, DIMENSIONS } = await import("./rubric2.mjs");
await connectDatabase();
if (mongoose.connection.db.databaseName !== DB_NAME) { console.error("refusing: not connected to the isolated database"); process.exit(2); }

const AI_TOKEN = dotenv.parse(fs.readFileSync(path.join(REPO, "ai-service", ".env"))).AI_SERVICE_TOKEN ?? "";
const AI_BASE = "http://127.0.0.1:8000";
const PROXY_PORT = 8064; const API_PORT = 5312; const WEB_PORT = 5190;
const BASE = `http://localhost:${API_PORT}/api`;
const HEX24 = /\b[0-9a-f]{24}\b/i;
const TENANT_MARKER = "TENANTX-MARKER";
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const TAG = onlyArg ? onlyArg.slice(7).replace(/[^A-Za-z0-9]+/g, "_") : "main";
const PICK = onlyArg ? onlyArg.slice(7).split(",") : ["A1", "E2", "F2", "C1", "G1", "G2", "G3", "H1"]; // normal, RAG hit, RAG miss (same report as E2), contradiction, gas, smoke, CO, injection
const SC = PICK.map((id) => SCENARIOS.find((s) => s.id === id));

const children = []; const gemini = { calls: [], analyzeLog: [] };
const proxyServer = http.createServer((req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks); const started = Date.now(); const p = req.url;
    const kind = p.endsWith("/v1/intelligence/analyze") ? "analyze" : p.includes("knowledge-retrieval") ? "retrieval" : /embed/.test(p) ? "embeddings" : "other";
    let body = null; try { body = JSON.parse(raw.toString("utf8")); } catch { /* not json */ }
    const entry = { kind, path: p, method: req.method, startedAt: new Date(started).toISOString() };
    try {
      const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (!["host", "content-length", "connection"].includes(k)) headers[k] = v;
      const upstream = await fetch(`${AI_BASE}${p}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : raw, signal: AbortSignal.timeout(180000) });
      const buf = Buffer.from(await upstream.arrayBuffer());
      entry.status = upstream.status; entry.ms = Date.now() - started;
      if (kind === "analyze") { let resp = null; try { resp = JSON.parse(buf.toString("utf8")); } catch { /* not json */ } gemini.analyzeLog.push({ status: upstream.status, ms: entry.ms, signalId: body?.context?.signal?.id ?? null, requestBody: body, responseBody: resp }); }
      res.statusCode = upstream.status; res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json"); res.end(buf);
    } catch (error) { entry.status = 0; entry.ms = Date.now() - started; entry.error = String(error?.name ?? error); res.statusCode = 502; res.end("{}"); }
    gemini.calls.push(entry);
  });
});
await new Promise((r) => proxyServer.listen(PROXY_PORT, r));

const serverEnv = { ...process.env, PORT: String(API_PORT), LLM_PROVIDER: "gemini", AI_SERVICE_URL: `http://localhost:${PROXY_PORT}`, AI_SERVICE_TOKEN: AI_TOKEN, KOI_RATE_LIMIT_ENABLED: "false", CLIENT_URL: `http://localhost:${WEB_PORT}` };
delete serverEnv.KOI_LEARNING_CONTEXT_ENABLED; delete serverEnv.KOI_RETRIEVAL_MIN_SIMILARITY;
const log = fs.openSync(path.join(OUT, "backend.log"), "w");
children.push(spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: serverEnv, stdio: ["ignore", log, log] }));
const cleanup = async () => {
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  try { proxyServer.close(); } catch { /* gone */ }
  try { await mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  try { await mongoose.disconnect(); } catch { /* best effort */ }
};
const call = async (method, url, who, body) => {
  const res = await fetch(`${BASE}${url}`, { method, headers: { ...(who ? who.headers : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* none */ }
  return { status: res.status, json, data: json?.data, code: json?.details?.code, message: json?.message, text };
};
const dayStart = (d) => { const x = new Date(); x.setUTCHours(0, 0, 0, 0); x.setUTCDate(x.getUTCDate() + d); return x; };
const FIRST = ["Zephyrine", "Ottoline", "Marisol", "Tobiah", "Linnaea", "Casimir", "Perdita", "Evander", "Sorrel"]; const LAST = ["Quillfeather", "Brackenridge", "Ashgrove", "Fennimore", "Hollowell", "Thistlewood", "Marchbanks", "Pennyworth", "Larkspur"];

const report = { meta: { startedAt: new Date().toISOString(), db: DB_NAME, model: "gemini-3.1-flash-lite (AI service configured model)", scenarios: PICK, learning: "OFF", atlas: "not contacted" }, scenarios: [], governance: {}, checks: [] };
try {
  for (let i = 0; i < 120; i += 1) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* starting */ } await sleep(250); }
  const health = { backend: await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null), aiService: await fetch(`${AI_BASE}/v1/health`).then((r) => r.json()).catch(() => null) };
  if (!health.backend?.success) throw new Error("backend did not start");
  report.health = health; console.log("health:", JSON.stringify(health));

  // ---- two workspaces (NK: no knowledge, K: the five synthetic documents) and one other tenant X
  const mk = async (name) => { const ws = await M.Workspace.create({ name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`, status: "active" }); return { ws, id: String(ws._id), admin: await createActor({ role: "admin", workspaceId: ws._id, label: `${name}-admin` }), operator: await createActor({ role: "operator", workspaceId: ws._id, label: `${name}-op` }), viewer: await createActor({ role: "viewer", workspaceId: ws._id, label: `${name}-view` }) }; };
  const W = { NK: await mk("P53D NK"), K: await mk("P53D K"), X: await mk("P53D X") };
  const knowledge = [];
  for (const doc of SC.some((x) => x.ws === "K") ? KNOWLEDGE_DOCS : []) {
    const created = await call("POST", "/knowledge-documents", W.K.admin, { workspaceId: W.K.id, title: doc.title, documentType: doc.documentType, content: doc.content, defaultVisibility: "staff" });
    const id = created.data?._id; const chunked = id ? await call("POST", `/knowledge-documents/${id}/chunks?workspaceId=${W.K.id}`, W.K.admin, {}) : null;
    let embedded = null; for (let a = 1; id && a <= 4; a += 1) { embedded = await call("POST", `/knowledge-documents/${id}/embeddings?workspaceId=${W.K.id}`, W.K.admin, {}); if (embedded.status < 300) break; await sleep(4000); }
    knowledge.push([doc.key, created.status, chunked?.status, embedded?.status]); await sleep(400);
  }
  if (knowledge.some((k) => k.slice(1).some((s) => !s || s >= 300))) throw new Error(`knowledge setup incomplete: ${JSON.stringify(knowledge)}`);
  report.knowledge = knowledge;
  // tenant X mirrors every scenario room and carries a marker (cross-workspace leak check)
  for (const sc of SC) {
    const p2 = await M.Property.create({ workspaceId: W.X.ws._id, name: `X ${sc.id} Tower`, code: `XT${sc.id}`, timezone: "UTC" }); const u2 = await M.Unit.create({ propertyId: p2._id, unitNumber: sc.room, status: "occupied" });
    const g2 = await M.Guest.create({ workspaceId: W.X.ws._id, firstName: `${TENANT_MARKER}-GUEST`, lastName: sc.id });
    await M.Signal.create({ workspaceId: W.X.ws._id, propertyId: p2._id, unitId: u2._id, guestId: g2._id, type: "maintenance", source: "staff", severity: "high", title: `${TENANT_MARKER} ${sc.text}`, description: `${TENANT_MARKER} ${sc.text}` });
  }
  const xGuard = await call("GET", `/intelligence?workspaceId=${W.X.id}`, W.X.admin); report.meta.xBaselineIntelligence = xGuard.data?.length ?? xGuard.json?.data?.length ?? null;

  let idx = 0;
  for (const sc of SC) {
    idx += 1; const w = W[sc.ws]; const cfg = sc.stay ?? { status: "checked_in", inDays: -1, outDays: 3 };
    const prop = await M.Property.create({ workspaceId: w.ws._id, name: `E2E ${sc.id} Residence`, code: `E2E${sc.id}`, timezone: "UTC" }); const unit = await M.Unit.create({ propertyId: prop._id, unitNumber: sc.room, status: "occupied" });
    const guest = await M.Guest.create({ workspaceId: w.ws._id, firstName: FIRST[idx % 9], lastName: LAST[idx % 9], email: `${FIRST[idx % 9]}.${LAST[idx % 9]}.${idx}@pii-eval.invalid`.toLowerCase(), phone: `+91 555 0${idx}0` });
    const stay = await M.Stay.create({ workspaceId: w.ws._id, guestId: guest._id, propertyId: prop._id, unitId: unit._id, status: cfg.status, checkIn: dayStart(cfg.inDays), checkOut: dayStart(cfg.outDays) });
    const pii = [FIRST[idx % 9], LAST[idx % 9], String(guest.email), String(guest.phone)];
    const run = { id: sc.id, category: CATEGORY_NAMES[sc.cat], ws: sc.ws, room: sc.room, reportText: sc.text, pii, tenantMarkers: [TENANT_MARKER], variant: "primary", analysis: { attempted: false }, request: null };
    const intake = await call("POST", "/conversations/intake", w.operator, { workspaceId: w.id, content: sc.text });
    run.intake = { status: intake.status, outcome: intake.data?.outcome ?? null };
    const signalId = intake.data?.signal?._id ?? null; run.signalId = signalId;
    if (!signalId) { report.scenarios.push({ ...run, error: "no signal created" }); continue; }
    const t0 = Date.now(); const gen = await call("POST", `/intelligence/analyze/${signalId}?workspaceId=${w.id}`, w.operator); run.analysisMs = Date.now() - t0;
    run.analysis = { attempted: true, status: gen.status, errorCode: gen.code ?? null, view: gen.status < 300 ? gen.data : undefined };
    const logged = [...gemini.analyzeLog].reverse().find((b) => b.signalId === signalId);
    run.request = logged?.requestBody ?? null; run.aiStatus = logged?.status ?? null; run.rawModelAnswer = logged?.responseBody?.analysis ?? logged?.responseBody ?? null;
    console.log(`${sc.id}: analyze=${gen.status}${gen.code ? ` ${gen.code}` : ""} ai=${run.aiStatus ?? "-"} ${run.analysisMs}ms`);
    const row = { id: sc.id, category: run.category, report: sc.text, httpStatus: gen.status, errorCode: gen.code ?? null, geminiCalled: run.aiStatus === 200, ms: run.analysisMs };
    if (gen.status < 300 && gen.data?._id) {
      const view = gen.data; const dbDoc = await M.Intelligence.findById(view._id).lean();
      const rawAnswer = run.rawModelAnswer ?? {};
      const rawProse = [rawAnswer.situation, ...(rawAnswer.evidence ?? []), rawAnswer.impact, rawAnswer.recommendation].filter(Boolean).join("\n");
      const storedProse = [dbDoc.analysis.situation, ...dbDoc.analysis.evidence, dbDoc.analysis.impact, dbDoc.analysis.recommendation, dbDoc.intelligence?.summary, ...(dbDoc.intelligence?.findings ?? []), dbDoc.intelligence?.operationalImpact, dbDoc.decision?.recommendation, ...(dbDoc.contradictions ?? []).map((c) => c.description)].filter(Boolean).join("\n");
      const viewProse = JSON.stringify([view.analysis, view.intelligence, view.decision, view.contradictions]);
      Object.assign(row, {
        model: { stored: dbDoc.model, provider: dbDoc.provider, rawAnswerModel: logged?.responseBody?.provenance?.model ?? rawAnswer?.provenance?.model ?? null },
        modelOutputHeldIdentifiers: HEX24.test(rawProse) || containsInternalReference(rawProse),
        storedProseHasInternalRef: containsInternalReference(storedProse) || HEX24.test(storedProse), apiProseHasInternalRef: containsInternalReference(viewProse) || HEX24.test(viewProse),
        structured: { evidenceRefs: (dbDoc.evidenceRefs ?? []).length, contradictions: (dbDoc.contradictions ?? []).length, knowledgeProvenance: (dbDoc.knowledgeProvenance ?? []).length, viewEvidenceRefs: (view.evidenceRefs ?? []).length },
        safety: view.safety ?? null, confidence: view.analysis?.confidence, recommendation: view.analysis?.recommendation, situation: view.analysis?.situation,
        retrieved: (run.request?.knowledge ?? []).length, retrievedTitles: (run.request?.knowledge ?? []).map((k) => k.section ?? null),
        learningInRequest: run.request ? "learning" in run.request : null, tenantMarkerInRequest: JSON.stringify(run.request ?? {}).includes(TENANT_MARKER), piiInRequest: pii.some((p) => JSON.stringify(run.request ?? {}).toLowerCase().includes(p.toLowerCase())),
      });
      const adm = await M.AnalysisAdmission.find({ workspaceId: w.id, signalId }).sort({ createdAt: 1 }).lean(); const last = adm[adm.length - 1];
      run.stored = { admission: last ? { outcome: last.outcome, finalConfidence: last.finalConfidence, learningUsed: last.learningUsed, safetyState: last.safetyState } : null }; row.learningUsed = last?.learningUsed ?? null; row.admission = last?.outcome ?? null;
      // nothing human-only exists yet
      row.beforeHuman = { decisions: await M.Decision.countDocuments({ workspaceId: w.id, signalId }), actions: await M.Action.countDocuments({ workspaceId: w.id, signalId }), outcomes: await M.Outcome.countDocuments({ workspaceId: w.id, signalId }) };
      run.counts = { decisions: row.beforeHuman.decisions, actions: row.beforeHuman.actions, outcomes: row.beforeHuman.outcomes, executedActions: await M.Action.countDocuments({ workspaceId: w.id, signalId, executedAt: { $exists: true } }) };
      // ---- the human-mediated journey
      const propose = await call("POST", `/decisions/propose/${view._id}?workspaceId=${w.id}`, w.admin); const decId = propose.data?._id;
      const approve = decId ? await call("POST", `/decisions/${decId}/approve?workspaceId=${w.id}`, w.admin, {}) : null;
      const aPropose = decId ? await call("POST", `/actions/propose/${decId}?workspaceId=${w.id}`, w.admin) : null; const actId = aPropose?.data?._id;
      const aApprove = actId ? await call("POST", `/actions/${actId}/approve?workspaceId=${w.id}`, w.admin, { note: "E2E approval by a person." }) : null;
      const outcome = actId ? await call("POST", `/outcomes/record/${actId}?workspaceId=${w.id}`, w.admin, { status: "success", result: { summary: "Synthetic E2E outcome recorded by a person." } }) : null;
      row.journey = { decision: [propose.status, approve?.status, approve?.data?.status], action: [aPropose?.status, aApprove?.status, aApprove?.data?.status], outcome: [outcome?.status, outcome?.data?.status], actionType: aPropose?.data?.actionType ?? null, actionUrgency: aPropose?.data?.urgency ?? null, actionRisk: aPropose?.data?.riskLevel ?? null,
        decisionDescriptionClean: propose.data ? !containsInternalReference(propose.data.description) && !HEX24.test(propose.data.description) : null, actionDescriptionClean: aPropose.data ? !containsInternalReference(aPropose.data.description) && !HEX24.test(aPropose.data.description) : null };
      // ---- "refresh": fresh reads through the API (new requests, nothing cached), as the operator
      const listI = await call("GET", `/intelligence?workspaceId=${w.id}&limit=100`, w.operator); const getI = await call("GET", `/intelligence/${view._id}?workspaceId=${w.id}`, w.operator);
      const listD = await call("GET", `/decisions?workspaceId=${w.id}&limit=100`, w.operator); const listA = await call("GET", `/actions?workspaceId=${w.id}&limit=100`, w.operator); const listO = await call("GET", `/outcomes?workspaceId=${w.id}&limit=100`, w.operator);
      const rows = (r) => (Array.isArray(r.data) ? r.data : Array.isArray(r.json?.data) ? r.json.data : []);
      row.refreshStatus = { intelligenceList: listI.status, decisions: listD.status, actions: listA.status, outcomes: listO.status };
      const asAdminA = await call("GET", `/actions/${actId}?workspaceId=${w.id}`, w.admin); const asAdminO = await call("GET", `/outcomes?workspaceId=${w.id}&limit=100`, w.admin); const asAdminD = await call("GET", `/decisions/${decId}?workspaceId=${w.id}`, w.admin);
      const outRows = Array.isArray(asAdminO.data) ? asAdminO.data : Array.isArray(asAdminO.json?.data?.items) ? asAdminO.json.data.items : [];
      row.afterRefreshAdmin = { actionById: [asAdminA.status, asAdminA.data?.status, asAdminA.data?.actionType], outcomesList: asAdminO.status, outcomeRows: outRows.length, outcomeShapeKeys: Object.keys(asAdminO.json?.data ?? asAdminO.json ?? {}).slice(0, 6), decisionById: [asAdminD.status, asAdminD.data?.status], descriptionsClean: !containsInternalReference(JSON.stringify([asAdminA.data?.description, asAdminD.data?.description])) };
      row.afterRefresh = { intelligenceStillThere: rows(listI).some((x) => x._id === view._id), intelligenceByIdStatus: getI.status, byIdProseClean: !containsInternalReference(JSON.stringify(getI.data?.analysis ?? {})) && !HEX24.test(JSON.stringify(getI.data?.analysis ?? {})), byIdEvidenceRefs: (getI.data?.evidenceRefs ?? []).length,
        decisionPersisted: rows(listD).some((x) => x._id === decId && x.status === "approved"), actionPersisted: rows(listA).some((x) => x._id === actId && x.status === "approved"), outcomePersisted: rows(listO).some((x) => x.actionId === actId || x.status === "success"),
        listsProseClean: !containsInternalReference(JSON.stringify([rows(listD).map((x) => x.description), rows(listA).map((x) => x.description)])) };
      const actDoc = actId ? await M.Action.findById(actId).lean() : null; const decDoc = decId ? await M.Decision.findById(decId).lean() : null; const outDoc = outcome?.data?._id ? await M.Outcome.findById(outcome.data._id).lean() : null;
      row.humanBoundaryDb = { decisionProposedByAdmin: String(decDoc?.proposedBy ?? "") === String(w.admin.user._id), decisionReviewedByAdmin: String(decDoc?.review?.reviewedBy ?? "") === String(w.admin.user._id), actionProposedByAdmin: String(actDoc?.proposedBy ?? "") === String(w.admin.user._id), actionReviewedByAdmin: String(actDoc?.review?.reviewedBy ?? "") === String(w.admin.user._id), outcomeRecordedByAdmin: String(outDoc?.recordedBy ?? "") === String(w.admin.user._id), actionExecutionFields: Object.keys(actDoc ?? {}).filter((f) => /execut|dispatched|sentAt/i.test(f)), actionStatus: actDoc?.status };
      // the frozen rubric (rubric2) gates, applied unchanged to this run (counts here are the pre-human counts)
      const scoredRun = { ...run, analysis: { attempted: true, status: gen.status, view }, guidanceConcepts: [], distractorMarkers: [] };
      if (sc.expect?.guidance) { const doc = KNOWLEDGE_DOCS.find((d) => d.key === sc.expect.guidance.doc); scoredRun.guidanceConcepts = doc?.concepts ?? []; scoredRun.distractorMarkers = KNOWLEDGE_DOCS.filter((d) => d.key !== doc.key).flatMap((d) => d.distinctive); }
      const sr = scoreRun(sc, scoredRun);
      row.rubric2 = { scored: sr.scored, scores: sr.scores, gatesTripped: Object.entries(sr.gates).filter(([, v]) => v).map(([k]) => k), notes: sr.notes.slice(0, 6), refsStored: sr.facts?.refsStored ?? null, refsPresented: sr.facts?.refsPresented ?? null };
    }
    report.scenarios.push(row); await sleep(2500);
  }

  // ---- governance
  const okRun = report.scenarios.find((r) => r.geminiCalled && r.structured);
  const G = {};
  if (okRun) {
    const w = W.NK; const iid = (await M.Intelligence.findOne({ workspaceId: w.id }).lean())?._id; const sigId = (await M.Signal.findOne({ workspaceId: w.id }).lean())?._id;
    G.unauthenticatedList = (await fetch(`${BASE}/intelligence?workspaceId=${w.id}`)).status;
    G.unauthenticatedAnalyze = (await fetch(`${BASE}/intelligence/analyze/${sigId}?workspaceId=${w.id}`, { method: "POST" })).status;
    G.unauthenticatedDecision = (await fetch(`${BASE}/decisions/propose/${iid}?workspaceId=${w.id}`, { method: "POST" })).status;
    G.viewerAnalyze = (await call("POST", `/intelligence/analyze/${sigId}?workspaceId=${w.id}`, w.viewer)).status;
    G.viewerDecisionPropose = (await call("POST", `/decisions/propose/${iid}?workspaceId=${w.id}`, w.viewer)).status;
    G.operatorDecisionApprove = "n/a (checked in 53C journey)";
    G.clientCreateIntelligence = (await call("POST", "/intelligence", w.admin, { workspaceId: w.id, signalIds: [String(sigId)], summary: "client-created" })).status;
    G.clientCreateDecisionViaLegacyRoute = (await call("POST", "/decisions", w.admin, { workspaceId: w.id, intelligenceId: String(iid), description: "client-created" })).status;
    G.crossWorkspaceRead = (await call("GET", `/intelligence/${iid}?workspaceId=${W.X.id}`, W.X.admin)).status;
    G.crossWorkspaceForgedQuery = (await call("GET", `/intelligence/${iid}?workspaceId=${w.id}`, W.X.admin)).status;
    G.crossWorkspaceListForged = (await call("GET", `/intelligence?workspaceId=${w.id}`, W.X.admin)).status;
    G.crossWorkspaceAnalyzeForged = (await call("POST", `/intelligence/analyze/${sigId}?workspaceId=${w.id}`, W.X.operator)).status;
    G.crossWorkspaceDecisionForged = (await call("POST", `/decisions/propose/${iid}?workspaceId=${w.id}`, W.X.admin)).status;
    G.xTenantWorkspaceHasNoIntelligenceFromOthers = (await M.Intelligence.countDocuments({ workspaceId: W.X.ws._id })) === 0;
  }
  report.governance = G;
  report.aiServiceCalls = gemini.calls.reduce((a, c) => { const k = `${c.kind}:${c.status}`; a[k] = (a[k] ?? 0) + 1; return a; }, {});
  report.staticChecks = { learningFlagInCollectorEnv: process.env.KOI_LEARNING_CONTEXT_ENABLED ?? null, learningFlagSetInBackendChild: serverEnv.KOI_LEARNING_CONTEXT_ENABLED ?? null, learningFlagTrueInRepoEnv: ["backend/.env", "ai-service/.env", "frontend/.env"].map((f) => { try { return [f, /KOI_LEARNING_CONTEXT_ENABLED\s*=\s*true/i.test(fs.readFileSync(path.join(REPO, f), "utf8"))]; } catch { return [f, null]; } }) };
  fs.writeFileSync(path.join(OUT, TAG === "main" ? "e2e-results.json" : `e2e-results-${TAG}.json`), JSON.stringify(report, null, 2));
  console.log("wrote out4/e2e-results.json; AI-service calls:", JSON.stringify(report.aiServiceCalls));

  if (SERVE) {
    const fe = path.join(REPO, "frontend");
    const feEnv = { ...process.env, VITE_API_BASE_URL: `http://localhost:${API_PORT}/api`, VITE_DEV_ACCESS_TOKEN: W[SC[0].ws].admin.token, VITE_KOI_AUTH: "", VITE_OIDC_AUTHORITY: "", VITE_OIDC_CLIENT_ID: "", VITE_KOI_WORKSPACE_ID: W[SC[0].ws].id };
    const flog = fs.openSync(path.join(OUT, "frontend.log"), "w");
    children.push(spawn(process.execPath, [path.join(fe, "node_modules", "vite", "bin", "vite.js"), "--port", String(WEB_PORT), "--strictPort"], { cwd: fe, env: feEnv, stdio: ["ignore", flog, flog] }));
    fs.writeFileSync(path.join(OUT, "serve.json"), JSON.stringify({ web: `http://localhost:${WEB_PORT}/`, api: BASE, workspaces: { NK: W.NK.id, K: W.K.id }, tokenWorkspace: SC[0].ws, startedAt: new Date().toISOString() }));
    console.log(`SERVING: web http://localhost:${WEB_PORT}/  api ${BASE}  (kill this process to stop and drop the database)`);
    await new Promise((resolve) => { process.on("SIGTERM", resolve); process.on("SIGINT", resolve); });
  }
} catch (error) {
  console.error("e2e failed:", error?.stack ?? error); process.exitCode = 1;
} finally {
  await cleanup();
}
