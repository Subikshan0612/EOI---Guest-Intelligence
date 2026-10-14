/**
 * Learning L1.1 - shared REPLAY + METRICS helpers. Evaluation only: it calls the existing, unchanged L1 modules (the same functions the shadow service uses) and never writes.
 * No Gemini, no embeddings, no feature flag. Imported by scripts/validate-learning-l1-replay.mjs (local synthetic evaluation) and by
 * scripts/phase41/atlas-learning-replay-readonly.mjs (read-only evaluation of the real database).
 */
import { loadCompletedCases } from "../../src/services/learning/completedCaseService.js";
import { deriveShadowLearningObservation } from "../../src/services/learning/caseLearningShadow.js";

const pct = (n, d) => (d === 0 ? null : Number(((100 * n) / d).toFixed(1)));
const bump = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };

/**
 * Replays EVERY completed case of the given workspaces as the "current" case through the real shadow path (the current Signal is excluded by the loader and again by the
 * comparison). Returns the per-case results plus a case index (opaque key -> facts) so metrics can verify what was retrieved.
 */
export async function replayWorkspaces(workspaceIds) {
  const caseIndex = new Map(); // caseKey -> { workspaceId, facts, signalId }
  const perWorkspaceCases = new Map();
  for (const ws of workspaceIds) {
    const { cases, considered, rejected } = await loadCompletedCases(ws);
    perWorkspaceCases.set(ws, { cases, considered, rejected });
    for (const c of cases) caseIndex.set(c.internal.caseKey, { workspaceId: ws, facts: c.facts, signalId: c.internal.signalId });
  }
  const results = [];
  for (const ws of workspaceIds) {
    for (const c of perWorkspaceCases.get(ws).cases) {
      const r = await deriveShadowLearningObservation({ workspaceId: ws, signalId: c.internal.signalId });
      results.push({ workspaceId: ws, caseKey: c.internal.caseKey, signalId: c.internal.signalId, facts: c.facts, observation: r.observation, selection: r.selection, derivation: r.derivation });
    }
  }
  return { results, caseIndex, perWorkspaceCases };
}

/** Everything that must be identical between two replays of the same data (selected keys in order, counts, pattern, dominant action, relevance, sufficiency). */
export const fingerprintOfResult = (r) => JSON.stringify({ key: r.caseKey, observation: r.observation, selected: r.selection.selected, excluded: r.selection.excluded, weak: r.selection.weakMatchCount });

/**
 * @param {{ results: object[], caseIndex: Map }} replay
 * @returns the metrics A-J of the L1.1 brief, computed from the replay alone
 */
export function computeMetrics({ results, caseIndex }, { derivedCases }) {
  const n = results.length;
  const m = { evaluated: n, derivedCases, coveragePct: pct(n, derivedCases) };
  // B similarity availability
  const sim = results.map((r) => r.observation.similarCaseCount);
  m.similarity = { zero: sim.filter((x) => x === 0).length, atLeastOne: sim.filter((x) => x >= 1).length, atLeastThree: sim.filter((x) => x >= 3).length, zeroPct: pct(sim.filter((x) => x === 0).length, n), atLeastOnePct: pct(sim.filter((x) => x >= 1).length, n), atLeastThreePct: pct(sim.filter((x) => x >= 3).length, n), weakMatchesTotal: results.reduce((s, r) => s + r.selection.weakMatchCount, 0), meanSimilar: n ? Number((sim.reduce((a, b) => a + b, 0) / n).toFixed(2)) : null, maxSimilar: n ? Math.max(...sim) : null };
  // C evidence sufficiency
  const reasons = {}; for (const r of results) bump(reasons, r.observation.insufficientReason ?? "SUFFICIENT");
  m.sufficiency = { sufficient: results.filter((r) => r.observation.sufficientEvidence).length, sufficientPct: pct(results.filter((r) => r.observation.sufficientEvidence).length, n), byReason: reasons };
  // E pattern distribution (all results, and sufficient only)
  const patterns = {}; for (const r of results) bump(patterns, r.observation.pattern);
  m.patterns = patterns;
  // D / F structural relevance of every retrieved pair
  const dims = { topic: 0, signalType: 0, severity: 0, unitType: 0, safety: 0 }; const tiers = { HIGH: 0, MEDIUM: 0 }; let pairs = 0; let topicPartial = 0;
  for (const r of results) {
    const cur = r.facts;
    for (const s of r.selection.selected) {
      pairs += 1; for (const d of s.matched) if (d in dims) dims[d] += 1; tiers[s.relevance] += 1;
      const cand = caseIndex.get(s.caseKey).facts;
      const identical = cur.issue.topics.length === cand.issue.topics.length && cur.issue.topics.every((t, i) => t === cand.issue.topics[i]);
      if (!identical) topicPartial += 1;
    }
  }
  m.retrieval = { retrievedPairs: pairs, dimensionMatchPct: Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, pct(v, pairs)])), tierCounts: tiers, structurallyClearlyRelevantPct: pct(tiers.HIGH, pairs), structurallyBorderlinePct: pct(tiers.MEDIUM, pairs), topicSetsNotIdenticalPct: pct(topicPartial, pairs) };
  // topic widening: how often does a multi-topic report exist, and how much of the MEDIUM tier comes from it
  const multi = results.filter((r) => r.facts.issue.topics.length >= 2).length;
  m.topicWidening = { currentCasesWithTwoOrMoreTopics: multi, currentCasesWithTwoOrMoreTopicsPct: pct(multi, n), mediumTierPairs: tiers.MEDIUM, mediumPairsFromMultiTopicCurrent: results.filter((r) => r.facts.issue.topics.length >= 2).reduce((s, r) => s + r.selection.selected.filter((x) => x.relevance === "MEDIUM").length, 0) };
  // G safety, H tenant, I self
  let safetyViolations = 0; let safetyCasesWithInfluence = 0; let crossWorkspace = 0; let selfMatches = 0; let safetyCases = 0;
  for (const r of results) {
    const cur = r.facts;
    if (cur.safety.state !== "NORMAL") { safetyCases += 1; if (r.observation.sufficientEvidence || r.observation.dominantActionType !== null || r.observation.pattern !== "INSUFFICIENT_EVIDENCE") safetyCasesWithInfluence += 1; }
    for (const s of r.selection.selected) {
      const cand = caseIndex.get(s.caseKey);
      if (!cand) { crossWorkspace += 1; continue; }
      if (cand.workspaceId !== r.workspaceId) crossWorkspace += 1;
      if (s.caseKey === r.caseKey || cand.signalId === r.signalId) selfMatches += 1;
      if (cand.facts.safety.state !== cur.safety.state || cand.facts.safety.rules.join() !== cur.safety.rules.join()) safetyViolations += 1;
    }
  }
  m.safety = { safetyConditionCases: safetyCases, safetyCasesWhereLearningInfluenced: safetyCasesWithInfluence, safetyIncompatibleRetrievals: safetyViolations };
  m.tenantIsolation = { crossWorkspaceRetrievals: crossWorkspace };
  m.selfExclusion = { selfRetrievals: selfMatches };
  return m;
}
