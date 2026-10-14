/**
 * Retrieval evaluation metrics (Phase 26). Pure, deterministic, no I/O. Every metric is defined in
 * docs/RETRIEVAL_EVALUATION_PHASE26.md; this file is the executable definition.
 *
 * A case is scored from
 *   ranked  - the chunk keys the retriever returned, best first (already cut to the K under test)
 *   labels  - Map(chunkKey -> grade 0..3): EVERY labelled chunk of the case (grade-0 entries are the explicit distractors)
 * Unlabelled returned chunks have unknown relevance: they count as gain 0 for nDCG, never as relevant, and are reported separately.
 *
 * RELEVANT means grade >= 2 (RELEVANT_MIN_GRADE). Grade 1 ("related but insufficient") is neither relevant nor an explicit distractor.
 */
export const RELEVANT_MIN_GRADE = 2;

export const gain = (grade) => 2 ** grade - 1;

export function relevantKeys(labels) {
  return [...labels.entries()].filter(([, grade]) => grade >= RELEVANT_MIN_GRADE).map(([key]) => key);
}

/** DCG of a list of grades, first `k` positions, log2(rank + 1) discount. */
export function dcg(grades, k) {
  return grades.slice(0, k).reduce((sum, grade, i) => sum + gain(grade) / Math.log2(i + 2), 0);
}

/**
 * Metrics of ONE case that has at least one relevant chunk.
 * @returns {{ recall: number, hit: number, reciprocalRank: number, ndcg: number }}
 */
export function scorePositiveCase(ranked, labels, k) {
  const list = ranked.slice(0, k);
  const relevant = new Set(relevantKeys(labels));
  if (relevant.size === 0) throw new Error("scorePositiveCase needs at least one relevant chunk");
  const found = list.filter((key) => relevant.has(key));
  const firstIndex = list.findIndex((key) => relevant.has(key));
  const gradesInOrder = list.map((key) => labels.get(key) ?? 0);
  const ideal = [...labels.values()].sort((a, b) => b - a);
  const idcg = dcg(ideal, k);
  return {
    recall: new Set(found).size / relevant.size,
    hit: found.length > 0 ? 1 : 0,
    reciprocalRank: firstIndex === -1 ? 0 : 1 / (firstIndex + 1),
    ndcg: idcg === 0 ? 0 : dcg(gradesInOrder, k) / idcg,
  };
}

const mean = (values) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);
const round = (value, digits = 4) => (value === null || value === undefined || !Number.isFinite(value) ? value : Number(value.toFixed(digits)));

/**
 * Aggregate over a set of case outcomes.
 * @param {{ caseId: string, ranked: string[], labels: Map<string,number>, expectedNoRelevantKnowledge: boolean, evaluated: number, rejectedByThreshold: number }[]} outcomes
 *   `ranked` is the FINAL list for the configuration under test (floor and K already applied).
 *   `evaluated` is how many compatible candidates were scored; `rejectedByThreshold` how many of them the floor dropped.
 */
export function aggregate(outcomes, k) {
  const positives = outcomes.filter((o) => relevantKeys(o.labels).length > 0);
  const noRelevant = outcomes.filter((o) => relevantKeys(o.labels).length === 0);
  const scored = positives.map((o) => scorePositiveCase(o.ranked, o.labels, k));

  const returnedTotal = outcomes.reduce((n, o) => n + o.ranked.slice(0, k).length, 0);
  let distractorsReturned = 0;
  let grade1Returned = 0;
  let relevantReturned = 0;
  let unlabelledReturned = 0;
  let casesWithDistractor = 0;
  for (const o of outcomes) {
    let sawDistractor = false;
    for (const key of o.ranked.slice(0, k)) {
      const grade = o.labels.get(key);
      if (grade === undefined) unlabelledReturned += 1;
      else if (grade === 0) {
        distractorsReturned += 1;
        sawDistractor = true;
      } else if (grade === 1) grade1Returned += 1;
      else relevantReturned += 1;
    }
    if (sawDistractor) casesWithDistractor += 1;
  }
  const evaluatedTotal = outcomes.reduce((n, o) => n + o.evaluated, 0);
  const rejectedTotal = outcomes.reduce((n, o) => n + o.rejectedByThreshold, 0);

  return {
    k,
    positiveCases: positives.length,
    noRelevantCases: noRelevant.length,
    recall: round(mean(scored.map((s) => s.recall))),
    hitRate: round(mean(scored.map((s) => s.hit))),
    mrr: round(mean(scored.map((s) => s.reciprocalRank))),
    ndcg: round(mean(scored.map((s) => s.ndcg))),
    // no-relevant cases: "detected" = the retriever returned NOTHING (an empty result is CORRECT here, and is never counted as a miss)
    noRelevantDetectionRate: round(noRelevant.length === 0 ? null : noRelevant.filter((o) => o.ranked.slice(0, k).length === 0).length / noRelevant.length),
    // positive cases where nothing at all was returned (the floor removed everything although relevant knowledge exists)
    emptyResultRateOnPositiveCases: round(positives.length === 0 ? null : positives.filter((o) => o.ranked.slice(0, k).length === 0).length / positives.length),
    returnedChunks: returnedTotal,
    meanReturnedPerCase: round(outcomes.length === 0 ? null : returnedTotal / outcomes.length, 3),
    relevantReturned,
    grade1Returned,
    distractorsReturned,
    unlabelledReturned,
    // share of RETURNED chunks that are explicitly labelled grade-0 distractors
    falsePositiveRate: round(returnedTotal === 0 ? null : distractorsReturned / returnedTotal),
    casesReturningAnExplicitDistractor: casesWithDistractor,
    // share of scored compatible candidates the floor rejected
    thresholdRejectionRate: round(evaluatedTotal === 0 ? null : rejectedTotal / evaluatedTotal),
  };
}

/** Standard error of a mean by a seeded bootstrap over cases (how much a metric would move with a different draw of the same kind of cases). */
export function bootstrapStandardError(values, { draws = 2000, seed = 20260928 } = {}) {
  if (values.length === 0) return null;
  const rand = mulberry32(seed);
  const means = [];
  for (let d = 0; d < draws; d += 1) {
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) sum += values[Math.floor(rand() * values.length)];
    means.push(sum / values.length);
  }
  const mu = means.reduce((a, b) => a + b, 0) / draws;
  return round(Math.sqrt(means.reduce((a, b) => a + (b - mu) ** 2, 0) / (draws - 1)));
}

// ------------------------------------------------------------------ seeded random ranking baseline (chance level for THIS corpus)
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Expected Recall@K / MRR@K / nDCG@K of a RANDOM ordering of each case's eligible candidates (mean over `draws` seeded shuffles per case).
 * The reference "no signal" level: a retriever whose numbers are not clearly above it has not demonstrated any ranking ability.
 */
export function randomBaseline(cases, ks, { draws = 400, seed = 20260928 } = {}) {
  const rand = mulberry32(seed);
  const out = {};
  for (const k of ks) out[k] = { recall: [], mrr: [], ndcg: [], hit: [] };
  for (const c of cases) {
    if (relevantKeys(c.labels).length === 0) continue;
    for (const k of ks) {
      const acc = { recall: 0, mrr: 0, ndcg: 0, hit: 0 };
      for (let d = 0; d < draws; d += 1) {
        const order = [...c.candidateKeys];
        for (let i = order.length - 1; i > 0; i -= 1) {
          const j = Math.floor(rand() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        const s = scorePositiveCase(order, c.labels, k);
        acc.recall += s.recall;
        acc.mrr += s.reciprocalRank;
        acc.ndcg += s.ndcg;
        acc.hit += s.hit;
      }
      out[k].recall.push(acc.recall / draws);
      out[k].mrr.push(acc.mrr / draws);
      out[k].ndcg.push(acc.ndcg / draws);
      out[k].hit.push(acc.hit / draws);
    }
  }
  return Object.fromEntries(ks.map((k) => [k, { recall: round(mean(out[k].recall)), mrr: round(mean(out[k].mrr)), ndcg: round(mean(out[k].ndcg)), hitRate: round(mean(out[k].hit)) }]));
}
