/**
 * Phase 26.5 - offline real-embedding evaluation CLI (replays the cached provider vectors; contacts nothing).
 *
 *   node evaluation/retrieval/real/run-real-evaluation.mjs
 *
 * Writes backend/evaluation/results/phase26_5-real-embedding-results.json. The launching environment is checked BEFORE backend/.env is loaded.
 */
import fs from "node:fs";

const launchEnv = { ...process.env };
const lib = await import("../lib.mjs");
try {
  lib.assertOfflineEnvironment(launchEnv);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const scrubbed = lib.scrubProviderKeys();
const real = await import("./real-run.mjs");
const results = await real.runRealExperiment({ scrubbed });
fs.writeFileSync(real.RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`);
for (const [name, arm] of Object.entries(results.arms)) {
  const b = arm.real.baseline;
  const z = arm.real.thresholdSweep.find((t) => t.threshold === 0);
  console.log(`${name}: floor 0.25/K5 Recall ${b.recall} hit ${b.hitRate} MRR ${b.mrr} nDCG ${b.ndcg} noRel ${b.noRelevantDetectionRate} | no floor Recall ${z.recall} MRR ${z.mrr} nDCG ${z.ndcg}`);
}
console.log(`database counts identical: ${results.databaseCounts.identical}; wrote ${real.RESULTS_PATH}`);
process.exit(results.databaseCounts.identical ? 0 : 1);
