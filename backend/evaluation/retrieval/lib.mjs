/**
 * Offline retrieval evaluation harness (Phase 26).
 *
 * RUNS THE REAL PIPELINE: documents are ingested through the production services (createKnowledgeDocument -> rebuildChunksForDocument ->
 * embedKnowledgeDocument), and every query goes through the production `scoreKnowledgeForContext` (candidate paging, workspace/visibility
 * filters, embedding compatibility, Python scoring, Node re-verification) and the production `selectRelevantResults` (floor, de-duplication,
 * order, top-K). The harness only VARIES the floor and K it hands to that same function; it re-implements no retrieval logic.
 *
 * OFFLINE ONLY: a private ai-service is started with LLM_PROVIDER=test, EMBEDDING_PROVIDER=test and an empty key forced in its process
 * environment; global fetch is wrapped so any non-loopback request throws; `assertOfflineEnvironment` refuses real keys / external URLs.
 *
 * TWO MODES (never mixed, never averaged):
 *   "hash"   the real pipeline with the deterministic TEST embedder. Its vectors are sha256-derived and carry NO meaning, so the numbers
 *            measure the pipeline under a no-signal retriever (compare them with the seeded random-ranking baseline), not semantic quality.
 *   "oracle" the real pipeline with chunk vectors CONSTRUCTED from the labels (relevant chunks close to the query vector, distractors in
 *            between, the rest far). Its results are true by construction: it validates the harness, the metrics and the sweeps, and shows
 *            what a retriever with a given behavior would score. It says NOTHING about a real embedding model.
 */
import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase, disconnectDatabase } from "../../src/config/database.js";
import * as Models from "../../src/models/index.js";
import { DEFAULT_RETRIEVAL_MIN_SIMILARITY } from "../../src/config/runtimeConfig.js";
import { createKnowledgeDocument } from "../../src/services/knowledgeDocumentService.js";
import { rebuildChunksForDocument } from "../../src/services/knowledgeChunkService.js";
import { embedKnowledgeDocument } from "../../src/services/knowledgeEmbeddingService.js";
import { MAX_ELIGIBLE_CANDIDATES, TOP_K, buildRetrievalQueryText, retrieveKnowledgeForContext, scoreKnowledgeForContext, selectRelevantResults } from "../../src/services/knowledgeRetrievalService.js";
import { analyzeSignal } from "../../src/services/intelligenceAnalysisService.js";
import { aggregate, bootstrapStandardError, randomBaseline, relevantKeys, scorePositiveCase } from "./metrics.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND = path.join(here, "..", "..");
export const DATASET_PATH = path.join(here, "dataset.json");
const AI_DIR = path.join(BACKEND, "..", "ai-service");
const PYTHON = process.platform === "win32" ? path.join(AI_DIR, ".venv", "Scripts", "python.exe") : path.join(AI_DIR, ".venv", "bin", "python");

export const PORTS = { ai: 5971, proxy: 5972, backend: 5973 };
export const TEST_EMBEDDING_MODEL = "deterministic-embedding-v1";
export const THRESHOLDS = [0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7, 0.8];
export const KS = [1, 3, 5, 8, 10];
export const BASELINE = { threshold: DEFAULT_RETRIEVAL_MIN_SIMILARITY, k: TOP_K };
export const AUTHORIZED_LEVEL = "staff";
const RANDOM_BASELINE_SEED = 20260928;
const RANDOM_BASELINE_DRAWS = 400;

// Designed cosines of the ORACLE mode (a fixture, not a claim about any embedding model)
export const ORACLE_COSINE = { grade3: 0.85, grade2: 0.7, grade1: 0.45, strong: 0.5, "exact-keyword": 0.4, "near-topic": 0.32, forbidden: 0.98 };

// ------------------------------------------------------------------ offline safety
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const KEY_VARIABLES = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY"];
const isPlaceholder = (value) => /^(your_|<|changeme|placeholder|example|xxx)/i.test(value.trim());

/**
 * Throws when an environment could reach a real provider: a non-empty real-looking API key, a non-loopback AI_SERVICE_URL, or an
 * embedding/LLM provider that is not the deterministic test one. Pure: it inspects the object it is given.
 */
export function assertOfflineEnvironment(env) {
  const problems = [];
  for (const name of KEY_VARIABLES) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "" && !isPlaceholder(value)) problems.push(`${name} is set`);
  }
  const url = (env.AI_SERVICE_URL ?? "").trim();
  if (url) {
    try {
      if (!LOOPBACK.has(new URL(url).hostname.toLowerCase())) problems.push("AI_SERVICE_URL is not a loopback address");
    } catch {
      problems.push("AI_SERVICE_URL is not a valid URL");
    }
  }
  const llm = (env.LLM_PROVIDER ?? "").trim().toLowerCase();
  if (llm && !["test", "test-python"].includes(llm)) problems.push(`LLM_PROVIDER=${llm} is not a test provider`);
  const embedding = (env.EMBEDDING_PROVIDER ?? "").trim().toLowerCase();
  if (embedding && embedding !== "test") problems.push(`EMBEDDING_PROVIDER=${embedding} is not the test provider`);
  if (problems.length) throw new Error(`Offline evaluation refused: ${problems.join("; ")}`);
}

/** Every request the evaluator's own process makes must be loopback; anything else throws before leaving the machine. */
export function installOfflineFetchGuard() {
  if (globalThis.__koiEvalFetchGuard) return;
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(target).hostname.toLowerCase();
    if (!LOOPBACK.has(host)) throw new Error(`Offline evaluation: blocked a request to a non-loopback host (${host})`);
    return real(input, init);
  };
  globalThis.__koiEvalFetchGuard = true;
}

/** Removes provider keys the launching process inherited (e.g. from backend/.env, which the Node side never uses); returns the names. */
export function scrubProviderKeys(env = process.env) {
  const scrubbed = [];
  for (const name of KEY_VARIABLES) {
    if (typeof env[name] === "string" && env[name] !== "") {
      scrubbed.push(name);
      env[name] = "";
    }
  }
  return scrubbed;
}

// ------------------------------------------------------------------ helpers
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const norm = (a) => Math.sqrt(dot(a, a));
const unitVec = (a) => a.map((x) => x / norm(a));
/** A vector whose cosine with the UNIT vector q is exactly `c` (to double precision). */
export function atCosine(q, c, k = 0) {
  const e = q.map((_, i) => (i === k % q.length ? 1 : 0));
  const proj = dot(e, q);
  const u = unitVec(e.map((x, i) => x - proj * q[i]));
  return q.map((x, i) => c * x + Math.sqrt(Math.max(0, 1 - c * c)) * u[i]);
}
const stableHash01 = (text) => parseInt(crypto.createHash("sha256").update(text).digest("hex").slice(0, 8), 16) / 0xffffffff;
const round = (v, d = 6) => (typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(d)) : v);
const median = (xs) => (xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]);

export function loadDataset() {
  const raw = fs.readFileSync(DATASET_PATH);
  return { dataset: JSON.parse(raw.toString("utf8")), sha256: crypto.createHash("sha256").update(raw).digest("hex") };
}

// ------------------------------------------------------------------ process lifecycle (Phase 26.5A hardening)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const portOpen = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

/** Refuses to start a service on a port something still answers on (a lingering earlier process could otherwise serve the wrong configuration). */
export async function assertPortFree(port) {
  if (await portOpen(port)) throw new Error("Evaluation refused: port " + port + " is already in use (an earlier evaluation process may still be running)");
}

/** Stops a child process and WAITS until it has exited and its port refuses connections again (never assumes kill() finished). */
export async function stopProcess(child, port) {
  try {
    child.kill();
  } catch {
    // already gone
  }
  if (child.exitCode === null && child.signalCode === null) await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(10000)]);
  for (let i = 0; i < 200; i += 1) {
    if (!(await portOpen(port))) return;
    await sleep(50);
  }
  throw new Error("Evaluation cleanup: port " + port + " did not close after the process was stopped");
}

// ------------------------------------------------------------------ infrastructure
async function waitFor(url, ms = 30000) {
  const start = Date.now();
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not ready
    }
    if (Date.now() - start > ms) throw new Error(`not healthy: ${url}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function startRecordingProxy(records) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      let parsed = null;
      try {
        parsed = JSON.parse(body.toString() || "null");
      } catch {
        parsed = null;
      }
      const entry = { url: req.url, body: parsed, text: body.toString(), status: 0 };
      records.push(entry);
      try {
        const upstream = await fetch(`http://127.0.0.1:${PORTS.ai}${req.url}`, { method: req.method, headers: { "content-type": "application/json" }, body: body.length ? body : undefined });
        const text = await upstream.text();
        entry.status = upstream.status;
        res.writeHead(upstream.status, { "content-type": "application/json" });
        res.end(text);
      } catch {
        res.writeHead(502);
        res.end("{}");
      }
    });
  });
  return new Promise((resolve) => server.listen(PORTS.proxy, "127.0.0.1", () => resolve(server)));
}

export const TRACKED_MODELS = ["User", "WorkspaceMembership", "Workspace", "Property", "Unit", "Guest", "Stay", "Signal", "Intelligence", "KnowledgeDocument", "KnowledgeChunk", "ImportBatch", "Conversation", "Message", "Decision", "Action", "Outcome"];
export async function databaseCounts() {
  return Object.fromEntries(await Promise.all(TRACKED_MODELS.map(async (name) => [name, await Models[name].countDocuments({})])));
}

/**
 * Sets up (and always tears down) the offline environment and the throwaway corpus, then calls fn(ctx).
 * `ctx` exposes what the evaluations need; nothing here is left in the database afterwards.
 */
export const REAL_DIR = path.join(here, "real");
export async function withEvaluationEnvironment(fn, { scrubbed = [], ai: aiOptions = { kind: "test" } } = {}) {
  installOfflineFetchGuard();
  const children = [];
  const records = [];
  let proxy;
  const created = { workspaces: [] };
  let countsBefore = null;
  let countsAfter = null;
  let result;
  const { dataset, sha256 } = loadDataset();

  try {
    // "test": the production app with the deterministic test embedder. "replay": the SAME production app, with only the two provider calls
    // answered from the cached real embeddings (real/replay_service.py). Neither variant holds a key or can reach a non-loopback address.
    const noKeys = { LLM_PROVIDER: "test", EMBEDDING_PROVIDER: "test", GEMINI_API_KEY: "", GOOGLE_API_KEY: "", OPENAI_API_KEY: "" };
    const aiArgs = aiOptions.kind === "replay" ? ["-m", "uvicorn", "replay_service:app", "--app-dir", REAL_DIR, "--port", String(PORTS.ai), "--host", "127.0.0.1"] : ["-m", "uvicorn", "app.main:app", "--port", String(PORTS.ai), "--host", "127.0.0.1"];
    const aiEnv = aiOptions.kind === "replay" ? { ...process.env, ...noKeys, EVAL_EMBEDDING_CACHE: aiOptions.cachePath, EVAL_QUERY_TASK: aiOptions.queryTask } : { ...process.env, ...noKeys };
    const nonce = crypto.randomBytes(8).toString("hex");
    aiEnv.EVAL_RUN_NONCE = nonce;
    await assertPortFree(PORTS.ai);
    await assertPortFree(PORTS.proxy);
    const ai = spawn(PYTHON, aiArgs, { cwd: AI_DIR, env: aiEnv, stdio: "ignore" });
    children.push(ai);
    await waitFor(`http://127.0.0.1:${PORTS.ai}/v1/health`);
    // The service answering on the port must be THE process this run started, replaying THIS arm's query task. Checked now and again at the end.
    const verifyReplayIdentity = async () => {
      if (aiOptions.kind !== "replay") return null;
      for (let i = 0; i < 10; i += 1) {
        const info = await fetch(`http://127.0.0.1:${PORTS.ai}/v1/eval-replay-info`).then((r) => r.json());
        if (info.nonce !== nonce || info.queryTask !== aiOptions.queryTask) throw new Error("Evaluation refused: the replay service answering is not the process this run started (or replays another query task)");
        if (info.llmProvider !== "test" || info.embeddingProvider !== "test" || info.keyConfigured !== false || info.socketGuardInstalled !== true) throw new Error("Evaluation refused: the replay service is not offline (providers must be test, no key, socket guard installed)");
      }
      return { queryTask: aiOptions.queryTask, sameProcessThroughout: true, checks: 20, offline: { llmProvider: "test", embeddingProvider: "test", keyConfigured: false, socketGuardInstalled: true } };
    };
    await verifyReplayIdentity();
    proxy = await startRecordingProxy(records);

    // effective in-process configuration for the production services under test
    process.env.LLM_PROVIDER = "test-python";
    process.env.AI_SERVICE_URL = `http://127.0.0.1:${PORTS.ai}`;
    process.env.EMBEDDING_PROVIDER = "test";
    delete process.env.KOI_RETRIEVAL_MIN_SIMILARITY; // the production default unless a step sets it explicitly
    assertOfflineEnvironment({ ...process.env, GEMINI_API_KEY: "", GOOGLE_API_KEY: "", OPENAI_API_KEY: "" });

    const embed = async (text) => (await fetch(`http://127.0.0.1:${PORTS.ai}/v1/embeddings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ texts: [text] }) }).then((r) => r.json()));
    const expectedModel = aiOptions.expectModel ?? TEST_EMBEDDING_MODEL;
    const expectedDim = aiOptions.expectDim ?? 32;
    const probe = await embed(aiOptions.probeText ?? "offline provider probe");
    if (probe.model !== expectedModel || probe.embeddings[0].length !== expectedDim) throw new Error(`Offline evaluation refused: the ai-service is not serving the expected embeddings (${expectedModel}, ${expectedDim} dimensions)`);

    await connectDatabase();
    countsBefore = await databaseCounts();
    const stamp = Date.now();
    const mkWs = async (label) => {
      const w = await Models.Workspace.create({ name: `P26 ${label} ${stamp}`, slug: `p26-${label}-${stamp}` });
      created.workspaces.push(w._id);
      return w;
    };
    const wsEval = await mkWs("eval");
    const wsForeign = await mkWs("foreign");

    // ingestion through the PRODUCTION services
    const chunkByKey = new Map();
    const keyById = new Map();
    const chunkMeta = new Map();
    const docKeyToId = new Map();
    for (const doc of dataset.corpus.documents) {
      const ws = doc.workspace === "foreign" ? wsForeign : wsEval;
      const created_ = await createKnowledgeDocument({ workspaceId: String(ws._id), title: doc.title, documentType: doc.documentType, content: doc.content, isTestData: true, defaultVisibility: doc.visibility });
      docKeyToId.set(doc.key, String(created_._id));
      const rebuilt = await rebuildChunksForDocument(created_._id, ws._id, { authorizedLevel: "restricted" });
      await embedKnowledgeDocument(created_._id, ws._id);
      for (const chunk of rebuilt.chunks) {
        const key = `${doc.key}#${chunk.section}`;
        if (chunkByKey.has(key)) throw new Error(`duplicate chunk key ${key}`);
        chunkByKey.set(key, String(chunk._id));
        keyById.set(String(chunk._id), key);
        chunkMeta.set(key, { docKey: doc.key, workspace: doc.workspace, visibility: chunk.visibility, section: chunk.section, text: chunk.text });
      }
    }

    const ctx = {
      dataset, datasetSha256: sha256, records, embed, chunkByKey, keyById, chunkMeta, docKeyToId,
      wsEval, wsForeign, created, scrubbed, aiOptions, verifyReplayIdentity,
      cacheIndex: aiOptions.kind === "replay" ? new Map(JSON.parse(fs.readFileSync(aiOptions.cachePath, "utf8")).entries.map((e) => [`${e.taskType}|${e.sha256}`, e.vector])) : null,
      cases: dataset.cases,
      caseContext: (c) => ({ signal: { id: `eval-${c.caseId}`, type: c.signal.type, title: c.signal.title, description: c.signal.description, propertyId: null, unitId: null } }),
      counts: { before: countsBefore },
    };
    result = await fn(ctx);
  } finally {
    for (const child of children) await stopProcess(child, PORTS.ai).catch((error) => console.error(error.message));
    if (proxy) {
      proxy.closeAllConnections?.();
      await new Promise((resolve) => proxy.close(resolve));
    }
    try {
      await cleanupEvaluationData(created.workspaces);
      await connectDatabase();
      countsAfter = await databaseCounts();
    } catch (error) {
      console.error("cleanup failed:", error?.message);
    }
    await disconnectDatabase().catch(() => {});
  }
  return { result, countsBefore, countsAfter };
}

export async function cleanupEvaluationData(workspaceIds) {
  await connectDatabase();
  const ws = { $in: workspaceIds };
  const props = (await Models.Property.find({ workspaceId: ws }, { _id: 1 }).lean()).map((p) => p._id);
  await Models.Intelligence.deleteMany({ workspaceId: ws });
  await Models.KnowledgeChunk.deleteMany({ workspaceId: ws });
  await Models.KnowledgeDocument.deleteMany({ workspaceId: ws });
  await Models.Signal.deleteMany({ workspaceId: ws });
  await Models.Unit.deleteMany({ propertyId: { $in: props } });
  await Models.Property.deleteMany({ workspaceId: ws });
  await Models.WorkspaceMembership.deleteMany({ workspaceId: ws });
  await Models.Workspace.deleteMany({ _id: ws });
}

// ------------------------------------------------------------------ labels
export function labelsOfCase(c) {
  return new Map(c.labels.map((l) => [l.chunk, l.grade]));
}
export function distractorKinds(c) {
  return new Map(c.labels.filter((l) => l.grade === 0).map((l) => [l.chunk, l.kind]));
}

// ------------------------------------------------------------------ oracle vectors
export async function applyOracleVectors(ctx, c, queryVector) {
  const labels = labelsOfCase(c);
  const kinds = distractorKinds(c);
  const ops = [];
  let i = 0;
  for (const [key, id] of ctx.chunkByKey) {
    const meta = ctx.chunkMeta.get(key);
    let cosine;
    if (meta.workspace === "foreign" || meta.visibility === "restricted") cosine = ORACLE_COSINE.forbidden;
    else if (labels.has(key)) {
      const grade = labels.get(key);
      cosine = grade === 3 ? ORACLE_COSINE.grade3 : grade === 2 ? ORACLE_COSINE.grade2 : grade === 1 ? ORACLE_COSINE.grade1 : ORACLE_COSINE[kinds.get(key)] ?? ORACLE_COSINE["near-topic"];
    } else cosine = 0.02 + 0.13 * stableHash01(`${c.caseId}|${key}`); // unlabelled = unrelated, deterministic, far below every floor of interest
    ops.push({ updateOne: { filter: { _id: id }, update: { $set: { embedding: atCosine(queryVector, cosine, i) } } } });
    i += 1;
  }
  await Models.KnowledgeChunk.bulkWrite(ops, { ordered: true });
}

// ------------------------------------------------------------------ one retrieval evaluation (per mode)
async function scoreAllCases(ctx, mode) {
  const runs = [];
  for (const c of ctx.cases) {
    const context = ctx.caseContext(c);
    if (mode === "oracle") {
      const q = unitVec((await ctx.embed(buildRetrievalQueryText(context))).embeddings[0]);
      await applyOracleVectors(ctx, c, q);
    }
    const t0 = process.hrtime.bigint();
    const scored = await scoreKnowledgeForContext(context, ctx.wsEval._id, AUTHORIZED_LEVEL);
    const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const verified = scored.verified.map((r) => ({ key: ctx.keyById.get(r.chunkId), chunkId: r.chunkId, similarityScore: r.similarityScore, retrievalScore: r.retrievalScore, scope: r.scope }));
    runs.push({ c, context, scored, verified, latencyMs, queryText: buildRetrievalQueryText(context) });
  }
  return runs;
}

function selectFor(run, threshold, k) {
  const { selected, belowThreshold } = selectRelevantResults(run.scored.verified, { minSimilarity: threshold, topK: k });
  return { selected, belowThreshold };
}

function outcomesFor(ctx, runs, threshold, k) {
  return runs.map((run) => {
    const { selected, belowThreshold } = selectFor(run, threshold, k);
    return { caseId: run.c.caseId, ranked: selected.map((r) => ctx.keyById.get(r.chunkId)), labels: labelsOfCase(run.c), expectedNoRelevantKnowledge: run.c.expectedNoRelevantKnowledge, evaluated: run.scored.verified.length, rejectedByThreshold: belowThreshold };
  });
}

const projection = (a) => ({ threshold: a.threshold, k: a.k, recall: a.recall, hitRate: a.hitRate, mrr: a.mrr, ndcg: a.ndcg, noRelevantDetectionRate: a.noRelevantDetectionRate, emptyResultRateOnPositiveCases: a.emptyResultRateOnPositiveCases, falsePositiveRate: a.falsePositiveRate, casesReturningAnExplicitDistractor: a.casesReturningAnExplicitDistractor, thresholdRejectionRate: a.thresholdRejectionRate, returnedChunks: a.returnedChunks, meanReturnedPerCase: a.meanReturnedPerCase, relevantReturned: a.relevantReturned, grade1Returned: a.grade1Returned, distractorsReturned: a.distractorsReturned, unlabelledReturned: a.unlabelledReturned });

function similarityByGrade(ctx, runs) {
  const buckets = { "grade3": [], "grade2": [], "grade1": [], "distractor(grade0)": [], "unlabelled": [] };
  for (const run of runs) {
    const labels = labelsOfCase(run.c);
    for (const r of run.verified) {
      const g = labels.get(r.key);
      const bucket = g === undefined ? "unlabelled" : g === 0 ? "distractor(grade0)" : `grade${g}`;
      buckets[bucket].push(r.similarityScore);
    }
  }
  const stat = (xs) => (xs.length === 0 ? { count: 0 } : { count: xs.length, min: round(Math.min(...xs), 4), median: round(median(xs), 4), max: round(Math.max(...xs), 4), mean: round(xs.reduce((a, b) => a + b, 0) / xs.length, 4) });
  return Object.fromEntries(Object.entries(buckets).map(([name, xs]) => [name, stat(xs)]));
}

function failureTaxonomy(ctx, runs, threshold, k) {
  const rows = [];
  for (const run of runs) {
    const labels = labelsOfCase(run.c);
    const rel = new Set(relevantKeys(labels));
    const { selected } = selectFor(run, threshold, k);
    const returned = selected.map((r) => ctx.keyById.get(r.chunkId));
    if (rel.size === 0) {
      rows.push({ caseId: run.c.caseId, category: run.c.category, outcome: returned.length === 0 ? "correct_no_relevant" : "false_retrieval_on_no_relevant_case", detail: returned.length === 0 ? null : returned });
      continue;
    }
    if (returned.some((key) => rel.has(key))) {
      const missed = [...rel].filter((key) => !returned.includes(key));
      rows.push({ caseId: run.c.caseId, category: run.c.category, outcome: missed.length === 0 ? "success_full_recall" : "partial_recall", detail: missed.length ? { missedRelevant: missed } : null });
      continue;
    }
    // a miss: attribute it to what the scores show
    const byKey = new Map(run.verified.map((r) => [r.key, r]));
    const relScores = [...rel].map((key) => ({ key, similarity: byKey.get(key)?.similarityScore ?? null }));
    const bestRel = Math.max(...relScores.map((r) => r.similarity ?? -2));
    const relBelowFloor = bestRel < threshold;
    const outranked = run.verified.filter((r) => r.similarityScore >= threshold && !rel.has(r.key)).length;
    const distractorAbove = returned.filter((key) => labels.get(key) === 0);
    rows.push({
      caseId: run.c.caseId,
      category: run.c.category,
      outcome: relBelowFloor ? "miss_relevant_below_floor" : "miss_relevant_outranked_within_top_k_or_cut_by_k",
      detail: { relevantSimilarities: relScores.map((r) => ({ key: r.key, similarity: round(r.similarity, 4) })), floor: threshold, returnedExplicitDistractors: distractorAbove, candidatesAtOrAboveFloor: outranked },
    });
  }
  const counts = {};
  for (const r of rows) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  return { counts, rows };
}

// ------------------------------------------------------------------ real-embedding diagnostics (Phase 26.5)
const STOPWORDS = new Set("the and for with that this from are was were has have had not but can may will its into out per any all one two use used when where which who what how why guest guests unit room".split(" "));
const tokens = (text) => new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2 && !STOPWORDS.has(t)));
/** Jaccard overlap of content words: a DIAGNOSTIC of shared keywords (not a retriever, not a score of relevance). */
const overlap = (a, b) => {
  const A = tokens(a);
  const B = tokens(b);
  const inter = [...A].filter((t) => B.has(t)).length;
  return A.size + B.size - inter === 0 ? 0 : inter / (A.size + B.size - inter);
};
const quantile = (sorted, q) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))]);
const describe = (xs) => {
  if (xs.length === 0) return { count: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { count: xs.length, min: round(s[0], 4), p10: round(quantile(s, 0.1), 4), p25: round(quantile(s, 0.25), 4), median: round(quantile(s, 0.5), 4), p75: round(quantile(s, 0.75), 4), p90: round(quantile(s, 0.9), 4), max: round(s[s.length - 1], 4), mean: round(mean, 4), sd: round(sd, 4) };
};
const auc = (positives, negatives) => {
  if (positives.length === 0 || negatives.length === 0) return null;
  let wins = 0;
  for (const p of positives) for (const n of negatives) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (positives.length * negatives.length);
};

/** Threshold-independent evidence about how the embedding separates relevant from non-relevant chunks, plus examples and semantic sanity checks. */
export function realDiagnostics(ctx, runs) {
  const buckets = { relevant: [], grade1: [], distractor: [], unlabelled: [] };
  const perCase = [];
  for (const run of runs) {
    const labels = labelsOfCase(run.c);
    const kinds = distractorKinds(run.c);
    const rel = relevantKeys(labels);
    const sims = new Map(run.verified.map((r) => [r.key, r.similarityScore]));
    const relSims = rel.map((k) => sims.get(k));
    const nonRel = run.verified.filter((r) => !rel.includes(r.key));
    const distractors = run.verified.filter((r) => labels.get(r.key) === 0);
    for (const r of run.verified) {
      const g = labels.get(r.key);
      (g >= 2 ? buckets.relevant : g === 1 ? buckets.grade1 : g === 0 ? buckets.distractor : buckets.unlabelled).push(r.similarityScore);
    }
    const byRank = [...run.verified].sort((a, b) => b.similarityScore - a.similarityScore || (a.chunkId < b.chunkId ? -1 : 1));
    const top1 = byRank[0];
    if (rel.length === 0) {
      perCase.push({ caseId: run.c.caseId, category: run.c.category, noRelevant: true, top1Chunk: top1?.key ?? null, top1Similarity: round(top1?.similarityScore ?? null, 4), top1Grade: labels.get(top1?.key) ?? null });
      continue;
    }
    const bestDistractor = distractors.length ? distractors.reduce((a, b) => (b.similarityScore > a.similarityScore ? b : a)) : null;
    const lexicalScores = run.verified.map((r) => ({ key: r.key, overlap: overlap(run.queryText, ctx.chunkMeta.get(r.key).text) }));
    const lexicalTop = [...lexicalScores].sort((a, b) => b.overlap - a.overlap)[0];
    const bestRelevantKey = rel.slice().sort((a, b) => sims.get(b) - sims.get(a))[0];
    perCase.push({
      caseId: run.c.caseId,
      category: run.c.category,
      noRelevant: false,
      bestRelevantSimilarity: round(Math.max(...relSims), 4),
      worstRelevantSimilarity: round(Math.min(...relSims), 4),
      bestRelevantRankBySimilarity: byRank.findIndex((r) => r.key === bestRelevantKey) + 1,
      auc: round(auc(relSims, nonRel.map((r) => r.similarityScore)), 4),
      marginOverAllNonRelevant: round(Math.min(...relSims) - Math.max(...nonRel.map((r) => r.similarityScore)), 4),
      marginOverExplicitDistractors: bestDistractor ? round(Math.min(...relSims) - bestDistractor.similarityScore, 4) : null,
      strongestDistractor: bestDistractor ? { chunk: bestDistractor.key, kind: kinds.get(bestDistractor.key), similarity: round(bestDistractor.similarityScore, 4) } : null,
      embeddingTop1IsRelevant: rel.includes(top1.key),
      lexicalTop1IsRelevant: rel.includes(lexicalTop.key),
      queryOverlapWithBestRelevant: round(overlap(run.queryText, ctx.chunkMeta.get(bestRelevantKey).text), 4),
      queryOverlapWithStrongestDistractor: bestDistractor ? round(overlap(run.queryText, ctx.chunkMeta.get(bestDistractor.key).text), 4) : null,
    });
  }
  const positives = perCase.filter((p) => !p.noRelevant);
  const mean = (xs) => (xs.length === 0 ? null : round(xs.reduce((a, b) => a + b, 0) / xs.length, 4));

  // chunk-level effect of a floor, independent of K and of the ranking
  const chunkLevel = THRESHOLDS.map((t) => ({ threshold: t, relevantKept: round(buckets.relevant.filter((s) => s >= t).length / buckets.relevant.length, 4), grade1Kept: round(buckets.grade1.filter((s) => s >= t).length / buckets.grade1.length, 4), distractorKept: round(buckets.distractor.filter((s) => s >= t).length / buckets.distractor.length, 4), unlabelledKept: round(buckets.unlabelled.filter((s) => s >= t).length / buckets.unlabelled.length, 4) }));

  // examples at the baseline (floor 0.25, K = 5)
  const falsePositives = [];
  const falseNegatives = [];
  for (const run of runs) {
    const labels = labelsOfCase(run.c);
    const rel = new Set(relevantKeys(labels));
    const { selected } = selectFor(run, BASELINE.threshold, BASELINE.k);
    const returned = selected.map((r) => ctx.keyById.get(r.chunkId));
    const byRank = [...run.verified].sort((a, b) => b.retrievalScore - a.retrievalScore || (a.chunkId < b.chunkId ? -1 : 1));
    for (const [i, r] of selected.entries()) {
      const key = ctx.keyById.get(r.chunkId);
      const g = labels.get(key);
      if (g === undefined || g === 0) falsePositives.push({ caseId: run.c.caseId, rank: i + 1, chunk: key, grade: g ?? null, kind: distractorKinds(run.c).get(key) ?? "unlabelled", similarity: round(r.similarityScore, 4), noRelevantCase: rel.size === 0 });
    }
    for (const key of rel) {
      if (returned.includes(key)) continue;
      const sim = run.verified.find((r) => r.key === key)?.similarityScore;
      falseNegatives.push({ caseId: run.c.caseId, chunk: key, similarity: round(sim, 4), rankAmongAllCompatible: byRank.findIndex((r) => r.key === key) + 1, reason: sim < BASELINE.threshold ? "below the 0.25 floor" : "above the floor but outside the top 5" });
    }
  }
  falsePositives.sort((a, b) => b.similarity - a.similarity);

  // semantic sanity by category: does the embedding follow meaning or shared keywords?
  const sanity = {};
  for (const category of ["B_paraphrase", "C_terminology_variation", "D_strong_distractor", "E_near_topic_distractor", "F_exact_keyword_distractor"]) {
    const rows = positives.filter((p) => p.category === category);
    sanity[category] = {
      cases: rows.length,
      embeddingTop1IsRelevant: rows.filter((r) => r.embeddingTop1IsRelevant).length,
      lexicalOverlapTop1IsRelevant: rows.filter((r) => r.lexicalTop1IsRelevant).length,
      embeddingRightWhereKeywordsWrong: rows.filter((r) => r.embeddingTop1IsRelevant && !r.lexicalTop1IsRelevant).length,
      keywordsRightWhereEmbeddingWrong: rows.filter((r) => !r.embeddingTop1IsRelevant && r.lexicalTop1IsRelevant).length,
      meanMarginOverExplicitDistractors: mean(rows.filter((r) => r.marginOverExplicitDistractors !== null).map((r) => r.marginOverExplicitDistractors)),
      meanQueryOverlapRelevant: mean(rows.map((r) => r.queryOverlapWithBestRelevant)),
      meanQueryOverlapStrongestDistractor: mean(rows.filter((r) => r.queryOverlapWithStrongestDistractor !== null).map((r) => r.queryOverlapWithStrongestDistractor)),
      distractorOutscoredRelevant: rows.filter((r) => r.marginOverExplicitDistractors !== null && r.marginOverExplicitDistractors < 0).length,
      casesDetail: rows.map((r) => ({ caseId: r.caseId, bestRelevantRank: r.bestRelevantRankBySimilarity, relevantSimilarity: r.bestRelevantSimilarity, strongestDistractor: r.strongestDistractor, embeddingTop1IsRelevant: r.embeddingTop1IsRelevant, lexicalTop1IsRelevant: r.lexicalTop1IsRelevant })),
    };
  }
  const noRel = perCase.filter((p) => p.noRelevant);
  return {
    note: "Similarity is the RAW cosine of the scored (case, chunk) pairs of the 23 cases. relevant = grade >= 2. AUC = probability that a relevant chunk scores above a non-relevant one within the same case (0.5 = no separation, 1 = perfect); it does not depend on any floor or K.",
    similarityDistribution: { relevant: describe(buckets.relevant), grade1: describe(buckets.grade1), explicitDistractor: describe(buckets.distractor), unlabelled: describe(buckets.unlabelled) },
    separation: {
      meanAucRelevantVsAllNonRelevant: mean(positives.map((p) => p.auc)),
      minAuc: positives.length ? Math.min(...positives.map((p) => p.auc)) : null,
      casesWithPositiveMarginOverAllNonRelevant: `${positives.filter((p) => p.marginOverAllNonRelevant > 0).length}/${positives.length}`,
      casesWithPositiveMarginOverExplicitDistractors: `${positives.filter((p) => p.marginOverExplicitDistractors === null || p.marginOverExplicitDistractors > 0).length}/${positives.length}`,
      meanBestRelevantSimilarity: mean(positives.map((p) => p.bestRelevantSimilarity)),
      relevantSimilarityMinMax: { min: round(Math.min(...positives.map((p) => p.worstRelevantSimilarity)), 4), max: round(Math.max(...positives.map((p) => p.bestRelevantSimilarity)), 4) },
      top1IsRelevant: `${positives.filter((p) => p.embeddingTop1IsRelevant).length}/${positives.length}`,
    },
    noRelevantCases: { note: "Highest similarity any chunk reached for each no-relevant case, next to the lowest best-relevant similarity among the positive cases (a floor has to fit between them for no-relevant detection to work without losing relevant chunks).", rows: noRel, highestTop1: noRel.length ? round(Math.max(...noRel.map((p) => p.top1Similarity)), 4) : null, lowestBestRelevantOfPositiveCases: positives.length ? round(Math.min(...positives.map((p) => p.bestRelevantSimilarity)), 4) : null },
    chunkLevelFloorEffect: chunkLevel,
    falsePositivesAtBaseline: falsePositives,
    falseNegativesAtBaseline: falseNegatives,
    semanticSanityByCategory: sanity,
    perCase,
  };
}

/** One mode: score every case once, then sweep. Deterministic apart from `timing`. */
export async function evaluateMode(ctx, mode) {
  const runs = await scoreAllCases(ctx, mode);
  const positivesCaseData = runs.map((run) => ({ labels: labelsOfCase(run.c), candidateKeys: run.verified.map((r) => r.key) }));

  const baseline = aggregate(outcomesFor(ctx, runs, BASELINE.threshold, BASELINE.k), BASELINE.k);
  const thresholdSweep = THRESHOLDS.map((t) => ({ ...projection({ threshold: t, ...aggregate(outcomesFor(ctx, runs, t, 5), 5) }) }));
  const kSweepAtBaselineThreshold = KS.map((k) => projection({ threshold: BASELINE.threshold, ...aggregate(outcomesFor(ctx, runs, BASELINE.threshold, k), k) }));
  const kSweepAtZeroThreshold = KS.map((k) => projection({ threshold: 0, ...aggregate(outcomesFor(ctx, runs, 0, k), k) }));
  const random = randomBaseline(positivesCaseData, KS, { draws: RANDOM_BASELINE_DRAWS, seed: RANDOM_BASELINE_SEED });

  // how much the ranking-only (floor 0) metrics could move by chance with this few positive cases
  const positiveOutcomes = outcomesFor(ctx, runs, 0, 5).filter((o) => relevantKeys(o.labels).length > 0);
  const perCase5 = positiveOutcomes.map((o) => scorePositiveCase(o.ranked, o.labels, 5));
  const uncertainty = { note: "Seeded bootstrap standard error over the positive cases, ranking only (floor 0, K=5). A difference between two configurations smaller than about twice this is not distinguishable from case-sampling noise.", positiveCases: perCase5.length, standardError: { recall: bootstrapStandardError(perCase5.map((s) => s.recall)), hitRate: bootstrapStandardError(perCase5.map((s) => s.hit)), mrr: bootstrapStandardError(perCase5.map((s) => s.reciprocalRank)), ndcg: bootstrapStandardError(perCase5.map((s) => s.ndcg)) } };

  const byCategory = {};
  for (const category of [...new Set(ctx.cases.map((c) => c.category))]) {
    const subset = runs.filter((r) => r.c.category === category);
    byCategory[category] = { cases: subset.length, ...projection({ threshold: BASELINE.threshold, ...aggregate(outcomesFor(ctx, subset, BASELINE.threshold, BASELINE.k), BASELINE.k) }) };
  }

  // parity: the harness' selection at the baseline equals the PRODUCTION function's output for every case
  let parity = true;
  const parityDetail = [];
  const savedFloor = process.env.KOI_RETRIEVAL_MIN_SIMILARITY;
  delete process.env.KOI_RETRIEVAL_MIN_SIMILARITY;
  for (const run of runs) {
    if (mode === "oracle") await applyOracleVectors(ctx, run.c, unitVec((await ctx.embed(run.queryText)).embeddings[0]));
    const production = await retrieveKnowledgeForContext(run.context, ctx.wsEval._id, AUTHORIZED_LEVEL);
    const mine = selectFor(run, BASELINE.threshold, BASELINE.k).selected.map((r) => r.chunkId);
    const same = JSON.stringify(production.results.map((r) => r.chunkId)) === JSON.stringify(mine);
    if (!same) parity = false;
    parityDetail.push({ caseId: run.c.caseId, same });
  }
  if (savedFloor !== undefined) process.env.KOI_RETRIEVAL_MIN_SIMILARITY = savedFloor;

  const perCase = runs.map((run) => {
    const labels = labelsOfCase(run.c);
    const { selected } = selectFor(run, BASELINE.threshold, BASELINE.k);
    const ranks = new Map(run.verified.slice().sort((a, b) => b.retrievalScore - a.retrievalScore || (a.chunkId < b.chunkId ? -1 : 1)).map((r, i) => [r.key, i + 1]));
    const rel = relevantKeys(labels);
    return {
      caseId: run.c.caseId,
      category: run.c.category,
      query: run.queryText,
      expectedNoRelevantKnowledge: run.c.expectedNoRelevantKnowledge,
      eligibleCandidates: run.scored.scanned,
      compatibleCandidates: run.scored.evaluated - run.scored.incompatible,
      incompatibleCandidates: run.scored.incompatible,
      floor: BASELINE.threshold,
      topK: BASELINE.k,
      status: selected.length > 0 ? "ok" : "no_relevant_knowledge",
      returned: selected.map((r, i) => ({ rank: i + 1, chunk: ctx.keyById.get(r.chunkId), grade: labels.has(ctx.keyById.get(r.chunkId)) ? labels.get(ctx.keyById.get(r.chunkId)) : null, similarity: round(r.similarityScore, 6), retrievalScore: round(r.retrievalScore, 6) })),
      relevant: rel.map((key) => ({ chunk: key, grade: labels.get(key), similarity: round(run.verified.find((r) => r.key === key)?.similarityScore, 6), rankAmongAllCompatible: ranks.get(key) ?? null })),
    };
  });

  const latencies = runs.map((r) => r.latencyMs);
  return {
    mode,
    baseline: projection({ threshold: BASELINE.threshold, ...baseline }),
    thresholdSweep,
    kSweepAtBaselineThreshold,
    kSweepAtZeroThreshold,
    rankingOnlyUncertaintyAtK5: uncertainty,
    randomRankingBaseline: { note: "Expected metrics of a RANDOM order of each case's compatible candidates (seeded shuffles); applies no floor.", draws: RANDOM_BASELINE_DRAWS, seed: RANDOM_BASELINE_SEED, byK: random },
    similarityByGrade: similarityByGrade(ctx, runs),
    byCategoryAtBaseline: byCategory,
    failureTaxonomyAtBaseline: failureTaxonomy(ctx, runs, BASELINE.threshold, BASELINE.k),
    productionParityAtBaseline: { identical: parity, cases: parityDetail },
    perCase,
    ...(mode === "real" ? { realDiagnostics: realDiagnostics(ctx, runs) } : {}),
    timing: { note: "wall-clock of scoreKnowledgeForContext per case; NON-deterministic, excluded from every correctness comparison", meanMs: round(latencies.reduce((a, b) => a + b, 0) / latencies.length, 2), medianMs: round(median(latencies), 2), maxMs: round(Math.max(...latencies), 2) },
  };
}

// ------------------------------------------------------------------ grounding subset (oracle vectors, production floor and K)
export const GROUNDING_CASES = ["direct_ac_01", "paraphrase_ac_01", "strong_distractor_filter_01", "keyword_smoke_01", "multi_ac_01", "terminology_elevator_01", "none_museum_01", "boundary_odour_01"];

const KNOWLEDGE_LINE = /^Documented guidance retrieved: '(.*)'\.$/;
// Phase 27: the deterministic stub always reports the size of the (now always-attached) operationalHistory as
// one more fixed, non-fabricated template line - added here for the same reason as the other operational lines.
const OPERATIONAL_LINES = [/^Signal '.*': type '.*', severity '.*', status '.*', source '.*'\.$/, /^Signal description: /, /^A guest record is linked to this Signal\.$/, /^The linked guest record is unavailable\.$/, /^No guest is linked to this Signal\.$/, /^No stay is linked to this Signal\.$/, /^A stay is linked to this Signal/, /^The linked stay record is unavailable\.$/, /^\d+ related historical Signal\(s\) were supplied\.$/, /^No relevant documented Business Knowledge was retrieved for this Signal\.$/, /^\d+ prior analysis record\(s\) and \d+ reviewed decision\(s\) were supplied as unverified history\.$/];

export async function evaluateGrounding(ctx, { oracle = true } = {}) {
  const results = [];
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${PORTS.proxy}`; // through the recording proxy
  process.env.LLM_PROVIDER = "test-python";
  const savedFloor = process.env.KOI_RETRIEVAL_MIN_SIMILARITY;
  delete process.env.KOI_RETRIEVAL_MIN_SIMILARITY; // production default 0.25, top-K 5
  try {
    for (const id of GROUNDING_CASES) {
      const c = ctx.cases.find((x) => x.caseId === id);
      const labels = labelsOfCase(c);
      const queryText = buildRetrievalQueryText(ctx.caseContext(c));
      if (oracle) await applyOracleVectors(ctx, c, unitVec((await ctx.embed(queryText)).embeddings[0]));
      const signal = await Models.Signal.create({ workspaceId: ctx.wsEval._id, type: c.signal.type, severity: "medium", source: "staff", title: c.signal.title, description: c.signal.description });

      // what the production selection returns for this case (through the proxy, so it is recorded too)
      const mark = ctx.records.length;
      const { record } = await analyzeSignal(String(signal._id), String(ctx.wsEval._id), { authorizedLevel: AUTHORIZED_LEVEL });
      const calls = ctx.records.slice(mark);
      const request = calls.find((r) => r.url === "/v1/intelligence/analyze")?.body;
      const requestText = JSON.stringify(request ?? {});
      const sent = (request?.knowledge ?? []);
      const sentIds = sent.map((k) => k.chunkId);
      const sentKeys = sentIds.map((idv) => ctx.keyById.get(idv));
      const sentLabels = new Set(sent.map((k) => (k.sectionPath ?? []).join(" > ") || k.section || "(no section heading)")); // the stub's own label format
      const stored = await Models.Intelligence.findById(record._id).lean();
      const provenanceIds = (stored.knowledgeProvenance ?? []).map((p) => p.chunkId);
      const evidence = stored.analysis?.evidence ?? [];

      // Independent expectation (NOT the production selection): a scored chunk is expected to be ABSENT when its raw similarity is below the
      // constant baseline floor, or when it is not among the K best of the chunks that reach the floor.
      const scoredRun = await scoreKnowledgeForContext(ctx.caseContext(c), ctx.wsEval._id, AUTHORIZED_LEVEL);
      const aboveFloor = scoredRun.verified.filter((r) => r.similarityScore >= BASELINE.threshold).sort((a, b) => b.retrievalScore - a.retrievalScore || (a.chunkId < b.chunkId ? -1 : 1));
      const expectedIds = aboveFloor.slice(0, BASELINE.k).map((r) => r.chunkId);
      const notSent = scoredRun.verified.filter((r) => !expectedIds.includes(r.chunkId));
      const forbidden = [...ctx.chunkMeta.entries()].filter(([, m]) => m.workspace === "foreign" || m.visibility === "restricted");

      const knowledgeLines = evidence.map((e) => KNOWLEDGE_LINE.exec(e)).filter(Boolean);
      const untraceable = evidence.filter((e) => !KNOWLEDGE_LINE.test(e) && !OPERATIONAL_LINES.some((re) => re.test(e)));
      const decisive = c.labels.filter((l) => l.grade === 3).map((l) => l.chunk);

      results.push({
        caseId: id,
        category: c.category,
        expectedNoRelevantKnowledge: c.expectedNoRelevantKnowledge,
        evidenceSentToModel: sentKeys,
        checks: {
          A_evidenceAppearsInRetrievedContext: provenanceIds.every((pid) => sentIds.includes(pid)) && provenanceIds.every((pid) => requestText.includes(JSON.stringify(ctx.chunkMeta.get(ctx.keyById.get(pid)).text).slice(1, -1))) && knowledgeLines.every((m) => sentLabels.has(m[1])),
          B0_evidenceEqualsIndependentExpectation: JSON.stringify(sentIds) === JSON.stringify(expectedIds),
          B_rejectedChunksAbsent: notSent.every((r) => { const meta = ctx.chunkMeta.get(r.key ?? ctx.keyById.get(r.chunkId)); return !requestText.includes(JSON.stringify(meta.text).slice(1, -1)); }) && notSent.every((r) => !sentIds.includes(r.chunkId)) && sentIds.length <= BASELINE.k,
          C_foreignAndRestrictedAbsent: forbidden.every(([key, meta]) => !sentIds.includes(ctx.chunkByKey.get(key)) && !requestText.includes(JSON.stringify(meta.text).slice(1, -1))) && !requestText.includes("FOREIGN-TENANT-EVALUATION-MARKER"),
          D_provenanceOnlyAllowedEvidence: provenanceIds.every((pid) => sentIds.includes(pid)) && (record.knowledgeProvenance ?? []).every((p) => sentIds.includes(p.chunkId)),
          E_noFabricatedKnowledgeWhenNoneRetrieved: expectedIds.length > 0 || (provenanceIds.length === 0 && knowledgeLines.length === 0 && (stored.analysis?.usedKnowledgeChunkIds ?? []).length === 0),
          F_everyEvidenceLineTraceable: untraceable.length === 0,
        },
        untraceableEvidenceLines: untraceable,
        decisiveChunkInEvidence: decisive.length === 0 ? null : decisive.every((key) => sentKeys.includes(key)),
        confidence: stored.analysis?.confidence ?? null,
        evidenceLineCount: evidence.length,
        knowledgeEvidenceLines: knowledgeLines.length,
      });
    }
  } finally {
    if (savedFloor !== undefined) process.env.KOI_RETRIEVAL_MIN_SIMILARITY = savedFloor;
    process.env.AI_SERVICE_URL = `http://127.0.0.1:${PORTS.ai}`;
  }
  const checkNames = Object.keys(results[0].checks);
  return {
    note: "Deterministic test providers: the analysis text is a template built from the supplied context and evidence, so traceability holds largely BY CONSTRUCTION. This checks the pipeline's evidence flow and boundaries, not the faithfulness of a real language model.",
    oracleVectors: oracle,
    floor: BASELINE.threshold,
    topK: BASELINE.k,
    cases: results,
    summary: Object.fromEntries(checkNames.map((name) => [name, `${results.filter((r) => r.checks[name]).length}/${results.length}`])),
  };
}

// ------------------------------------------------------------------ security (evaluated separately; never part of the quality denominator)
/** cosine between a chunk's STORED vector and the cached query vector of the replay arm (real mode only) */
async function storedSimilarity(ctx, queryText, chunkId) {
  const crypto_ = crypto.createHash("sha256").update(queryText, "utf8").digest("hex");
  const q = ctx.cacheIndex?.get(`${ctx.aiOptions.queryTask}|${crypto_}`);
  const chunk = await Models.KnowledgeChunk.findById(chunkId, { embedding: 1 }).lean();
  if (!q || !chunk?.embedding) return null;
  return dot(q, chunk.embedding) / (norm(q) * norm(chunk.embedding));
}

export async function evaluateSecurityPipeline(ctx, { oracle = true } = {}) {
  const rows = [];
  const eligibleKeys = [...ctx.chunkMeta.entries()].filter(([, m]) => m.workspace === "eval" && m.visibility !== "restricted").map(([key]) => key);
  const c = ctx.cases.find((x) => x.caseId === "direct_ac_01");
  if (oracle) await applyOracleVectors(ctx, c, unitVec((await ctx.embed(buildRetrievalQueryText(ctx.caseContext(c)))).embeddings[0])); // forbidden chunks sit at cosine 0.98
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${PORTS.proxy}`;
  const mark = ctx.records.length;
  const scored = await scoreKnowledgeForContext(ctx.caseContext(c), ctx.wsEval._id, AUTHORIZED_LEVEL);
  const candidateIds = ctx.records.slice(mark).filter((r) => r.url === "/v1/knowledge-retrieval").flatMap((r) => r.body.candidates.map((x) => x.chunkId));
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${PORTS.ai}`;
  for (const s of ctx.dataset.securityCases.filter((x) => ["foreign_workspace", "restricted_visibility"].includes(x.type))) {
    const forbiddenIds = s.forbiddenChunks.map((key) => ctx.chunkByKey.get(key));
    const realSims = oracle ? null : await Promise.all(forbiddenIds.map((id) => storedSimilarity(ctx, buildRetrievalQueryText(ctx.caseContext(c)), id)));
    const legitimateMax = oracle ? null : Math.max(...scored.verified.map((r) => r.similarityScore));
    rows.push({
      caseId: s.caseId,
      type: s.type,
      forbiddenSimilarityIfComparable: oracle ? "0.98 by construction (higher than every legitimate chunk)" : realSims.map((v) => (v === null ? null : Number(v.toFixed(4)))),
      ...(oracle ? {} : { highestLegitimateSimilarity: Number(legitimateMax.toFixed(4)), forbiddenWouldOutscoreEveryLegitimateChunk: realSims.every((v) => v !== null && v > legitimateMax) }),
      forbiddenWasCandidate: forbiddenIds.some((id) => candidateIds.includes(id)),
      forbiddenWasScored: forbiddenIds.some((id) => scored.verified.some((r) => r.chunkId === id)),
      eligibleCandidates: scored.scanned,
      expectedEligibleCandidates: eligibleKeys.length,
      eligibleCountMatchesLegitimateCorpus: scored.scanned === eligibleKeys.length,
      passed: !forbiddenIds.some((id) => candidateIds.includes(id)) && !forbiddenIds.some((id) => scored.verified.some((r) => r.chunkId === id)) && scored.scanned === eligibleKeys.length,
    });
  }
  return rows;
}

/**
 * Forged-selector checks through a REAL backend (real users, memberships and tokens). Oracle vectors put the forbidden chunks at cosine
 * 0.98, i.e. above every legitimate chunk: only authorization can keep them out.
 */
export async function evaluateSecurityHttp(ctx, { oracle = true } = {}) {
  const { createActor, cleanupAuthFixtures } = await import("../../scripts/lib/authFixtures.mjs");
  const rows = [];
  const env = { ...process.env, PORT: String(PORTS.backend), NODE_ENV: "test", LLM_PROVIDER: "test-python", AI_SERVICE_URL: `http://127.0.0.1:${PORTS.proxy}`, KOI_RATE_LIMIT_ENABLED: "false", KNOWLEDGE_DEV_AUTHORIZED_LEVEL: "restricted", GEMINI_API_KEY: "", GOOGLE_API_KEY: "", OPENAI_API_KEY: "" };
  delete env.KOI_RETRIEVAL_MIN_SIMILARITY;
  assertOfflineEnvironment(env);
  await assertPortFree(PORTS.backend);
  const child = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env, stdio: "ignore" });
  try {
    await waitFor(`http://127.0.0.1:${PORTS.backend}/api/health`);
    const operator = await createActor({ role: "operator", workspaceId: ctx.wsEval._id, label: "p26-op" });
    const c = ctx.cases.find((x) => x.caseId === "direct_ac_01");
    if (oracle) await applyOracleVectors(ctx, c, unitVec((await ctx.embed(buildRetrievalQueryText(ctx.caseContext(c)))).embeddings[0]));
    const mkSignal = () => Models.Signal.create({ workspaceId: ctx.wsEval._id, type: c.signal.type, severity: "medium", source: "staff", title: c.signal.title, description: c.signal.description });
    const call = async (signal, { query = "", headers = {}, body } = {}) => {
      const mark = ctx.records.length;
      const init = { method: "POST", headers: { ...operator.headers, ...headers } };
      if (body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      const response = await fetch(`http://127.0.0.1:${PORTS.backend}/api/intelligence/analyze/${signal._id}?${query}`, init);
      const json = await response.json().catch(() => null);
      const calls = ctx.records.slice(mark);
      const requestText = calls.map((r) => r.text).join("\n");
      return { status: response.status, json, calls, requestText, sent: (calls.find((r) => r.url === "/v1/intelligence/analyze")?.body?.knowledge ?? []).map((k) => k.chunkId) };
    };
    const forbiddenText = (keys) => keys.map((key) => JSON.stringify(ctx.chunkMeta.get(key).text).slice(1, -1));
    for (const s of ctx.dataset.securityCases.filter((x) => x.type.startsWith("forged"))) {
      const forbidden = s.forbiddenChunks;
      const forbiddenIds = forbidden.map((key) => ctx.chunkByKey.get(key));
      const signal = await mkSignal();
      let res;
      if (s.type === "forged_workspace_selector") {
        res = await call(signal, { query: `workspaceId=${ctx.wsForeign._id}`, body: { workspaceId: String(ctx.wsForeign._id) } });
        rows.push({ caseId: s.caseId, type: s.type, httpStatus: res.status, aiServiceCalls: res.calls.length, forbiddenReachedModel: res.requestText.includes("FOREIGN-TENANT-EVALUATION-MARKER"), passed: res.status === 404 && res.calls.length === 0 });
      } else {
        res = await call(signal, { query: `workspaceId=${ctx.wsEval._id}&level=restricted&authorizedLevel=restricted&knowledgeLevel=restricted&visibility=restricted`, headers: { "x-knowledge-level": "restricted", "x-authorized-level": "restricted", "x-role": "admin" }, body: { knowledgeLevel: "restricted", authorizedLevel: "restricted", visibility: "restricted", role: "admin" } });
        const reached = forbiddenIds.some((id) => res.sent.includes(id)) || forbiddenText(forbidden).some((t) => res.requestText.includes(t));
        rows.push({ caseId: s.caseId, type: s.type, httpStatus: res.status, analysisLevel: res.json?.data?.analysisLevel ?? null, forbiddenReachedModel: reached, passed: res.status === 201 && res.json?.data?.analysisLevel === "staff" && !reached });
      }
    }
    await cleanupAuthFixtures();
  } finally {
    await stopProcess(child, PORTS.backend).catch((error) => console.error(error.message));
  }
  return rows;
}

/** The real-embedding evaluation of ONE query-task arm: real-vector scoring + sweeps + diagnostics + integrity + security (no oracle vectors anywhere). */
export async function runRealEvaluation(ctx) {
  const real = await evaluateMode(ctx, "real");
  const grounding = await evaluateGrounding(ctx, { oracle: false });
  const security = [...(await evaluateSecurityPipeline(ctx, { oracle: false })), ...(await evaluateSecurityHttp(ctx, { oracle: false }))];
  const serviceIdentity = await ctx.verifyReplayIdentity(); // the SAME replay process (this arm's query task) served the whole run
  return { real, grounding, security, serviceIdentity };
}

/** The full evaluation: both modes + grounding + pipeline security. HTTP forged-selector checks are added by the caller (they need auth fixtures). */
export async function runEvaluation(ctx) {
  const hash = await evaluateMode(ctx, "hash");
  const oracle = await evaluateMode(ctx, "oracle");
  const grounding = await evaluateGrounding(ctx);
  const security = [...(await evaluateSecurityPipeline(ctx)), ...(await evaluateSecurityHttp(ctx))];
  const ds = ctx.dataset;
  let head = null;
  try {
    head = execSync("git rev-parse --short HEAD", { cwd: BACKEND, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    head = null;
  }
  const categories = {};
  for (const c of ds.cases) categories[c.category] = (categories[c.category] ?? 0) + 1;
  return {
    meta: {
      phase: 26,
      notice: "NOT a production benchmark. Synthetic corpus, synthetic queries, project-authored labels, deterministic TEST embeddings. See docs/RETRIEVAL_EVALUATION_PHASE26.md for what these numbers can and cannot show.",
      dataset: { name: ds.name, version: ds.datasetVersion, sha256: ctx.datasetSha256, cases: ds.cases.length, securityCases: ds.securityCases.length, documents: ds.corpus.documents.length, chunks: ctx.chunkByKey.size, categories },
      baselineConfiguration: {
        retrieval: "dense",
        embeddingProvider: "test (deterministic, sha256-derived, no semantics)",
        embeddingModel: TEST_EMBEDDING_MODEL,
        embeddingDimension: 32,
        similarity: "cosine (ai-service vector_math) ranked by cosine x scope boost (unit 1.15, property 1.08, workspace 1.0); the floor is applied to the RAW cosine",
        floor: BASELINE.threshold,
        floorSource: "DEFAULT_RETRIEVAL_MIN_SIMILARITY (provisional Phase 25 value, unchanged)",
        topK: BASELINE.k,
        candidatePageSize: 200,
        eligibleCandidateCeiling: MAX_ELIGIBLE_CANDIDATES,
        authorizedLevel: AUTHORIZED_LEVEL,
        thresholdSweep: THRESHOLDS,
        kSweep: KS,
        randomBaselineSeed: RANDOM_BASELINE_SEED,
      },
      environment: { node: process.version, gitHead: head, providerKeysScrubbedFromProcess: ctx.scrubbed, offlineGuard: "loopback-only fetch, forced test providers, key-free ai-service" },
    },
    modes: { hash, oracle },
    grounding,
    securityPipeline: security,
  };
}

/** Strips everything non-deterministic (timing) so two runs can be compared byte for byte. */
export function deterministicView(results) {
  const copy = JSON.parse(JSON.stringify(results));
  for (const mode of Object.values(copy.modes)) delete mode.timing;
  delete copy.meta.environment;
  delete copy.meta.resultsSha256;
  delete copy.databaseCounts;
  return copy;
}
export const resultsHash = (results) => crypto.createHash("sha256").update(JSON.stringify(deterministicView(results))).digest("hex");
