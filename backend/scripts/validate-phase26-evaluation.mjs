/**
 * Phase 26 validation: the retrieval evaluation and grounding harness.
 *
 *   D  dataset quality (static): unique ids, labels with rationales, category coverage, no-relevant cases really have no relevant chunk,
 *      no accidental personal data, every reference resolves to a document section, workspace/visibility of every label
 *   M  metric definitions against hand-computed values (multi-relevant Recall, MRR, graded nDCG, no-relevant handling, false positives)
 *   O  offline guards: real keys / external URLs / non-test providers are refused, non-loopback fetch is blocked
 *   R  the harness itself: real ingestion, every reference exists, PRODUCTION PARITY, sweep invariants, reproducibility (two full runs
 *      give identical deterministic results and match the checked-in results file), security exclusion, grounding subset,
 *      production defaults untouched, database counts identical before/after
 *
 * This validates the HARNESS and the dataset. It does NOT assert any retrieval-quality number for the hash embedder (those measure a
 * no-signal retriever) - the only quality-shaped assertions are properties that must hold for the ORACLE fixture by construction.
 */
const launchEnv = { ...process.env }; // before backend/.env is loaded by the imports below
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = await import("../evaluation/retrieval/lib.mjs");
const metrics = await import("../evaluation/retrieval/metrics.mjs");
const { DEFAULT_RETRIEVAL_MIN_SIMILARITY, getRetrievalMinSimilarity } = await import("../src/config/runtimeConfig.js");
const { TOP_K } = await import("../src/services/knowledgeRetrievalService.js");

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
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const throwsWith = (fn, re) => {
  try {
    fn();
    return false;
  } catch (error) {
    return re.test(error.message);
  }
};

// ------------------------------------------------------------------ O. offline guards
try {
  lib.assertOfflineEnvironment(launchEnv);
  check("O the launching shell environment carries no real provider key, no external AI URL and no non-test provider", true);
} catch (error) {
  check("O the launching shell environment carries no real provider key, no external AI URL and no non-test provider", false, error.message);
}
check("O a real-looking GEMINI_API_KEY is refused", throwsWith(() => lib.assertOfflineEnvironment({ GEMINI_API_KEY: "AIza-not-a-real-key-but-looks-like-one" }), /GEMINI_API_KEY is set/));
check("O a real-looking OPENAI_API_KEY is refused", throwsWith(() => lib.assertOfflineEnvironment({ OPENAI_API_KEY: "sk-abcdef" }), /OPENAI_API_KEY is set/));
check("O a placeholder or empty key is not a real key", (() => { try { lib.assertOfflineEnvironment({ OPENAI_API_KEY: "your_api_key_here", GEMINI_API_KEY: "" }); return true; } catch { return false; } })());
check("O a non-loopback AI_SERVICE_URL is refused", throwsWith(() => lib.assertOfflineEnvironment({ AI_SERVICE_URL: "https://ai.example.com" }), /not a loopback/));
check("O a loopback AI_SERVICE_URL is accepted", (() => { try { lib.assertOfflineEnvironment({ AI_SERVICE_URL: "http://127.0.0.1:8010", LLM_PROVIDER: "test-python", EMBEDDING_PROVIDER: "test" }); return true; } catch { return false; } })());
check("O a real embedding or LLM provider is refused", throwsWith(() => lib.assertOfflineEnvironment({ EMBEDDING_PROVIDER: "gemini" }), /not the test provider/) && throwsWith(() => lib.assertOfflineEnvironment({ LLM_PROVIDER: "gemini" }), /not a test provider/));
lib.installOfflineFetchGuard();
let blocked = false;
try {
  await fetch("https://example.invalid/");
} catch (error) {
  blocked = /blocked a request to a non-loopback host/.test(error.message);
}
check("O the evaluator process cannot make a non-loopback request (global fetch guard)", blocked);
const scrubEnv = { GEMINI_API_KEY: "x", OPENAI_API_KEY: "", GOOGLE_API_KEY: "y" };
check("O provider keys injected by backend/.env are scrubbed from the process and reported by name only", stableEq(lib.scrubProviderKeys(scrubEnv), ["GEMINI_API_KEY", "GOOGLE_API_KEY"]) && scrubEnv.GEMINI_API_KEY === "" && scrubEnv.GOOGLE_API_KEY === "");
function stableEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ------------------------------------------------------------------ M. metric definitions (hand-computed)
{
  const labels = new Map([["a", 3], ["b", 2], ["c", 1], ["d", 0]]);
  const s2 = metrics.scorePositiveCase(["c", "a", "d", "b"], labels, 2);
  const dcg2 = (2 ** 1 - 1) / Math.log2(2) + (2 ** 3 - 1) / Math.log2(3);
  const idcg2 = (2 ** 3 - 1) / Math.log2(2) + (2 ** 2 - 1) / Math.log2(3);
  check("M Recall@2 counts the FULL relevant set: 1 of the 2 relevant chunks {a,b} is in the top 2", near(s2.recall, 0.5));
  check("M hit and reciprocal rank: the first relevant chunk (a) is at rank 2", s2.hit === 1 && near(s2.reciprocalRank, 0.5));
  check("M nDCG@2 with graded gains (2^grade - 1): DCG [c,a] / ideal DCG [a,b], hand computed", near(s2.ndcg, dcg2 / idcg2), `${s2.ndcg} vs ${dcg2 / idcg2}`);
  const s4 = metrics.scorePositiveCase(["c", "a", "d", "b"], labels, 4);
  check("M Recall@4 reaches 1 when both relevant chunks are in the list; rank of the first relevant is unchanged", near(s4.recall, 1) && near(s4.reciprocalRank, 0.5));
  const dcg4 = (2 ** 1 - 1) / Math.log2(2) + (2 ** 3 - 1) / Math.log2(3) + 0 + (2 ** 2 - 1) / Math.log2(5);
  const idcg4 = 7 / Math.log2(2) + 3 / Math.log2(3) + 1 / Math.log2(4) + 0;
  check("M nDCG@4 hand computed (a grade-0 chunk contributes nothing, ideal order 3,2,1,0)", near(s4.ndcg, dcg4 / idcg4), `${s4.ndcg} vs ${dcg4 / idcg4}`);
  const miss = metrics.scorePositiveCase(["d", "x"], labels, 5); // a distractor and an unlabelled chunk
  check("M only a distractor and an unlabelled chunk returned -> recall, hit, reciprocal rank and nDCG are all 0 (a grade-1 chunk would earn partial nDCG credit, by design)", miss.recall === 0 && miss.hit === 0 && miss.reciprocalRank === 0 && miss.ndcg === 0);
  check("M a list whose relevant chunk is beyond K scores 0 at that K (K cuts the list)", metrics.scorePositiveCase(["c", "d", "a"], labels, 2).hit === 0);
  check("M perfect ranking gives nDCG exactly 1", near(metrics.scorePositiveCase(["a", "b", "c", "d"], labels, 4).ndcg, 1));
  check("M scoring a case with no relevant chunk is refused (it belongs to the no-relevant metrics)", throwsWith(() => metrics.scorePositiveCase(["a"], new Map([["a", 1]]), 5), /at least one relevant/));

  const outcome = (caseId, ranked, labelsList, evaluated = 10, rejected = 0) => ({ caseId, ranked, labels: new Map(labelsList), expectedNoRelevantKnowledge: !labelsList.some(([, g]) => g >= 2), evaluated, rejectedByThreshold: rejected });
  const agg = metrics.aggregate(
    [
      outcome("p1", ["a", "x"], [["a", 3], ["x", 0]], 10, 4),
      outcome("p2", ["z"], [["b", 3]], 10, 6), // z is unlabelled, b never returned
      outcome("n1", [], []), // no-relevant, nothing returned: a CORRECT detection
      outcome("n2", ["y"], [["y", 1]]), // no-relevant, returned a grade-1 chunk: not detected
    ],
    5,
  );
  check("M aggregate: Recall is averaged over the two POSITIVE cases only ((1 + 0) / 2)", agg.positiveCases === 2 && near(agg.recall, 0.5));
  check("M aggregate: MRR ((1 + 0) / 2) and hit rate (1 of 2)", near(agg.mrr, 0.5) && near(agg.hitRate, 0.5));
  check("M aggregate: an EMPTY result on a no-relevant case is a detection, not a retrieval failure (1 of 2)", agg.noRelevantCases === 2 && near(agg.noRelevantDetectionRate, 0.5));
  check("M aggregate: the empty result on the no-relevant case is not counted against the positive cases", agg.emptyResultRateOnPositiveCases === 0);
  check("M aggregate: false-positive rate = returned explicit distractors / returned chunks (1 of 4)", agg.distractorsReturned === 1 && agg.returnedChunks === 4 && near(agg.falsePositiveRate, 0.25));
  check("M aggregate: grade-1 and unlabelled returns are counted separately, not as relevant or as false positives", agg.grade1Returned === 1 && agg.unlabelledReturned === 1 && agg.relevantReturned === 1);
  check("M aggregate: threshold rejection rate = rejected / scored candidates ((4 + 6) / 40 over all four cases' 10 each)", near(agg.thresholdRejectionRate, 10 / 40));
  const emptyPositive = metrics.aggregate([outcome("p", [], [["a", 3]])], 5);
  check("M a positive case answered with NOTHING is reported as an empty result on a positive case (a floor problem), with recall 0", emptyPositive.emptyResultRateOnPositiveCases === 1 && emptyPositive.recall === 0);

  const candidates = { labels: new Map([["r", 3], ["u", 0], ["v", 0], ["w", 0]]), candidateKeys: ["r", "u", "v", "w"] };
  const rb = metrics.randomBaseline([candidates], [1, 4], { draws: 2000, seed: 7 });
  const rb2 = metrics.randomBaseline([candidates], [1, 4], { draws: 2000, seed: 7 });
  check("M random baseline: Recall@1 of a random order of 4 candidates with 1 relevant is about 0.25; Recall@4 is exactly 1", Math.abs(rb[1].recall - 0.25) < 0.03 && rb[4].recall === 1);
  check("M random baseline is deterministic for a given seed", JSON.stringify(rb) === JSON.stringify(rb2));
  const se1 = metrics.bootstrapStandardError([0, 1, 0, 1, 1, 0, 0, 1], { draws: 500, seed: 3 });
  check("M bootstrap standard error is deterministic and plausible (about sqrt(0.25 / 8))", se1 === metrics.bootstrapStandardError([0, 1, 0, 1, 1, 0, 0, 1], { draws: 500, seed: 3 }) && Math.abs(se1 - Math.sqrt(0.25 / 8)) < 0.04);
}

// ------------------------------------------------------------------ D. dataset quality (static)
const { dataset, sha256 } = lib.loadDataset();
{
  const docs = new Map(dataset.corpus.documents.map((d) => [d.key, d]));
  const headingsOf = (doc) => [...doc.content.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  check("D the dataset declares a version, a synthetic-data notice and the label scale", /^\d+\.\d+\.\d+$/.test(dataset.datasetVersion) && /SYNTHETIC/.test(dataset.notice) && Object.keys(dataset.labelScale).join(",") === "0,1,2,3" && /grade >= 2/.test(dataset.binaryRelevanceRule));
  check("D dataset size is within 15-30 cases (23) with 4 separate security cases", dataset.cases.length >= 15 && dataset.cases.length <= 30 && dataset.securityCases.length === 4, `${dataset.cases.length}`);
  const ids = [...dataset.cases.map((c) => c.caseId), ...dataset.securityCases.map((c) => c.caseId)];
  check("D case ids are unique", new Set(ids).size === ids.length);
  check("D document keys are unique and every document has a title and content", new Set(dataset.corpus.documents.map((d) => d.key)).size === docs.size && dataset.corpus.documents.every((d) => d.title && d.content.includes("## ")));
  const categories = new Set(dataset.cases.map((c) => c.category[0]));
  check("D categories A-I are all covered by cases (J, security isolation, is the separate securityCases block)", ["A", "B", "C", "D", "E", "F", "G", "H", "I"].every((letter) => categories.has(letter)));
  check("D every case has a signal (type, title, description), notes and a boolean no-relevant flag", dataset.cases.every((c) => c.signal?.type && c.signal.title && c.signal.description && c.notes && typeof c.expectedNoRelevantKnowledge === "boolean"));
  const refExists = (ref) => {
    const [docKey, heading] = ref.split("#");
    return docs.has(docKey) && headingsOf(docs.get(docKey)).includes(heading);
  };
  const allLabels = dataset.cases.flatMap((c) => c.labels.map((l) => ({ c, l })));
  check("D every label references an existing document section", allLabels.every(({ l }) => refExists(l.chunk)), allLabels.filter(({ l }) => !refExists(l.chunk)).map(({ l }) => l.chunk).join(","));
  check("D every label has a grade in 0..3 and a non-trivial human-readable rationale", allLabels.every(({ l }) => [0, 1, 2, 3].includes(l.grade) && typeof l.rationale === "string" && l.rationale.trim().length >= 20));
  check("D every grade-0 label names its distractor kind (strong, near-topic or exact-keyword)", allLabels.filter(({ l }) => l.grade === 0).every(({ l }) => ["strong", "near-topic", "exact-keyword"].includes(l.kind)));
  check("D no case labels the same chunk twice", dataset.cases.every((c) => new Set(c.labels.map((l) => l.chunk)).size === c.labels.length));
  check("D every no-relevant case has NO chunk graded >= 2", dataset.cases.filter((c) => c.expectedNoRelevantKnowledge).every((c) => c.labels.every((l) => l.grade < 2)));
  check("D every case that is not a no-relevant case has at least one chunk graded >= 2", dataset.cases.filter((c) => !c.expectedNoRelevantKnowledge).every((c) => c.labels.some((l) => l.grade >= 2)));
  check("D the dataset contains no-relevant cases of both kinds (empty label list, and documented judgment)", dataset.cases.some((c) => c.expectedNoRelevantKnowledge && c.labels.length === 0) && dataset.cases.some((c) => c.expectedNoRelevantKnowledge && c.labels.length > 0));
  check("D multi-relevant coverage: at least two cases have more than one chunk graded >= 2", dataset.cases.filter((c) => c.labels.filter((l) => l.grade >= 2).length > 1).length >= 2);
  const relevantDocs = allLabels.filter(({ l }) => l.grade >= 2).map(({ l }) => docs.get(l.chunk.split("#")[0]));
  check("D every relevant chunk belongs to the EVALUATION workspace and is visible at the staff ceiling (never foreign, never restricted)", relevantDocs.every((d) => d.workspace === "eval" && d.visibility !== "restricted"));
  check("D every label (relevant or distractor) belongs to the evaluation workspace", allLabels.every(({ l }) => docs.get(l.chunk.split("#")[0]).workspace === "eval"));
  check("D every security case forbids only chunks that exist and are foreign-workspace or restricted", dataset.securityCases.every((s) => s.forbiddenChunks.length > 0 && s.forbiddenChunks.every((ref) => refExists(ref) && (docs.get(ref.split("#")[0]).workspace === "foreign" || docs.get(ref.split("#")[0]).visibility === "restricted"))));
  check("D the security cases cover foreign workspace, restricted visibility, forged workspace selector and forged visibility selector", ["foreign_workspace", "restricted_visibility", "forged_workspace_selector", "forged_visibility_selector"].every((t) => dataset.securityCases.some((s) => s.type === t)));
  const text = JSON.stringify(dataset);
  check("D no e-mail address, phone number, URL or personal-identifier pattern appears anywhere in the dataset", !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) && !/\+?\d[\d\s().-]{8,}\d/.test(text) && !/https?:\/\//i.test(text) && !/\b(passport|ssn|social security|credit card)\b/i.test(text));
  check("D no query contains an answer-bearing procedure phrase copied from a label (queries describe the signal only)", dataset.cases.every((c) => !/\b(escalate to|isolation valve|re-encode|encode a new|call the on-call)\b/i.test(`${c.signal.title} ${c.signal.description}`)));
}

// ------------------------------------------------------------------ R. the harness, end to end
const artifactPath = path.join(here, "..", "evaluation", "results", "phase26-retrieval-results.json");
const runOnce = () => lib.withEvaluationEnvironment((ctx) => lib.runEvaluation(ctx), { scrubbed: lib.scrubProviderKeys() });
const run1 = await runOnce();
const run2 = await runOnce();
const r = run1.result;
const h = r.modes.hash;
const o = r.modes.oracle;

check("R the database counts are identical before and after each full evaluation run (throwaway fixtures removed)", JSON.stringify(run1.countsBefore) === JSON.stringify(run1.countsAfter) && JSON.stringify(run2.countsBefore) === JSON.stringify(run2.countsAfter), `${JSON.stringify(run1.countsBefore)} / ${JSON.stringify(run1.countsAfter)}`);
check("R the ingested corpus matches the dataset: every document produced its sections as chunks (35), every labelled reference resolves to a real chunk", r.meta.dataset.chunks === dataset.corpus.documents.reduce((n, d) => n + [...d.content.matchAll(/^## /gm)].length, 0));
const chunkKeys = new Set(h.perCase.flatMap((p) => [...p.relevant.map((x) => x.chunk), ...p.returned.map((x) => x.chunk)]));
check("R every relevant chunk of every case was actually ingested and scored (each has a similarity in every case's run)", h.perCase.every((p) => p.relevant.every((x) => typeof x.similarity === "number" && x.rankAmongAllCompatible >= 1)) && chunkKeys.size > 0);
const eligibleExpected = dataset.corpus.documents.filter((d) => d.workspace === "eval" && d.visibility !== "restricted").reduce((n, d) => n + [...d.content.matchAll(/^## /gm)].length, 0);
check("R the quality denominator holds ONLY legitimate candidates: every case saw exactly the evaluation workspace's staff-visible chunks (foreign and restricted are not candidates)", [...h.perCase, ...o.perCase].every((p) => p.eligibleCandidates === eligibleExpected && p.compatibleCandidates === eligibleExpected && p.incompatibleCandidates === 0), `expected ${eligibleExpected}`);
check("R PARITY: at the baseline, the harness selection equals the PRODUCTION retrieveKnowledgeForContext output for every case, in both modes", h.productionParityAtBaseline.identical && o.productionParityAtBaseline.identical && h.productionParityAtBaseline.cases.length === dataset.cases.length);
check("R the baseline configuration is the production one: dense, test embedder, floor 0.25, top-K 5, cosine", r.meta.baselineConfiguration.floor === 0.25 && r.meta.baselineConfiguration.topK === 5 && r.meta.baselineConfiguration.retrieval === "dense" && r.meta.baselineConfiguration.embeddingModel === "deterministic-embedding-v1");
check("R the harness left the PRODUCTION defaults untouched (floor 0.25 with no override, top-K 5)", DEFAULT_RETRIEVAL_MIN_SIMILARITY === 0.25 && TOP_K === 5 && (delete process.env.KOI_RETRIEVAL_MIN_SIMILARITY, getRetrievalMinSimilarity() === 0.25));

// sweep structure and invariants that must hold for ANY retriever
const invariants = (mode, label) => {
  const t = mode.thresholdSweep;
  check(`R ${label}: the threshold sweep covers 0.00 .. 0.80 (14 steps) and the K sweep covers 1, 3, 5, 8, 10`, stableEq(t.map((x) => x.threshold), lib.THRESHOLDS) && stableEq(mode.kSweepAtBaselineThreshold.map((x) => x.k), lib.KS) && stableEq(mode.kSweepAtZeroThreshold.map((x) => x.k), lib.KS));
  check(`R ${label}: raising the floor never increases the number of returned chunks, and never lowers the rejection rate`, t.every((x, i) => i === 0 || (x.returnedChunks <= t[i - 1].returnedChunks && x.thresholdRejectionRate >= t[i - 1].thresholdRejectionRate)));
  check(`R ${label}: raising the floor never lowers the no-relevant detection rate (fewer results can only mean more empty results)`, t.every((x, i) => i === 0 || x.noRelevantDetectionRate >= t[i - 1].noRelevantDetectionRate));
  check(`R ${label}: a larger K never lowers Recall or hit rate (floor 0 and floor 0.25)`, [mode.kSweepAtZeroThreshold, mode.kSweepAtBaselineThreshold].every((sweep) => sweep.every((x, i) => i === 0 || (x.recall >= sweep[i - 1].recall && x.hitRate >= sweep[i - 1].hitRate))));
  check(`R ${label}: every reported rate is within [0, 1]`, [...t, ...mode.kSweepAtZeroThreshold].every((x) => ["recall", "hitRate", "mrr", "ndcg", "noRelevantDetectionRate", "emptyResultRateOnPositiveCases", "thresholdRejectionRate"].every((k) => x[k] === null || (x[k] >= 0 && x[k] <= 1))));
  check(`R ${label}: the sweep row at 0.25 / K=5 equals the reported baseline`, JSON.stringify({ ...t.find((x) => x.threshold === 0.25) }) === JSON.stringify({ ...mode.baseline }));
  check(`R ${label}: similarity scores are valid cosines in [-1, 1] and the per-case ranking is in descending retrieval score`, mode.perCase.every((p) => p.returned.every((x, i, list) => x.similarity >= -1 && x.similarity <= 1 && (i === 0 || list[i - 1].retrievalScore >= x.retrievalScore))));
  check(`R ${label}: the random-ranking reference is reported for every K`, stableEq(Object.keys(mode.randomRankingBaseline.byK).map(Number), lib.KS));
};
invariants(h, "hash");
invariants(o, "oracle");

// oracle: properties that hold BY CONSTRUCTION (these validate the harness; they say nothing about a real embedding model)
check("R oracle (by construction): with a floor at or below the relevant grades, every relevant chunk is retrieved at K=5 (Recall, hit rate and MRR = 1)", o.baseline.recall === 1 && o.baseline.hitRate === 1 && o.baseline.mrr === 1 && o.baseline.ndcg > 0.99);
check("R oracle (by construction): the floor at 0.80 (above the designed relevant cosines of 0.70) loses relevant chunks, and at 0.50 the grade-1 chunks drop out", o.thresholdSweep.find((x) => x.threshold === 0.8).recall < 1 && o.thresholdSweep.find((x) => x.threshold === 0.5).noRelevantDetectionRate === 1);
check("R oracle (by construction): K=1 cannot hold a case's two relevant chunks (Recall@1 < 1) while K>=3 can", o.kSweepAtBaselineThreshold[0].recall < 1 && o.kSweepAtBaselineThreshold[1].recall === 1);
check("R oracle: the designed similarity distribution is what was measured (grade-3 = 0.85, grade-2 = 0.70, grade-1 = 0.45, unlabelled <= 0.15)", o.similarityByGrade.grade3.median === 0.85 && o.similarityByGrade.grade2.median === 0.7 && o.similarityByGrade.grade1.median === 0.45 && o.similarityByGrade.unlabelled.max <= 0.15);
// hash: the pipeline behaves, and the numbers are what a no-signal retriever gives - only NON-quality facts are asserted
check("R hash: the test embedder carries no relevance signal - the median similarity of relevant chunks is within 0.05 of that of unlabelled chunks", Math.abs(h.similarityByGrade.grade3.median - h.similarityByGrade.unlabelled.median) < 0.05);
check("R hash: the ranking-only uncertainty is reported (bootstrap standard error over the positive cases)", h.rankingOnlyUncertaintyAtK5.positiveCases === 19 && h.rankingOnlyUncertaintyAtK5.standardError.recall > 0);
check("R the failure taxonomy accounts for every case exactly once", h.failureTaxonomyAtBaseline.rows.length === dataset.cases.length && o.failureTaxonomyAtBaseline.rows.length === dataset.cases.length && Object.values(h.failureTaxonomyAtBaseline.counts).reduce((a, b) => a + b, 0) === dataset.cases.length);

// security, separately from quality
check("R security (pipeline): a foreign-workspace chunk and a restricted chunk at cosine 0.98 were never candidates and never scored", r.securityPipeline.filter((s) => ["foreign_workspace", "restricted_visibility"].includes(s.type)).length === 2 && r.securityPipeline.filter((s) => ["foreign_workspace", "restricted_visibility"].includes(s.type)).every((s) => s.passed && s.forbiddenWasCandidate === false && s.forbiddenWasScored === false && s.eligibleCountMatchesLegitimateCorpus));
const forgedWs = r.securityPipeline.find((s) => s.type === "forged_workspace_selector");
const forgedVis = r.securityPipeline.find((s) => s.type === "forged_visibility_selector");
check("R security (HTTP): a forged workspace selector is refused (404) and no AI service call is made", forgedWs?.passed && forgedWs.httpStatus === 404 && forgedWs.aiServiceCalls === 0 && forgedWs.forbiddenReachedModel === false);
check("R security (HTTP): forged visibility selectors (query, headers, body) are ignored: staff-level analysis, the restricted chunk never reaches the model", forgedVis?.passed && forgedVis.analysisLevel === "staff" && forgedVis.forbiddenReachedModel === false);

// grounding subset
const g = r.grounding;
check("R grounding: 8 cases, including a no-relevant case and a boundary case", g.cases.length === 8 && g.cases.some((c) => c.caseId === "none_museum_01") && g.cases.some((c) => c.caseId === "boundary_odour_01"));
for (const name of Object.keys(g.cases[0].checks)) check(`R grounding ${name}: holds in every case`, g.cases.every((c) => c.checks[name] === true), g.cases.filter((c) => !c.checks[name]).map((c) => c.caseId).join(","));
check("R grounding: the model received the independent expectation (>= floor, best K) and, for the no-relevant cases, NO knowledge at all", g.cases.filter((c) => c.expectedNoRelevantKnowledge).every((c) => c.evidenceSentToModel.length === 0 || c.caseId === "boundary_odour_01"));
check("R grounding: the decisive chunk is in the evidence for every case that has one", g.cases.filter((c) => c.decisiveChunkInEvidence !== null).every((c) => c.decisiveChunkInEvidence === true));
check("R grounding: no evidence line is untraceable (every line is an operational template or a cited retrieved section)", g.cases.every((c) => c.untraceableEvidenceLines.length === 0));

// reproducibility and the checked-in artifact
check("R REPRODUCIBILITY: two complete evaluation runs give byte-identical deterministic results (rankings, scores, metrics, sweeps, taxonomy, grounding, security)", lib.resultsHash(run1.result) === lib.resultsHash(run2.result) && JSON.stringify(lib.deterministicView(run1.result)) === JSON.stringify(lib.deterministicView(run2.result)));
check("R the two runs differ only in timing and environment metadata (latency is kept out of the correctness comparison)", typeof h.timing.meanMs === "number" && !JSON.stringify(lib.deterministicView(r)).includes("meanMs"));
check("R the results contain no database identifiers (chunks are referenced by their dataset keys)", !/(?<![0-9a-f])[0-9a-f]{24}(?![0-9a-f])/.test(JSON.stringify(lib.deterministicView(r))));
if (fs.existsSync(artifactPath)) {
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  check("R the checked-in results file is CURRENT: its deterministic hash equals this run's (dataset, code and configuration unchanged)", artifact.meta.resultsSha256 === lib.resultsHash(r) && artifact.meta.dataset.sha256 === sha256, `${artifact.meta.resultsSha256} vs ${lib.resultsHash(r)}`);
  check("R the results file states it is not a production benchmark, records the configuration, and reports identical database counts", /NOT a production benchmark/.test(artifact.meta.notice) && artifact.meta.baselineConfiguration.floor === 0.25 && artifact.databaseCounts.identical === true);
} else {
  check("R the checked-in results file exists (run: node evaluation/retrieval/run-evaluation.mjs)", false, artifactPath);
}

console.log(`\nPhase 26 evaluation validation: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
