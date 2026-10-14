/**
 * Phase 26.5 - runs the real-embedding evaluation OFFLINE from the cached provider vectors (no provider is contacted, no key is needed).
 * Used by run-real-evaluation.mjs (writes the results file) and by validate-phase26_5-real-embedding.mjs.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lib from "../lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = path.join(here, "..", "..", "results");
export const CACHE_PATH = path.join(RESULTS_DIR, "phase26_5-real-embedding-cache.json");
export const MANIFEST_PATH = path.join(RESULTS_DIR, "phase26_5-embedding-manifest.json");
export const RESULTS_PATH = path.join(RESULTS_DIR, "phase26_5-real-embedding-results.json");
export const PHASE26_RESULTS_PATH = path.join(RESULTS_DIR, "phase26-retrieval-results.json");

export const ARMS = [
  { name: "production_query_task", queryTask: "RETRIEVAL_DOCUMENT", description: "What production does today: the query is embedded by the same function as a chunk (task RETRIEVAL_DOCUMENT)." },
  { name: "provider_recommended_query_task", queryTask: "RETRIEVAL_QUERY", description: "Google's documented asymmetric-retrieval configuration: documents RETRIEVAL_DOCUMENT, queries RETRIEVAL_QUERY. Evaluation only - production is NOT changed." },
];

const sha256File = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export function loadCacheMeta() {
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  return { cache, manifest };
}

const pick = (m) => ({ recall: m.recall, hitRate: m.hitRate, mrr: m.mrr, ndcg: m.ndcg, noRelevantDetectionRate: m.noRelevantDetectionRate, emptyResultRateOnPositiveCases: m.emptyResultRateOnPositiveCases, falsePositiveRate: m.falsePositiveRate, returnedChunks: m.returnedChunks, thresholdRejectionRate: m.thresholdRejectionRate });

export async function runRealExperiment({ scrubbed = [] } = {}) {
  const { cache, manifest } = loadCacheMeta();
  const { sha256: datasetSha } = lib.loadDataset();
  if (cache.datasetSha256 !== datasetSha || manifest.datasetSha256 !== datasetSha) throw new Error("the cached embeddings were made for a different dataset version; regenerate them (collect_embeddings.py)");
  const probeText = manifest.entries.find((e) => e.kind === "document").text;
  const arms = {};
  const counts = {};
  for (const arm of ARMS) {
    const { result, countsBefore, countsAfter } = await lib.withEvaluationEnvironment((ctx) => lib.runRealEvaluation(ctx), {
      scrubbed,
      ai: { kind: "replay", cachePath: CACHE_PATH, queryTask: arm.queryTask, expectModel: cache.model, expectDim: cache.dimension, probeText },
    });
    arms[arm.name] = { description: arm.description, queryTask: arm.queryTask, documentTask: "RETRIEVAL_DOCUMENT", ...result };
    counts[arm.name] = { before: countsBefore, after: countsAfter, identical: JSON.stringify(countsBefore) === JSON.stringify(countsAfter) };
  }

  // Phase 26 (fixed baseline) for the comparison: hash and oracle are read from the checked-in results, never re-run here
  const p26 = JSON.parse(fs.readFileSync(PHASE26_RESULTS_PATH, "utf8"));
  const comparison = {
    note: "Three kinds of measurement, never combined: (A) REAL semantic retrieval = the two arms under `arms`; (B) oracle = a designed fixture (validates the harness, says nothing about any model); (C) Phase 26 hash = the real pipeline with a no-signal embedder.",
    phase26DatasetSha256: p26.meta.dataset.sha256,
    sameDataset: p26.meta.dataset.sha256 === datasetSha,
    baseline_floor_0_25_K5: {
      phase26_hash_noSignalEmbedder: pick(p26.modes.hash.baseline),
      phase26_oracle_designedFixture: pick(p26.modes.oracle.baseline),
      ...Object.fromEntries(ARMS.map((a) => [`phase26_5_real_${a.name}`, pick(arms[a.name].real.baseline)])),
    },
    noFloor_K5: {
      phase26_hash_noSignalEmbedder: pick(p26.modes.hash.thresholdSweep.find((t) => t.threshold === 0)),
      phase26_randomOrderReference: p26.modes.hash.randomRankingBaseline.byK["5"],
      ...Object.fromEntries(ARMS.map((a) => [`phase26_5_real_${a.name}`, pick(arms[a.name].real.thresholdSweep.find((t) => t.threshold === 0))])),
    },
  };

  const results = {
    meta: {
      phase: "26.5",
      notice: "NOT a production benchmark and NOT a model comparison: one real embedding model, a small synthetic English corpus, project-authored labels. It measures how the repository's current real provider behaves on this set - nothing more.",
      provider: cache.provider,
      model: cache.model,
      embeddingDimension: cache.dimension,
      taskConfigs: cache.taskConfigs,
      embeddingsGeneratedAt: cache.generatedAt,
      datasetVersion: manifest.datasetVersion,
      datasetSha256: datasetSha,
      cacheSha256: sha256File(CACHE_PATH),
      manifestSha256: sha256File(MANIFEST_PATH),
      baselineConfiguration: { retrieval: "dense", similarity: "cosine (production ai-service scoring, replayed offline over the cached real vectors) x scope boost; floor on RAW cosine", floor: lib.BASELINE.threshold, topK: lib.BASELINE.k, thresholdSweep: lib.THRESHOLDS, kSweep: lib.KS, productionChanged: false },
      externalUsage: { ...cache.usage, provider: cache.provider, model: cache.model, note: "Recorded by the collector when the vectors were obtained. This evaluation run itself made no external call: it replays the cache." },
      environment: { node: process.version, providerKeysScrubbedFromProcess: scrubbed, offlineGuard: "loopback-only fetch; replay service has no key and a socket guard" },
    },
    arms,
    comparisonWithPhase26: comparison,
  };
  results.meta.resultsSha256 = realResultsHash(results);
  results.databaseCounts = { perArm: counts, identical: Object.values(counts).every((c) => c.identical) };
  return results;
}

/** Hash of the deterministic content only (no timing, environment, counts). */
export function realResultsHash(results) {
  const copy = JSON.parse(JSON.stringify(results));
  delete copy.meta.environment;
  delete copy.meta.resultsSha256;
  delete copy.databaseCounts;
  for (const arm of Object.values(copy.arms)) delete arm.real.timing;
  return crypto.createHash("sha256").update(JSON.stringify(copy)).digest("hex");
}
