/**
 * Phase 26.5 validation: the real-embedding evaluation (OFFLINE - it replays the cached provider vectors; no provider is contacted and no key is needed).
 *
 *   C  the cache and manifest: exactly the synthetic texts, matching hashes, real-model metadata, no generation call, no secret
 *   S  static safety: the collector can only call the embedding endpoint; the replay service has no provider client and a socket guard
 *   R  the run: production parity on real vectors, sweep invariants, security, retrieval integrity, the two query-task arms really differ,
 *      the floor is effective, reproducibility, currency of the results file, database counts unchanged
 *
 * It does NOT assert how good the real embedding is (those are measurements recorded in the results file and report); it asserts that the
 * measuring is honest and the boundaries held.
 */
const launchEnv = { ...process.env };
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = await import("../evaluation/retrieval/lib.mjs");
const metrics = await import("../evaluation/retrieval/metrics.mjs");
const real = await import("../evaluation/retrieval/real/real-run.mjs");
const { buildManifest } = await import("../evaluation/retrieval/real/export-manifest.mjs");
const { DEFAULT_RETRIEVAL_MIN_SIMILARITY } = await import("../src/config/runtimeConfig.js");
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ------------------------------------------------------------------ O. this suite itself is offline
try {
  lib.assertOfflineEnvironment(launchEnv);
  check("O the launching environment carries no provider key, no external AI URL and no non-test provider (this suite never needs the real key)", true);
} catch (error) {
  check("O the launching environment carries no provider key, no external AI URL and no non-test provider (this suite never needs the real key)", false, error.message);
}

// ------------------------------------------------------------------ C. cache and manifest
const { cache, manifest } = real.loadCacheMeta();
const rebuilt = buildManifest();
const { sha256: datasetSha } = lib.loadDataset();
check("C the manifest is exactly what the production chunker, embedding-text builder and query builder produce from the dataset (nothing else can have been sent)", same(rebuilt.entries.map((e) => [e.kind, e.source, e.sha256, e.text]), manifest.entries.map((e) => [e.kind, e.source, e.sha256, e.text])) && rebuilt.datasetSha256 === datasetSha);
check("C the manifest holds 35 document texts and 23 query texts (10,529 characters)", manifest.counts.documents === 35 && manifest.counts.queries === 23 && manifest.counts.totalChars === 10529);
const crypto = await import("node:crypto");
check("C every manifest hash equals the sha256 of its text", manifest.entries.every((e) => crypto.createHash("sha256").update(e.text, "utf8").digest("hex") === e.sha256));
const dataset = lib.loadDataset().dataset;
const allText = manifest.entries.map((e) => e.text).join("\n");
check("C no e-mail address, phone number, URL or personal-identifier pattern in any text sent", !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(allText) && !/\+?\d[\d\s().-]{8,}\d/.test(allText) && !/https?:\/\//i.test(allText));
check("C the only restricted / foreign texts sent are the two documented SYNTHETIC evaluation fixtures (restricted escalation chunk, foreign-tenant AC chunk)", same(manifest.entries.filter((e) => e.kind === "document" && (e.visibility === "restricted" || e.workspace === "foreign")).map((e) => e.source).sort(), ["escalation-restricted#Cooling failure escalation", "foreign-ac#Cooling failure first checks"]));
check("C every query text is a dataset signal (type. title. description) and every document text is a dataset section", manifest.entries.filter((e) => e.kind === "query").every((e) => dataset.cases.concat(dataset.securityCases).some((c) => e.text === `${c.signal.type}. ${c.signal.title}. ${c.signal.description}`)) && manifest.entries.filter((e) => e.kind === "document").every((e) => dataset.corpus.documents.some((d) => d.key === e.source.split("#")[0])));
check("C the cache records provider gemini, the repository's configured model gemini-embedding-001, 3072 dimensions, and the task configuration", cache.provider === "gemini" && cache.model === "gemini-embedding-001" && cache.dimension === 3072 && cache.taskConfigs.document === "RETRIEVAL_DOCUMENT" && cache.taskConfigs.queryProductionArm === "RETRIEVAL_DOCUMENT" && cache.taskConfigs.queryProviderRecommendedArm === "RETRIEVAL_QUERY" && !!cache.generatedAt);
check("C the cache was made for THIS dataset version and hash", cache.datasetSha256 === datasetSha && cache.datasetVersion === dataset.datasetVersion);
check("C the recorded external usage is 6 embedding requests, 81 texts and ZERO generation requests", cache.usage.embeddingRequests === 6 && cache.usage.textsSent === 81 && cache.usage.generationRequests === 0);
const docs = manifest.entries.filter((e) => e.kind === "document");
const queries = manifest.entries.filter((e) => e.kind === "query");
const has = (task, e) => cache.entries.some((x) => x.taskType === task && x.sha256 === e.sha256);
check("C the cache covers every document text (RETRIEVAL_DOCUMENT) and every query text under BOTH query tasks, and nothing else", docs.every((e) => has("RETRIEVAL_DOCUMENT", e)) && queries.every((e) => has("RETRIEVAL_DOCUMENT", e) && has("RETRIEVAL_QUERY", e)) && cache.entries.length === docs.length + 2 * queries.length);
check("C every cached vector has 3072 finite components (no empty or malformed embedding)", cache.entries.every((e) => e.vector.length === 3072 && e.vector.every(Number.isFinite)));
check("C the two query tasks give DIFFERENT vectors for the same text (the provider honoured the task type)", (() => { const q = queries[0]; const a = cache.entries.find((x) => x.taskType === "RETRIEVAL_DOCUMENT" && x.sha256 === q.sha256).vector; const b = cache.entries.find((x) => x.taskType === "RETRIEVAL_QUERY" && x.sha256 === q.sha256).vector; return a.some((v, i) => v !== b[i]); })());
const secretPattern = /AIza[0-9A-Za-z_-]{20,}|api[_-]?key["']?\s*[:=]\s*["'][^"']{8,}|sk-[A-Za-z0-9]{16,}|BEGIN (RSA )?PRIVATE KEY/;
const artifacts = { cache: real.CACHE_PATH, manifest: real.MANIFEST_PATH, results: real.RESULTS_PATH, collector: path.join(here, "..", "evaluation", "retrieval", "real", "collect_embeddings.py"), replay: path.join(here, "..", "evaluation", "retrieval", "real", "replay_service.py"), report: path.join(here, "..", "docs", "REAL_EMBEDDING_EVALUATION_PHASE26_5.md") };
check("C no secret or key-shaped string appears in the cache, manifest, results, collector, replay service or report", Object.values(artifacts).filter((p) => fs.existsSync(p)).every((p) => !secretPattern.test(fs.readFileSync(p, "utf8"))));

// ------------------------------------------------------------------ G. call graph: dataset -> manifest -> collector -> provider (embeddings only)
{
  const mongoose = (await import("mongoose")).default;
  check("G building the manifest (production chunker + builders) opened NO database connection", mongoose.connection.readyState === 0);
  const { spawnSync } = await import("node:child_process");
  const aiDir = path.join(here, "..", "..", "ai-service");
  const python = process.platform === "win32" ? path.join(aiDir, ".venv", "Scripts", "python.exe") : path.join(aiDir, ".venv", "bin", "python");
  const probe = spawnSync(python, ["-c", "import sys, importlib; sys.path.insert(0, r'" + lib.REAL_DIR + "'); import collect_embeddings; print(sorted(m for m in sys.modules if any(t in m.lower() for t in ('mongo', 'motor', 'pymongo', 'mongoose'))))"], { cwd: aiDir, env: { ...process.env, LLM_PROVIDER: "test", EMBEDDING_PROVIDER: "test", GEMINI_API_KEY: "" }, encoding: "utf8" });
  check("G importing the collector (and everything it depends on) loads NO MongoDB client module", probe.status === 0 && probe.stdout.trim() === "[]", probe.stderr.slice(0, 200) + probe.stdout.slice(0, 100));
}

// ------------------------------------------------------------------ S. static safety
const collector = fs.readFileSync(artifacts.collector, "utf8");
const replay = fs.readFileSync(artifacts.replay, "utf8");
check("S the collector's only provider calls are embedding calls: embed_content / generate_gemini_embeddings, and no generate_content, generate_text, chat or generation call exists", /embed_content\(/.test(collector) && /generate_gemini_embeddings\(/.test(collector) && !/generate_content\(|generate_text\(|\.chats\.|generate_images\(|generate_videos\(|generate_gemini_analysis|generate_gemini_intelligence/.test(collector));
check("S the collector refuses unknown kinds, hash mismatches and PII-like text before any call, and has a hard request ceiling", /REFUSING/.test(collector) && /PII_PATTERNS/.test(collector) && /requests > 20/.test(collector));
check("S the collector never prints, writes or forwards the key (only a boolean about it is printed)", !/print\([^)]*gemini_api_key(?!\))/.test(collector) && /key_configured=\{bool\(settings\.gemini_api_key\)\}/.test(collector) && !/environ|subprocess|os\.system/.test(collector));
check("S the replay service has NO provider client (no google.genai import), forces empty key and test providers, and installs a non-loopback socket guard", !/google|genai/.test(replay) && /GEMINI_API_KEY"\] = ""/.test(replay) && /non-loopback/.test(replay) && /socket\.socket\.connect = _guarded_connect/.test(replay));
check("S the replay service answers ONLY from the cache: an uncached text raises instead of falling through", /replay cache has no/.test(replay));
check("S no production file was edited to run this experiment: the ai-service application is imported unchanged", /from app\.main import app/.test(replay));

// the replay service really refuses an uncached text (started on its own private port, from the real cache)
{
  const { spawn } = await import("node:child_process");
  const aiDir = path.join(here, "..", "..", "ai-service");
  const python = process.platform === "win32" ? path.join(aiDir, ".venv", "Scripts", "python.exe") : path.join(aiDir, ".venv", "bin", "python");
  const child = spawn(python, ["-m", "uvicorn", "replay_service:app", "--app-dir", real.RESULTS_PATH.replace(/results[\\/].*$/, "retrieval/real"), "--port", "5971", "--host", "127.0.0.1"], { cwd: aiDir, env: { ...process.env, LLM_PROVIDER: "test", EMBEDDING_PROVIDER: "test", GEMINI_API_KEY: "", EVAL_EMBEDDING_CACHE: real.CACHE_PATH, EVAL_QUERY_TASK: "RETRIEVAL_QUERY" }, stdio: "ignore" });
  try {
    for (let i = 0; i < 80; i += 1) {
      try {
        if ((await fetch("http://127.0.0.1:5971/v1/health")).ok) break;
      } catch {
        // not ready
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const post = (text) => fetch("http://127.0.0.1:5971/v1/embeddings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ texts: [text] }) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
    const known = await post(docs[0].text);
    const unknown = await post("a text that is not in the cache and must never reach a provider");
    check("S the replay service returns the cached real vector (3072 dimensions, model gemini-embedding-001) for a known text", known.status === 200 && known.json.model === "gemini-embedding-001" && known.json.embeddings[0].length === 3072);
    check("S ...and refuses an unknown text (no fall-through to any provider)", unknown.status >= 500);
  } finally {
    child.kill();
  }
}

// ------------------------------------------------------------------ M. metric spot checks (definitions unchanged from Phase 26)
{
  const labels = new Map([["a", 3], ["b", 2], ["c", 1], ["d", 0]]);
  const s = metrics.scorePositiveCase(["c", "a", "d", "b"], labels, 2);
  const dcg = (2 ** 1 - 1) / Math.log2(2) + (2 ** 3 - 1) / Math.log2(3);
  const idcg = (2 ** 3 - 1) / Math.log2(2) + (2 ** 2 - 1) / Math.log2(3);
  check("M Recall@2 over the full relevant set and nDCG@2 match hand-computed values (0.5 and DCG/IDCG)", near(s.recall, 0.5) && near(s.ndcg, dcg / idcg) && near(s.reciprocalRank, 0.5));
}

// ------------------------------------------------------------------ R. the runs
const run1 = await real.runRealExperiment({ scrubbed: lib.scrubProviderKeys() });
const run2 = await real.runRealExperiment({ scrubbed: lib.scrubProviderKeys() });
const run3 = await real.runRealExperiment({ scrubbed: lib.scrubProviderKeys() });
const arms = run1.arms;
const A = arms.production_query_task;
const B = arms.provider_recommended_query_task;
const eligibleExpected = dataset.corpus.documents.filter((d) => d.workspace === "eval" && d.visibility !== "restricted").reduce((n, d) => n + [...d.content.matchAll(/^## /gm)].length, 0);

check("R database counts are identical before and after each arm (throwaway fixtures removed; no operational record touched)", run1.databaseCounts.identical && run2.databaseCounts.identical, JSON.stringify(run1.databaseCounts));
check("R the results carry provider, exact model, dimension, task configuration, timestamp, dataset version/hash and cache/manifest hashes", run1.meta.provider === "gemini" && run1.meta.model === "gemini-embedding-001" && run1.meta.embeddingDimension === 3072 && run1.meta.taskConfigs.document === "RETRIEVAL_DOCUMENT" && !!run1.meta.embeddingsGeneratedAt && run1.meta.datasetSha256 === datasetSha && run1.meta.cacheSha256.length === 64 && run1.meta.manifestSha256.length === 64);
check("R the results record ZERO generation requests and the 6 embedding requests made when the vectors were obtained; this run made none", run1.meta.externalUsage.generationRequests === 0 && run1.meta.externalUsage.embeddingRequests === 6 && /made no external call/.test(run1.meta.externalUsage.note));
check("R the baseline is the production configuration (dense, floor 0.25, top-K 5) and production is recorded as unchanged", run1.meta.baselineConfiguration.floor === 0.25 && run1.meta.baselineConfiguration.topK === 5 && run1.meta.baselineConfiguration.productionChanged === false && DEFAULT_RETRIEVAL_MIN_SIMILARITY === 0.25 && TOP_K === 5);
check("R two arms were evaluated: the production query task (RETRIEVAL_DOCUMENT) and the provider-recommended one (RETRIEVAL_QUERY), documents RETRIEVAL_DOCUMENT in both", A.queryTask === "RETRIEVAL_DOCUMENT" && B.queryTask === "RETRIEVAL_QUERY" && A.documentTask === "RETRIEVAL_DOCUMENT" && B.documentTask === "RETRIEVAL_DOCUMENT");
check("R the query-task configuration is HONOURED: the two arms have different similarity distributions (median relevant similarity differs by more than 0.05)", Math.abs(A.real.realDiagnostics.similarityDistribution.relevant.median - B.real.realDiagnostics.similarityDistribution.relevant.median) > 0.05);
for (const [name, arm] of Object.entries(arms)) {
  const m = arm.real;
  check(`R ${name}: real vectors flow through the production scoring (top result similarities are real cosines, the 3072-dimension vectors were compared, every case saw exactly ${eligibleExpected} legitimate candidates)`, m.perCase.every((p) => p.eligibleCandidates === eligibleExpected && p.compatibleCandidates === eligibleExpected && p.incompatibleCandidates === 0) && m.perCase.filter((p) => !p.expectedNoRelevantKnowledge).every((p) => p.returned[0].similarity > 0.5), `expected ${eligibleExpected}`);
  check(`R ${name}: PARITY - the harness selection equals the production retrieveKnowledgeForContext output for every case`, m.productionParityAtBaseline.identical && m.productionParityAtBaseline.cases.length === dataset.cases.length);
  const t = m.thresholdSweep;
  check(`R ${name}: threshold sweep 0.00-0.80 (14 steps) and K sweep 1/3/5/8/10 are complete`, same(t.map((x) => x.threshold), lib.THRESHOLDS) && same(m.kSweepAtBaselineThreshold.map((x) => x.k), lib.KS) && same(m.kSweepAtZeroThreshold.map((x) => x.k), lib.KS));
  check(`R ${name}: raising the floor never increases returned chunks and never lowers the rejection rate; a larger K never lowers Recall`, t.every((x, i) => i === 0 || (x.returnedChunks <= t[i - 1].returnedChunks && x.thresholdRejectionRate >= t[i - 1].thresholdRejectionRate)) && m.kSweepAtZeroThreshold.every((x, i) => i === 0 || x.recall >= m.kSweepAtZeroThreshold[i - 1].recall));
  check(`R ${name}: the FLOOR MECHANISM is effective on real data (a floor at 0.80 changes the result relative to no floor)`, t.find((x) => x.threshold === 0.8).returnedChunks < t.find((x) => x.threshold === 0).returnedChunks);
  check(`R ${name}: the 0.25 row equals the reported baseline; every similarity is a valid cosine`, same(t.find((x) => x.threshold === 0.25), m.baseline) && m.perCase.every((p) => p.returned.every((x) => x.similarity >= -1 && x.similarity <= 1)));
  check(`R ${name}: the diagnostics account for every case (similarity distributions by label, separation, examples, categories B-F)`, m.realDiagnostics.perCase.length === dataset.cases.length && Object.keys(m.realDiagnostics.semanticSanityByCategory).length === 5 && m.realDiagnostics.similarityDistribution.relevant.count === 21 && m.realDiagnostics.similarityDistribution.unlabelled.count === 709);
  const g = arm.grounding;
  check(`R ${name}: retrieval-integrity subset (8 cases, real vectors, independent expectation): every check holds in every case`, g.cases.length === 8 && g.oracleVectors === false && g.cases.every((c) => Object.values(c.checks).every(Boolean)), g.cases.filter((c) => !Object.values(c.checks).every(Boolean)).map((c) => c.caseId).join(","));
  const sec = arm.security;
  const pipeline = sec.filter((s) => ["foreign_workspace", "restricted_visibility"].includes(s.type));
  check(`R ${name}: security - foreign-workspace and restricted chunks are never candidates and never scored, whatever their REAL similarity`, pipeline.length === 2 && pipeline.every((s) => s.passed && !s.forbiddenWasCandidate && !s.forbiddenWasScored && s.eligibleCountMatchesLegitimateCorpus));
  const fw = sec.find((s) => s.type === "forged_workspace_selector");
  const fv = sec.find((s) => s.type === "forged_visibility_selector");
  check(`R ${name}: security - a forged workspace selector is refused (404, no AI call) and forged visibility selectors are ignored (staff level, restricted chunk never sent)`, fw.passed && fw.httpStatus === 404 && fw.aiServiceCalls === 0 && fv.passed && fv.analysisLevel === "staff" && !fv.forbiddenReachedModel);
}
check("R the foreign-workspace chunk's REAL similarity is reported next to the best legitimate similarity (isolation does not depend on similarity)", B.security.find((s) => s.type === "foreign_workspace").forbiddenSimilarityIfComparable[0] > 0.7 && typeof B.security.find((s) => s.type === "foreign_workspace").highestLegitimateSimilarity === "number");
check("R the comparison labels three kinds of measurement and uses the same dataset as Phase 26 (real arms, oracle fixture, hash no-signal embedder)", run1.comparisonWithPhase26.sameDataset && "phase26_hash_noSignalEmbedder" in run1.comparisonWithPhase26.baseline_floor_0_25_K5 && "phase26_oracle_designedFixture" in run1.comparisonWithPhase26.baseline_floor_0_25_K5 && "phase26_5_real_production_query_task" in run1.comparisonWithPhase26.baseline_floor_0_25_K5);
const firstDifferences = (a, b, prefix = "", out = []) => {
  if (out.length >= 5 || JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object") for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) firstDifferences(a[k], b[k], `${prefix}.${k}`, out);
  else out.push(`${prefix}: ${JSON.stringify(a)?.slice(0, 60)} vs ${JSON.stringify(b)?.slice(0, 60)}`);
  return out;
};
const stripForDiff = (r) => { const c = JSON.parse(JSON.stringify(r)); delete c.meta.environment; delete c.meta.resultsSha256; delete c.databaseCounts; for (const arm of Object.values(c.arms)) delete arm.real.timing; return c; };
const reproducible = real.realResultsHash(run1) === real.realResultsHash(run2) && real.realResultsHash(run2) === real.realResultsHash(run3);
if (!reproducible) {
  // forensic record for a failure that is otherwise hard to catch (untracked artifact next to the results)
  const forensic = { at: new Date().toISOString(), run1vs2: firstDifferences(stripForDiff(run1), stripForDiff(run2), "", []), run2vs3: firstDifferences(stripForDiff(run2), stripForDiff(run3), "", []), hashes: [run1, run2, run3].map((r) => real.realResultsHash(r)) };
  fs.writeFileSync(path.join(path.dirname(real.RESULTS_PATH), "phase26_5-repro-failure.json"), JSON.stringify(forensic, null, 2));
}
check("R REPRODUCIBILITY: three complete offline runs (in one process, restarting the services between arms) give byte-identical deterministic results", reproducible, firstDifferences(stripForDiff(run1), stripForDiff(run2)).join(" | ") + " || " + firstDifferences(stripForDiff(run2), stripForDiff(run3)).join(" | "));
check("R each arm records that the replay process answering was the one this run started, replaying the arm's own query task, checked before and after the run", ["production_query_task", "provider_recommended_query_task"].every((name) => run1.arms[name].serviceIdentity?.sameProcessThroughout === true && run1.arms[name].serviceIdentity.queryTask === run1.arms[name].queryTask));
check("R each arm records that the answering replay process was OFFLINE: test LLM provider (the only generation path is the deterministic stub), test embedding provider, no key configured, non-loopback socket guard installed", ["production_query_task", "provider_recommended_query_task"].every((name) => same(run1.arms[name].serviceIdentity?.offline, { llmProvider: "test", embeddingProvider: "test", keyConfigured: false, socketGuardInstalled: true })));

// lifecycle guards: a service is never started on an occupied port, and a stopped process is waited for until its port is closed
{
  const netMod = await import("node:net");
  const { spawn } = await import("node:child_process");
  const holder = netMod.createServer().listen(5971, "127.0.0.1");
  await new Promise((resolve) => holder.once("listening", resolve));
  let refused = false;
  try {
    await lib.assertPortFree(5971);
  } catch (error) {
    refused = /already in use/.test(error.message);
  }
  await new Promise((resolve) => holder.close(resolve));
  check("R lifecycle: starting a service on a port that something still answers on is refused (no silent takeover by a lingering process)", refused);
  const child = spawn(process.execPath, ["-e", "require('net').createServer().listen(5971,'127.0.0.1');setInterval(()=>{},1000)"], { stdio: "ignore" });
  for (let i = 0; i < 40; i += 1) {
    try {
      await lib.assertPortFree(5971);
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await lib.stopProcess(child, 5971);
  let freeAfter = true;
  try {
    await lib.assertPortFree(5971);
  } catch {
    freeAfter = false;
  }
  check("R lifecycle: stopProcess waits for the process to exit and the port to close before returning", freeAfter);
}
check("R the results contain no database identifiers and no secret", !/(?<![0-9a-f])[0-9a-f]{24}(?![0-9a-f])/.test(JSON.stringify(run1.arms)) && !secretPattern.test(JSON.stringify(run1)));
if (fs.existsSync(real.RESULTS_PATH)) {
  const file = JSON.parse(fs.readFileSync(real.RESULTS_PATH, "utf8"));
  check("R the checked-in results file is CURRENT: its deterministic hash equals this run's (dataset, cache, code and configuration unchanged)", file.meta.resultsSha256 === real.realResultsHash(run1) && file.databaseCounts.identical === true, `${file.meta.resultsSha256} vs ${real.realResultsHash(run1)}`);
} else {
  check("R the checked-in results file exists (run: node evaluation/retrieval/real/run-real-evaluation.mjs)", false);
}

console.log(`\nPhase 26.5 real-embedding validation: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
