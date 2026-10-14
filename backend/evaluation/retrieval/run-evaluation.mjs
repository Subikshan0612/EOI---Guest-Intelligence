/**
 * Offline retrieval evaluation CLI (Phase 26).
 *
 *   node evaluation/retrieval/run-evaluation.mjs [--out <file>]
 *
 * Writes the machine-readable results (default backend/evaluation/results/phase26-retrieval-results.json). Nothing is written to the
 * database permanently (throwaway workspaces, removed and counted before/after) and no external service is contacted.
 *
 * The launching environment is checked BEFORE any module (and therefore backend/.env) is loaded: a real provider key in the shell, a
 * non-loopback AI_SERVICE_URL or a non-test provider makes this refuse to run. Provider keys that backend/.env injects afterwards (the
 * Node side has no provider client and never reads them) are scrubbed from the process and reported.
 */
import { requireLoopbackDatabase } from "../../src/config/mongoSafety.js";
requireLoopbackDatabase("retrieval-evaluation", { allowOptIn: false }); // never silently operate on a remote database (see src/config/mongoSafety.js)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const launchEnv = { ...process.env }; // BEFORE the dynamic imports below load backend/.env
const here = path.dirname(fileURLToPath(import.meta.url));
const outIndex = process.argv.indexOf("--out");
const outFile = outIndex > 0 ? path.resolve(process.argv[outIndex + 1]) : path.join(here, "..", "results", "phase26-retrieval-results.json");

const lib = await import("./lib.mjs");
try {
  lib.assertOfflineEnvironment(launchEnv);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const scrubbed = lib.scrubProviderKeys();

const { result, countsBefore, countsAfter } = await lib.withEvaluationEnvironment((ctx) => lib.runEvaluation(ctx), { scrubbed });
result.meta.resultsSha256 = lib.resultsHash(result); // over the deterministic content only (no timing, environment or counts)
result.databaseCounts = { before: countsBefore, after: countsAfter, identical: JSON.stringify(countsBefore) === JSON.stringify(countsAfter) };
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);

const b = (m) => result.modes[m].baseline;
console.log(`dataset ${result.meta.dataset.version}: ${result.meta.dataset.cases} cases, ${result.meta.dataset.chunks} chunks`);
for (const m of ["hash", "oracle"]) console.log(`${m.padEnd(6)} @ floor ${b(m).threshold}, K=${b(m).k}: Recall ${b(m).recall}  hit ${b(m).hitRate}  MRR ${b(m).mrr}  nDCG ${b(m).ndcg}  no-relevant ${b(m).noRelevantDetectionRate}  FPR ${b(m).falsePositiveRate}`);
console.log(`database counts identical before/after: ${result.databaseCounts.identical}`);
console.log(`wrote ${outFile}`);
process.exit(result.databaseCounts.identical ? 0 : 1);
