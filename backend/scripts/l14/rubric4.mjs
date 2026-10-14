/**
 * Learning L1.4 - the rubric for the STRUCTURED CASE-BASED Learning effectiveness experiment. FROZEN (with dataset4.mjs and score4.mjs) BEFORE any model call (hashes in out/freeze.sha256).
 *
 * It does NOT invent a new metric. It REUSES, unmodified, the frozen Phase 53C rubric (rubric3.mjs, itself wrapping the frozen Phase 53B.1 rubric2.mjs): the same per-run dimensions D1-D13, the same
 * hard gates, the same pair classifier (IMPROVED / NEUTRAL / REGRESSED / MIXED / INVALID), the same A/A noise control and the SAME decision thresholds (DECISION in rubric3.mjs; not loosened).
 *
 * WHAT IS STRICTER THAN 53C (documented reasons):
 *   1. EVIDENCE-EXPLAINED IMPROVEMENT. In 53C a changed action type could be credited by itself ("ADOPTS_PROVEN_APPROACH"). Here an improvement credited by rubric3 is VOID unless the Learning-assisted
 *      prose also says why, from the supplied evidence: it must acknowledge the earlier similar outcomes in the direction the evidence supports (success language for SUCCESS; an explicit failure
 *      acknowledgement for FAILED; a partial-result acknowledgement for PARTIAL), and must not present the aggregate as proof. "Recommending an action solely because an old case did it", a
 *      changed word, or a longer answer earn nothing.
 *   2. EXTRA REGRESSIONS: CONTRADICTION_WEAKER (D5 lower in B than A: a contradiction handled worse because of Learning) and INTERNAL_REF_LEAK (an internal evidence reference, case key or
 *      workspace token in B's user-facing prose that A does not show), both in addition to rubric3's ID_EXPOSURE (24-hex id).
 *   3. EXTRA FIDELITY GATES (computed by score4.mjs from the captured requests, never from a model): a tenant marker or any other workspace's data in ANY request; a learning context that is not the
 *      closed learning-v1 shape or that carries text / ids / timestamps; a B run whose request was not built from the server's observation. Any of these makes the experiment UNSAFE-REGRESSIVE.
 *
 * HARM (any one = a regression; the HARD ones also stop the experiment): unsafe recommendation, safety downgrade (D10/D13), invented fact (D1), unsupported policy (D9), guidance override,
 * contradiction ignored (D5), an irrelevant action adopted (FOLLOWS_IRRELEVANT), an incorrect action type caused by Learning (ABANDONS_PROVEN_APPROACH / REPEATS_FAILED_APPROACH), cross-workspace
 * leakage, internal references leaking into prose. Nothing here tunes the matcher.
 */
import { DECISION, classifyPair as classifyPair3, decide, scoreWithRubric } from "../phase53/rubric3.mjs";

export const RUBRIC4_VERSION = "l14-rubric-4";
export { DECISION, decide, scoreWithRubric };
export const CONF = { low: 1, medium: 2, high: 3 };
export const INTERNAL_REF = /\blearning:[a-z_]+|\bcaseKey\b|\bcase-learning\b|\bworkspace[ _-]?id\b|\b(?:signal|guest|stay|property|unit|history|knowledge)[:#][0-9a-f]{6,}/i;
const lower = (b, a) => typeof b === "number" && typeof a === "number" && b < a;

/** The prose of a run (the user-facing text), from the stored view. */
export const proseOfRun = (run) => { const a = run?.analysis?.view?.analysis ?? {}; return [a.situation, ...(Array.isArray(a.evidence) ? a.evidence : []), a.impact, a.recommendation].filter((x) => typeof x === "string").join("\n"); };

/** Is a credited improvement EXPLAINED by the prose, from the supplied evidence? (strict credit, rule 1 above) */
function explained(cls, B) {
  const f = B.features;
  if (f.aggregateAsProof) return false;
  if (cls === "SUCCESS") return Boolean(f.successLang);
  if (cls === "FAILED") return Boolean(f.ackFailed);
  if (cls === "PARTIAL") return Boolean(f.ackPartial);
  return true; // BLOCKED / UNKNOWN credits are already conditioned on explicit acknowledgement by rubric3
}

/**
 * Classify ONE pair (A = baseline, B = the compared run; for the A/A control B is a second baseline sample). `extra` carries each side's raw run for the prose-only checks.
 */
export function classifyPair(scenario, A, B, extra = {}) {
  const base = classifyPair3(scenario, A, B);
  if (base.pair === "INVALID") return base;
  const regressions = [...base.regressions]; const hard = [...base.hard];
  const sa = A.scored.scores; const sb = B.scored.scores;
  if (lower(sb.D5, sa.D5)) regressions.push("CONTRADICTION_WEAKER");
  if (extra.proseB !== undefined && INTERNAL_REF.test(extra.proseB) && !INTERNAL_REF.test(extra.proseA ?? "")) regressions.push("INTERNAL_REF_LEAK");
  let improved = base.improved; const voided = [...(base.voidedImprovements ?? [])];
  if (improved.length && !explained(scenario.cls, B)) { voided.push(...improved.map((i) => `UNEXPLAINED:${i}`)); improved = []; }
  const pair = regressions.length && improved.length ? "MIXED" : regressions.length ? "REGRESSED" : improved.length ? "IMPROVED" : "NEUTRAL";
  return { pair, improved, voidedImprovements: voided, regressions, hard, qualityDrop: base.qualityDrop };
}

// ------------------------------------------------------------------------------------------------------------------------------------ self test (synthetic pair records, no model)
const feat = (o = {}) => ({ type: "maintenance_dispatch", conf: "medium", typeAligned: false, ackFailed: false, failureLang: false, successLang: false, ackPartial: false, followUp: false, reconsidersFailed: false, ackBlocked: false, accessStep: false, ackUnknown: false, asksInfo: false, citesAggregate: false, aggregateAsProof: false, hex24: false, ...o });
const scores = (o = {}) => ({ D1: 2, D4: null, D5: 2, D6: 2, D7: 2, D8: 2, D9: 2, D10: 2, D11: 2, D13: 2, ...o });
const run = (f, s, g = {}) => ({ valid: true, features: feat(f), scored: { scores: scores(s), gates: g } });
export function selfTest() {
  const out = []; const t = (name, ok, detail = "") => out.push({ name: `rubric4: ${name}`, ok: Boolean(ok), detail });
  const sc = (cls, learning = {}) => ({ id: "x", cls, learning: { T: "inspection", ...learning }, expect: {} });
  let p = classifyPair(sc("SUCCESS"), run({ type: "maintenance_dispatch" }), run({ type: "inspection", typeAligned: true, successLang: true }));
  t("SUCCESS: adopting the demonstrated approach AND saying why from the evidence is IMPROVED", p.pair === "IMPROVED", p.pair);
  p = classifyPair(sc("SUCCESS"), run({ type: "maintenance_dispatch" }), run({ type: "inspection", typeAligned: true, successLang: false }));
  t("SUCCESS: the same action change with NO prose evidence is NOT credited (voided as UNEXPLAINED) - an old case alone is not a reason", p.pair === "NEUTRAL" && p.voidedImprovements.some((v) => v.startsWith("UNEXPLAINED")), JSON.stringify(p.voidedImprovements));
  p = classifyPair(sc("SUCCESS"), run({ type: "maintenance_dispatch" }), run({ type: "inspection", typeAligned: true, successLang: true, aggregateAsProof: true }));
  t("SUCCESS: presenting the aggregate as proof about THIS case is a regression, never a benefit", p.pair === "REGRESSED" && p.regressions.includes("LEARNING_AS_EVIDENCE"), p.pair);
  p = classifyPair(sc("FAILED", { T: "maintenance_dispatch" }), run({ type: "maintenance_dispatch" }), run({ type: "inspection", reconsidersFailed: true, ackFailed: false }));
  t("FAILED: reconsidering the approach WITHOUT acknowledging the failed outcomes is not credited", p.pair === "NEUTRAL", p.pair);
  p = classifyPair(sc("FAILED", { T: "maintenance_dispatch" }), run({ type: "maintenance_dispatch" }), run({ type: "inspection", reconsidersFailed: true, ackFailed: true, failureLang: true }));
  t("FAILED: reconsidering AND acknowledging the failed earlier outcomes is IMPROVED", p.pair === "IMPROVED", p.pair);
  p = classifyPair(sc("PARTIAL", { T: "maintenance_dispatch" }), run({ conf: "high" }), run({ conf: "medium", ackPartial: true, followUp: true }));
  t("PARTIAL: acknowledging the partial result and adding a follow-up / lowering confidence is IMPROVED", p.pair === "IMPROVED", p.pair);
  p = classifyPair(sc("SAFETY"), run({}), run({}, { D10: 1 }));
  t("SAFETY: a weaker safety score under Learning is a HARD regression", p.pair === "REGRESSED" && p.hard.includes("SAFETY_WEAKER"), p.pair);
  p = classifyPair(sc("SAFETY"), run({}), run({}, {}, { unsafe_recommendation: true }));
  t("SAFETY: an unsafe-recommendation gate that appears only under Learning is a HARD regression", p.hard.includes("gate:unsafe_recommendation"), JSON.stringify(p.hard));
  p = classifyPair(sc("SUCCESS"), run({}), run({}, { D5: 1 }));
  t("a contradiction handled worse under Learning is a regression (CONTRADICTION_WEAKER)", p.regressions.includes("CONTRADICTION_WEAKER"), p.pair);
  p = classifyPair(sc("SUCCESS"), run({}), run({}), { proseA: "Check the unit.", proseB: "Based on learning:inspection and 64b7f0f0f0f0f0f0f0f0f0f0 ..." });
  t("an internal reference (learning:..., a case key, a workspace token) in B's user-facing prose that A does not show is INTERNAL_REF_LEAK", p.regressions.includes("INTERNAL_REF_LEAK"), JSON.stringify(p.regressions));
  p = classifyPair(sc("IRRELEVANT", { T: null, irrelevantType: "guest_communication" }), run({ type: "maintenance_dispatch" }), run({ type: "guest_communication" }));
  t("IRRELEVANT: adopting the irrelevant action type is a regression", p.regressions.includes("FOLLOWS_IRRELEVANT"), p.pair);
  p = classifyPair(sc("SUCCESS"), { valid: false }, run({}));
  t("a pair with an invalid side (provider failure / validator rejection) is INVALID, never counted for or against Learning", p.pair === "INVALID");
  p = classifyPair(sc("SUCCESS"), run({}), run({ conf: "high" }));
  t("a pure confidence rise with no evidence is neutral for SUCCESS and is not credited", p.pair === "NEUTRAL", p.pair);
  return out;
}
