/**
 * Learning L1.1 - READ-ONLY replay of the real Atlas database through the existing L1 shadow path. It never writes: autoIndex / autoCreate are switched OFF before any model is
 * registered, and every write / index / collection-management method of the MongoDB driver is replaced with a function that throws (the count of blocked attempts is reported and
 * must be 0). Before and after, every collection is fingerprinted by content (a hash of its documents), and the two fingerprints must be identical.
 *
 *   node scripts/phase41/atlas-learning-replay-readonly.mjs
 *
 * It uses ONLY the application credential in backend/.env (the least-privilege application user, readWrite on koi_staging; no admin credential). No Gemini, no embeddings, no feature flag, no model call.
 * Output: fixed messages, counts and percentages. No credential, URI, host, guest data, report text or Mongo id is printed or stored. A small JSON artifact with the same aggregate
 * numbers is written to backend/scripts/phase41/out/l1-replay-atlas.json.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..", "..");
const uri = dotenv.parse(fs.readFileSync(path.join(BACKEND, ".env"), "utf8")).MONGODB_URI;
if (!uri) { console.error("No MONGODB_URI in backend/.env"); process.exit(2); }
delete process.env.KOI_LEARNING_CONTEXT_ENABLED;

// ---- hard read-only guarantee
mongoose.set("autoIndex", false); mongoose.set("autoCreate", false);
let blocked = 0;
const block = (proto, names) => { for (const name of names) if (typeof proto[name] === "function") proto[name] = function () { blocked += 1; throw new Error(`READ-ONLY replay: ${name} is blocked`); }; };
block(mongoose.mongo.Collection.prototype, ["insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany", "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace", "bulkWrite", "drop", "createIndex", "createIndexes", "dropIndex", "dropIndexes", "rename", "createSearchIndex", "createSearchIndexes"]);
block(mongoose.mongo.Db.prototype, ["createCollection", "dropCollection", "dropDatabase", "renameCollection", "createIndex"]);

const M = await import("../../src/models/index.js");
const { replayWorkspaces, computeMetrics, fingerprintOfResult } = await import("../lib/l1ReplayMetrics.mjs");
await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
const status = await mongoose.connection.db.admin().command({ connectionStatus: 1 });
const roles = (status.authInfo?.authenticatedUserRoles ?? []).map((r) => `${r.role}@${r.db}`);
if (mongoose.connection.name !== "koi_staging" || roles.length !== 1 || roles[0] !== "readWrite@koi_staging") {
  console.error(`NOT PERFORMED - the credential is not exactly readWrite@koi_staging (database "${mongoose.connection.name}", roles: ${roles.join(", ") || "none"})`);
  await mongoose.disconnect(); process.exit(3);
}
console.log("credential: readWrite@koi_staging (application user); database: koi_staging; writes blocked at the driver level; autoIndex/autoCreate off");

const contentFingerprint = async () => {
  const out = {};
  for (const model of Object.values(M).filter((x) => x?.collection)) {
    const docs = await model.collection.find({}).toArray();
    const lines = docs.map((d) => crypto.createHash("sha256").update(JSON.stringify(d)).digest("hex")).sort();
    out[model.collection.collectionName] = { count: docs.length, hash: crypto.createHash("sha256").update(lines.join("")).digest("hex").slice(0, 16) };
  }
  return out;
};
const before = await contentFingerprint();

// ---- STEP 2: the candidate chains and what happens to them
const workspaces = (await M.Workspace.find({}, { _id: 1 }).lean()).map((w) => String(w._id));
const funnel = { workspaces: workspaces.length, signals: 0, signalStages: {}, intelligenceV1WithSafety: 0, intelligenceV1WithoutSafety: 0, decisions: {}, actions: {}, outcomes: { total: 0, v1: 0, v1RecordedByPerson: 0, legacyOrNotRecorded: 0, byStatus: {} } };
for (const ws of workspaces) {
  const signals = await M.Signal.find({ workspaceId: ws }, { _id: 1 }).lean();
  funnel.signals += signals.length;
  const intel = await M.Intelligence.find({ workspaceId: ws }).lean();
  const dec = await M.Decision.find({ workspaceId: ws }).lean(); const act = await M.Action.find({ workspaceId: ws }).lean(); const out = await M.Outcome.find({ workspaceId: ws }).lean();
  for (const i of intel) { if (i.analysisVersion === "intelligence-v1" && i.safety?.state) funnel.intelligenceV1WithSafety += 1; else funnel.intelligenceV1WithoutSafety += 1; }
  for (const d of dec) funnel.decisions[`${d.decisionVersion ?? "legacy"}:${d.status}`] = (funnel.decisions[`${d.decisionVersion ?? "legacy"}:${d.status}`] ?? 0) + 1;
  for (const a of act) funnel.actions[`${a.actionVersion ?? "legacy"}:${a.status}`] = (funnel.actions[`${a.actionVersion ?? "legacy"}:${a.status}`] ?? 0) + 1;
  for (const o of out) { funnel.outcomes.total += 1; if (o.outcomeVersion === "outcome-v1") { funnel.outcomes.v1 += 1; if (o.recordedBy && o.recordedAt) funnel.outcomes.v1RecordedByPerson += 1; else funnel.outcomes.legacyOrNotRecorded += 1; } else funnel.outcomes.legacyOrNotRecorded += 1; funnel.outcomes.byStatus[o.status] = (funnel.outcomes.byStatus[o.status] ?? 0) + 1; }
  // the furthest stage each Signal reached
  for (const s of signals) {
    const sid = String(s._id); const rank = (x) => x;
    const hasI = intel.some((i) => (i.signalIds ?? []).map(String).includes(sid));
    const ds = dec.filter((d) => String(d.signalId) === sid); const as = act.filter((a) => String(a.signalId) === sid); const os = out.filter((o) => String(o.signalId) === sid);
    const stage = os.length ? "outcome_recorded" : as.some((a) => a.status === "approved") ? "action_approved_no_outcome" : as.length ? "action_not_approved" : ds.some((d) => d.status === "approved") ? "decision_approved_no_action" : ds.some((d) => d.status === "rejected") ? "decision_rejected" : ds.length ? "decision_proposed" : hasI ? "intelligence_only" : "signal_only";
    funnel.signalStages[stage] = (funnel.signalStages[stage] ?? 0) + rank(1);
  }
}

// ---- STEP 3/4: replay every derivable case twice
const run1 = await replayWorkspaces(workspaces);
const run2 = await replayWorkspaces(workspaces);
const derivedCases = [...run1.perWorkspaceCases.values()].reduce((s, v) => s + v.cases.length, 0);
const considered = [...run1.perWorkspaceCases.values()].reduce((s, v) => s + v.considered, 0);
const rejected = {}; for (const v of run1.perWorkspaceCases.values()) for (const [k, n] of Object.entries(v.rejected)) rejected[k] = (rejected[k] ?? 0) + n;
const metrics = computeMetrics(run1, { derivedCases });
const deterministic = run1.results.length === run2.results.length && run1.results.every((r, i) => fingerprintOfResult(r) === fingerprintOfResult(run2.results[i]));
const after = await contentFingerprint();
const unchanged = JSON.stringify(before) === JSON.stringify(after);

const artifact = { generatedFor: "Learning L1.1 read-only replay of the real database", database: "koi_staging", readOnly: { driverWritesBlockedAttempts: blocked, contentFingerprintBeforeEqualsAfter: unchanged, collections: Object.keys(before).length, documents: Object.values(before).reduce((s, v) => s + v.count, 0) },
  funnel, derivation: { outcomesConsidered: considered, completedCases: derivedCases, rejectedByReason: rejected }, metrics, determinism: { replays: 2, identical: deterministic },
  perCase: run1.results.map((r) => ({ safetyState: r.facts.safety.state, facets: { equipment: r.facts.issue.equipment, problem: r.facts.issue.problem, condition: r.facts.issue.condition }, topics: r.facts.issue.topics, signalType: r.facts.issue.signalType, actionType: r.facts.action.actionType, outcomeStatus: r.facts.outcome.status, similarCaseCount: r.observation.similarCaseCount, weakMatches: r.selection.weakMatchCount, excluded: r.selection.excluded, sufficient: r.observation.sufficientEvidence, reason: r.observation.insufficientReason, pattern: r.observation.pattern })) };
fs.mkdirSync(path.join(here, "out"), { recursive: true });
fs.writeFileSync(path.join(here, "out", "l1-replay-atlas.json"), JSON.stringify(artifact, null, 2));
console.log(JSON.stringify({ funnel, derivation: artifact.derivation, metrics, determinism: artifact.determinism, readOnly: artifact.readOnly }, null, 1));
console.log(`\nper-case (no ids, no text): ${JSON.stringify(artifact.perCase)}`);
await mongoose.disconnect();
const ok = blocked === 0 && unchanged && deterministic;
console.log(ok ? "\nRESULT: read-only replay complete; nothing was written; the two replays are identical" : "\nRESULT: PROBLEM - see blocked writes / fingerprint / determinism above");
process.exit(ok ? 0 : 1);
