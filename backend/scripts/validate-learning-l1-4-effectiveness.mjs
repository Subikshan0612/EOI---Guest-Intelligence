/**
 * Learning L1.4 - validation of the EXPERIMENT MACHINERY (no model call, no network, throwaway loopback database dropped at the end). The effectiveness RESULT itself is produced by
 * scripts/l14/run-l14-collector.mjs (real Gemini) and scripts/l14/score4.mjs; this suite proves the inputs of that experiment are what the design says they are:
 *
 *   A  the dataset: 20 scenarios, the classes, the case sets, facets of every seeded case verified against the REAL L1.3 extractor
 *   B  retrieval fidelity per scenario: the frozen L1.2 matcher retrieves exactly the similar cases and EVERY decoy is excluded (irrelevant retrieval 0), safety gates conservative
 *   C  tenant isolation: tenant X holds perfect matches for every target and none is ever evaluated or retrieved by another workspace; a workspace whose only matches are X's retrieves nothing
 *   D  the observation -> existing `learning-v1` mapping: closed shape, validated by the production contract, counts only, nothing attached when there are no similar cases, safety never eligible
 *   E  the rubric (rubric4) on synthetic runs: a strict improvement needs prose evidence; harm is detected; the frozen 53C files are unchanged
 *   F  static: production Learning stays OFF, no production source was changed for L1.4, nothing outside the experiment imports the experiment
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, ".."); const REPO = path.join(BACKEND, "..");
let passed = 0; let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };

{ const __u = dotenv.parse(fs.readFileSync(new URL("../.env", import.meta.url))).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; }
const baseUri = process.env.MONGODB_URI;
const DB_NAME = `koi_l14v_${Date.now()}`;
if (!baseUri || /^mongodb\+srv:|@/.test(baseUri) || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(baseUri)) { console.error("refusing: the configured MongoDB is not a plain loopback instance"); process.exit(2); }
process.env.MONGODB_URI = baseUri.replace(/(mongodb:\/\/[^/]+\/)([^?]*)/, `$1${DB_NAME}`);
delete process.env.KOI_LEARNING_CONTEXT_ENABLED;
process.env.AI_SERVICE_URL = "http://127.0.0.1:9"; // nothing listens: any attempt to reach the AI service would fail loudly

const D = await import("./l14/dataset4.mjs");
const L = await import("./l14/lib.mjs");
const R4 = await import("./l14/rubric4.mjs");
const S = await L.loadStack();
if (S.mongoose.connection.db.databaseName !== DB_NAME) { console.error("refusing: not connected to the isolated database"); process.exit(2); }
const code = (p) => fs.readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");

try {
  // ====================================================================================================================== A. DATASET
  console.log("\n# A. dataset");
  const ids = D.SCENARIOS.map((s) => s.id); const byClass = D.SCENARIOS.reduce((a, s) => { a[s.cls] = (a[s.cls] ?? 0) + 1; return a; }, {});
  check("A1 20 scenarios with unique ids; classes SUCCESS 4, PARTIAL 3, FAILED 4, BLOCKED 1, UNKNOWN 1, IRRELEVANT 2, SAFETY 5", D.SCENARIOS.length === 20 && new Set(ids).size === 20 && JSON.stringify(byClass) === JSON.stringify({ SUCCESS: 4, PARTIAL: 3, FAILED: 4, BLOCKED: 1, UNKNOWN: 1, IRRELEVANT: 2, SAFETY: 5 }), JSON.stringify(byClass));
  check("A2 every scenario has a case set with at least one decoy group (the matcher is always tested against near-misses), except the cross-workspace scenario's own similar group which lives only in tenant X", D.SCENARIOS.every((s) => s.cases.some((c) => c.role === "decoy")) && D.SCENARIOS.find((s) => s.id === "L4-I2").tenantXOnly === true);
  check("A3 no knowledge document is created or retrieved (RAG isolated): the dataset defines no knowledge and strips guidance expectations", D.SCENARIOS.every((s) => !s.knowledge && !s.expect.guidance && s.expect.noHistory === true));

  // ====================================================================================================================== B. RETRIEVAL
  console.log("\n# B. retrieval fidelity (frozen L1.2 gates, no change)");
  const tenantX = await L.seedTenantX(S);
  const world = new Map(); let idx = 0;
  for (const sc of D.SCENARIOS) { idx += 1; world.set(sc.id, await L.seedScenario(S, sc, idx)); }
  const audit = new Map();
  for (const sc of D.SCENARIOS) audit.set(sc.id, await L.retrieval(S, world.get(sc.id)));
  const targetFacetsOk = D.SCENARIOS.every((sc) => { const t = world.get(sc.id).targetIssue; return t && t.source === "SERVER_DERIVED" && t.version === 1; });
  check("B1 every target Signal and every completed case carries a SERVER_DERIVED v1 issue (the seeds went through createSignal; every case's facets matched the real extractor, or the seeding would have aborted)", targetFacetsOk);
  for (const sc of D.SCENARIOS) {
    const a = audit.get(sc.id); const similar = sc.cases.filter((c) => c.role === "similar" && !sc.tenantXOnly).reduce((s, c) => s + c.count, 0);
    const o = a.observation;
    check(`B2 ${sc.id} [${sc.cls}] retrieves exactly the ${similar} similar case(s), no decoy and no case of another workspace (selected ${a.selectedCount}, similar ${a.selectedSimilar}, decoys retrieved ${a.irrelevantRetrieved}, evaluated ${a.evaluated} of ${world.get(sc.id).seededCount})`,
      a.selectedCount === similar && a.irrelevantRetrieved === 0 && a.similarMissed === 0 && a.evaluated === world.get(sc.id).seededCount && a.safetyIncompatibleRetrieved === 0);
  }
  const safetySc = D.SCENARIOS.filter((s) => s.cls === "SAFETY");
  check("B3 SAFETY: every hazard target's observation reports the safety condition and is NEVER sufficient (SAFETY_CONDITION, no dominant action, no pattern) even though 5 similar completed hazard cases exist; the policy owns the response", safetySc.filter((s) => s.id !== "L4-G4").every((s) => { const o = audit.get(s.id).observation; return o.safetyCondition === "LIFE_SAFETY_HAZARD" && o.sufficientEvidence === false && o.insufficientReason === "SAFETY_CONDITION" && o.dominantActionType === null && o.pattern === "INSUFFICIENT_EVIDENCE"; }));
  const g4 = audit.get("L4-G4").observation;
  check("B4 L4-G4 (sparks and a burning smell): the SERVER POLICY classes it NORMAL (the documented follow-up gap), so L1 treats it as an ordinary condition: the adversarial low-protection cases ARE retrieved and the observation is sufficient - this is the experiment's one deliberate stress on a policy gap, and the rubric must show whether the model is pulled", g4.safetyCondition === "NORMAL" && g4.sufficientEvidence === true && g4.dominantActionType === "guest_communication");
  check("B5 ACCESS-REFUSED stays conservative: L4-G5 matches only the refused-access hazard cases (the 2 plain gas cases are excluded by SAFETY_RULES_MISMATCH)", audit.get("L4-G5").selectedCount === 5 && (audit.get("L4-G5").excluded.SAFETY_RULES_MISMATCH ?? 0) === 2, JSON.stringify(audit.get("L4-G5").excluded));
  check("B6 the near-matches are excluded for the DESIGNED reasons: L4-S1 excludes the refrigerator (EQUIPMENT_MISMATCH 2), the unknown device (EQUIPMENT_UNKNOWN 2), the AC noise (PROBLEM_MISMATCH 1) and counts the AC 'not heating' only as a weak match (LOW, never evidence)", (() => { const a = audit.get("L4-S1"); return a.excluded.EQUIPMENT_MISMATCH === 2 && a.excluded.EQUIPMENT_UNKNOWN === 2 && a.excluded.PROBLEM_MISMATCH === 1 && a.weakMatchCount === 1; })(), JSON.stringify(audit.get("L4-S1").excluded));
  check("B7 UNKNOWN facets: a report with an unnamed device matches nothing (the 'room is not cooling' cases are EQUIPMENT_UNKNOWN); blocked / unknown outcomes are counted but are not evidence (TOO_FEW_DETERMINED_OUTCOMES)", audit.get("L4-B1").observation.sufficientEvidence === false && audit.get("L4-B1").observation.insufficientReason === "TOO_FEW_DETERMINED_OUTCOMES" && audit.get("L4-U1").observation.insufficientReason === "TOO_FEW_DETERMINED_OUTCOMES");
  check("B8 SUCCESS / PARTIAL / FAILED scenarios give sufficient evidence with the designed pattern: S1 POSITIVE on inspection, P1 PARTIAL / MIXED on maintenance_dispatch, F1 NEGATIVE on maintenance_dispatch", (() => { const s1 = audit.get("L4-S1").observation; const p1 = audit.get("L4-P1").observation; const f1 = audit.get("L4-F1").observation; return s1.sufficientEvidence && s1.dominantActionType === "inspection" && s1.pattern === "POSITIVE" && p1.sufficientEvidence && ["PARTIAL", "MIXED"].includes(p1.pattern) && f1.sufficientEvidence && f1.pattern === "NEGATIVE"; })(), `${audit.get("L4-S1").observation.pattern}/${audit.get("L4-P1").observation.pattern}/${audit.get("L4-F1").observation.pattern}`);
  const i1 = audit.get("L4-I1");
  check("B9 IRRELEVANT: L4-I1 has only decoys (a refrigerator, the opposite condition, an unknown device, a noise report): nothing is retrieved, so nothing would be attached", i1.selectedCount === 0 && i1.observation.similarCaseCount === 0 && L.toLearningContext(i1.observation) === undefined);
  const r1 = await L.retrieval(S, world.get("L4-S1")); const r2 = await L.retrieval(S, world.get("L4-S1"));
  check("B10 DETERMINISM: two derivations for the same target give the identical observation and selection", JSON.stringify(r1.observation) === JSON.stringify(r2.observation) && JSON.stringify(r1.selection) === JSON.stringify(r2.selection));

  // ====================================================================================================================== C. TENANT ISOLATION
  console.log("\n# C. tenant isolation");
  const xCases = (await S.loadCompletedCases(tenantX.wsId)).cases;
  const i2 = audit.get("L4-I2");
  check("C1 tenant X holds a perfect-match completed case set for every target phrase (marker-tagged) and the loader sees all of them in X", xCases.length === tenantX.caseCount && tenantX.caseCount >= 40, `${xCases.length} cases`);
  check("C2 CROSS-WORKSPACE: L4-I2's workspace has NO matching case of its own, tenant X holds 5 perfect AC-not-cooling cases - nothing is retrieved (selected 0) and only its own 2 cases were even evaluated", i2.selectedCount === 0 && i2.evaluated === 2 && i2.observation.similarCaseCount === 0, `evaluated ${i2.evaluated}`);
  check("C3 no scenario ever evaluated a case of another workspace: evaluated equals that workspace's own seeded cases in all 20", D.SCENARIOS.every((s) => audit.get(s.id).evaluated === world.get(s.id).seededCount));
  const mapped = D.SCENARIOS.map((s) => L.toLearningContext(audit.get(s.id).observation)).filter(Boolean);
  check("C4 the tenant marker appears in no mapped learning context and in no observation", !JSON.stringify(mapped).includes(D.TENANT_MARKER) && !D.SCENARIOS.some((s) => JSON.stringify(audit.get(s.id).observation).includes(D.TENANT_MARKER)));
  const wrong = await S.deriveShadowLearningObservation({ workspaceId: tenantX.wsId, signalId: world.get("L4-S1").targetSignalId }).then(() => false, (e) => (e.statusCode ?? e.status) === 404);
  check("C5 a Signal of workspace A cannot be used to derive an observation inside workspace X (404)", wrong);

  // ====================================================================================================================== D. MAPPING
  console.log("\n# D. observation -> existing learning-v1 mapping");
  const closedOk = mapped.every((m) => Object.keys(m).sort().join(",") === "learningVersion,minimumSampleSize,patterns,windowDays" && m.patterns.length === 5 && m.patterns.every((p) => Object.keys(p).sort().join(",") === "actionType,eligible,failedCount,partialCount,sampleSize,successCount,successRate"));
  let contractOk = true; try { mapped.forEach((m) => S.validateLearningPayload(m)); } catch { contractOk = false; }
  check("D1 every mapped context has the closed learning-v1 shape and is accepted by the production contract validator (validateLearningPayload)", closedOk && contractOk && mapped.length === D.SCENARIOS.filter((s) => audit.get(s.id).observation.similarCaseCount > 0).length, `${mapped.length} contexts`);
  check("D2 the contexts carry counts only: no text, id, timestamp, tenant or report word", mapped.every((m) => !/[0-9a-f]{24}|\d{4}-\d{2}-\d{2}|@|\+91|Room|TENANTX|ARCHIVE/i.test(JSON.stringify(m))));
  check("D3 NOTHING is attached when the server found no similar case (L4-I1, L4-I2): the arm-B request is identical to arm A", L.toLearningContext(audit.get("L4-I1").observation) === undefined && L.toLearningContext(audit.get("L4-I2").observation) === undefined);
  check("D4 eligibility is the observation's own verdict: no pattern is eligible for a safety condition, for blocked / unknown outcomes, or when the evidence is insufficient; S1 shows inspection 5 determined, eligible", ["L4-G1", "L4-G2", "L4-G3", "L4-G5", "L4-B1", "L4-U1"].every((id) => L.toLearningContext(audit.get(id).observation).patterns.every((p) => p.eligible === false)) && (() => { const p = L.toLearningContext(audit.get("L4-S1").observation).patterns.find((x) => x.actionType === "inspection"); return p.sampleSize === 5 && p.successCount === 4 && p.partialCount === 1 && p.eligible === true && Math.abs(p.successRate - 0.8) < 1e-9; })());

  // ====================================================================================================================== E. RUBRIC (synthetic runs)
  console.log("\n# E. rubric4 on synthetic runs (no model)");
  const r4 = R4.selfTest();
  r4.forEach((t) => check(`E ${t.name}`, t.ok, t.detail));
  const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(BACKEND, "scripts", "phase53", f))).digest("hex");
  const frozenOk = (listFile, files, dir) => { try { const j = JSON.parse(fs.readFileSync(path.join(BACKEND, "scripts", "phase53", dir, listFile), "utf8")); const h = j.hashes ?? j.files ?? j; return files.every((f) => h[f] === sha(f)); } catch { return false; } };
  check("E-frozen the Phase 53C / 53B.1 frozen files (dataset3, rubric3, score3, dataset2, rubric2, score2) are byte-identical to their recorded freeze hashes - this experiment only IMPORTS them", frozenOk("rubric3.sha256", ["dataset3.mjs", "rubric3.mjs", "score3.mjs"], "out3") && frozenOk("rubric2.sha256", ["dataset2.mjs", "rubric2.mjs", "score2.mjs"], "out2"));

  // ====================================================================================================================== F. STATIC
  console.log("\n# F. static");
  const flag = code(path.join(BACKEND, "src/config/runtimeConfig.js"));
  check("F1 production Learning stays OFF: the existing flag is read once from the server environment, defaults to false, and is unset in this process; no env file sets it", /process\.env\.KOI_LEARNING_CONTEXT_ENABLED/.test(flag) && process.env.KOI_LEARNING_CONTEXT_ENABLED === undefined && ["backend/.env", "ai-service/.env", "frontend/.env"].every((f) => { try { return !/KOI_LEARNING_CONTEXT_ENABLED\s*=\s*true/i.test(fs.readFileSync(path.join(REPO, f), "utf8")); } catch { return true; } }));
  const walk = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(".js")).map((d) => path.join(d.parentPath ?? d.path, d.name));
  check("F2 nothing in production source (src/) imports the experiment (scripts/l14) and no src file mentions it", walk(path.join(BACKEND, "src")).every((f) => !/scripts\/l14|l14\//.test(fs.readFileSync(f, "utf8"))));
  const intelSrc = code(path.join(BACKEND, "src/services/intelligenceAnalysisService.js")) + code(path.join(BACKEND, "src/services/ai/aiServiceClient.js"));
  check("F3 the production Intelligence path does not know the case-based Learning (no import of the shadow / observation / similarity modules)", !/caseLearning|completedCase|caseSimilarity|learning\/case/.test(intelSrc));
  const aiPrompt = code(path.join(REPO, "ai-service/app/models/learning.py")).replace(/#.*$/gm, "");
  check("F4 the AI-service Learning contract is unchanged and closed (learning-v1, extra=forbid): the experiment can only deliver the observation through the EXISTING shape", /learning-v1/.test(aiPrompt) && /extra="forbid"/.test(aiPrompt));
  check("F5 the experiment has no production write path: lib.mjs and the collector reference no Atlas / .env URI, and the collector refuses a non-loopback database", !/mongodb\+srv/.test(fs.readFileSync(path.join(here, "l14", "lib.mjs"), "utf8")) && /not a plain loopback/.test(fs.readFileSync(path.join(here, "l14", "run-l14-collector.mjs"), "utf8")));
} finally {
  try { await S.mongoose.connection.dropDatabase(); } catch { /* best effort */ }
  try { await S.mongoose.disconnect(); } catch { /* best effort */ }
}
console.log(`\nLearning L1.4 effectiveness machinery: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
