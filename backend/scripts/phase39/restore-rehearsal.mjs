/**
 * Phase 39 - ISOLATED logical backup + restore rehearsal (synthetic data, throwaway databases only; never the development or a production database).
 *
 *   node scripts/phase39/restore-rehearsal.mjs
 *
 * WHAT THIS PROVES: that the APPLICATION's data model survives a logical dump and restore into an empty database - every document returns identical
 * (canonical EJSON hash per collection), every index (including the unique/idempotency indexes) is rebuilt by the models with no migration, uniqueness is
 * enforced again afterwards, and a backend started against the restored database is healthy.
 * WHAT IT DOES NOT PROVE (and does not claim): that any real MongoDB provider takes backups, how often, how long they are kept, that they are encrypted, or
 * that a provider snapshot restores. mongodump/mongorestore are not installed on this machine and no provider exists to test. That stays an OPERATIONS item.
 *
 * Safety: databases are named koi_p39_src_<ts> and koi_p39_dst_<ts>; the script refuses to drop anything else. The dump file lives in a temp directory that is removed.
 */
import "../../src/config/mongoSafety.js"; // validation / rehearsal tool: loopback databases only
import dotenv from "dotenv";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { EJSON } from "bson";

{ const __u = dotenv.parse(process.getBuiltinModule("node:fs").readFileSync(new URL("../../.env", import.meta.url))).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; } // validation / rehearsal tools take ONLY a loopback database URI from backend/.env, never its real settings
const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..", "..");
const base = process.env.MONGODB_URI;
if (!base) { console.error("MONGODB_URI is not configured."); process.exit(2); }
const stamp = Date.now();
const SRC = `koi_p39_src_${stamp}`;
const DST = `koi_p39_dst_${stamp}`;
const uriFor = (name) => base.replace(/(mongodb(?:\+srv)?:\/\/[^/]+\/)([^?]*)/, `$1${name}`);
if (uriFor(SRC) === base) { console.error("Could not derive an isolated database URI."); process.exit(2); }
let passed = 0; let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hashDocs = (docs) => createHash("sha256").update(docs.map((d) => EJSON.stringify(d, { relaxed: false })).sort().join("\n")).digest("hex");

await import("../../src/models/index.js");
const models = Object.entries(mongoose.models);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "koi-p39-"));
const conns = [];
let child = null;
async function dropIfMine(conn) {
  if (!conn.name.startsWith("koi_p39_")) return;
  await Promise.allSettled(models.map(([n, m]) => conn.model(n, m.schema).init()));
  await conn.dropDatabase(); await sleep(300);
  if ((await conn.db.listCollections().toArray()).length > 0) await conn.dropDatabase();
}
try {
  // ---- synthetic source data
  const src = await mongoose.createConnection(uriFor(SRC)).asPromise(); conns.push(src);
  const S = Object.fromEntries(models.map(([n, m]) => [n, src.model(n, m.schema)]));
  await Promise.all(Object.values(S).map((m) => m.init()));
  const ws = await S.Workspace.create({ name: "P39 synthetic", slug: `p39-${stamp}`, status: "active" });
  const prop = await S.Property.create({ workspaceId: ws._id, name: "Synthetic Property", code: "P39-A" });
  await S.Unit.create({ propertyId: prop._id, unitNumber: "101" });
  await S.Unit.create({ propertyId: prop._id, unitNumber: "102" });
  await S.Guest.create({ workspaceId: ws._id, firstName: "Synthetic", lastName: "Guest", externalId: "p39-ext-1" });
  const sig = await S.Signal.create({ workspaceId: ws._id, type: "maintenance", severity: "medium", title: "synthetic signal", description: "synthetic" });
  await S.AnalysisAdmission.create({ workspaceId: ws._id, signalId: sig._id, attemptId: "11111111-1111-4111-8111-111111111111", outcome: "rejected", decidedAt: "claims", reasonCode: "CLAIM_VALIDATION_FAILED", ruleCode: "CLAIM_UNKNOWN_REF", failureClass: "validation_failure", httpStatus: 502, learningUsed: false, stages: { provider: "passed", schema: "passed", identity: "passed", claims: "failed" } });
  const before = {};
  for (const [n] of models) before[n] = await S[n].find({}).lean();
  const nonEmpty = Object.entries(before).filter(([, d]) => d.length > 0).map(([n, d]) => `${n}:${d.length}`);
  check("S1 a synthetic source database was created in a throwaway database (never the development one)", nonEmpty.length >= 5 && src.name === SRC, nonEmpty.join(" "));

  // ---- BACKUP: logical dump of every collection (documents + the index definitions) to a temp file
  const dump = { documents: {}, indexes: {} };
  for (const [n] of models) {
    dump.documents[n] = EJSON.serialize(before[n], { relaxed: false });
    dump.indexes[n] = (await S[n].collection.indexes()).filter((i) => i.name !== "_id_").map((i) => ({ key: i.key, unique: Boolean(i.unique), partial: i.partialFilterExpression ?? null }));
  }
  const dumpFile = path.join(TMP, "dump.json");
  fs.writeFileSync(dumpFile, JSON.stringify(dump));
  check("B1 BACKUP CREATED: a logical dump of every collection and its index definitions was written", fs.statSync(dumpFile).size > 1000, `${fs.statSync(dumpFile).size} bytes`);
  await dropIfMine(src); await src.close(); conns.pop();

  // ---- DISASTER: the source database is gone
  const probe = await mongoose.createConnection(uriFor(SRC)).asPromise(); conns.push(probe);
  check("B2 the source database is gone (simulated loss, throwaway only)", (await probe.db.listCollections().toArray()).length === 0);
  await probe.close(); conns.pop();

  // ---- RESTORE into an empty database
  const dst = await mongoose.createConnection(uriFor(DST)).asPromise(); conns.push(dst);
  const D = Object.fromEntries(models.map(([n, m]) => [n, dst.model(n, m.schema)]));
  const loaded = JSON.parse(fs.readFileSync(dumpFile, "utf8"));
  await Promise.all(Object.values(D).map((m) => m.init())); // the application's own index build, as on first start - no migration step
  for (const [n] of models) { const docs = EJSON.deserialize(loaded.documents[n]); if (docs.length) await D[n].collection.insertMany(docs); }
  const after = {};
  for (const [n] of models) after[n] = await D[n].find({}).lean();
  const mismatched = models.map(([n]) => n).filter((n) => before[n].length !== after[n].length || hashDocs(before[n]) !== hashDocs(after[n]));
  check("R1 RESTORE SUCCESSFUL: every collection is restored with the same document count and an identical canonical hash (content, ids and timestamps included)", mismatched.length === 0, mismatched.join(",") || `${nonEmpty.length} non-empty collections identical`);
  const sameIndexes = [];
  for (const [n] of models) {
    const have = (await D[n].collection.indexes()).filter((i) => i.name !== "_id_").map((i) => JSON.stringify([i.key, Boolean(i.unique), i.partialFilterExpression ?? null])).sort();
    const want = loaded.indexes[n].map((i) => JSON.stringify([i.key, i.unique, i.partial])).sort();
    if (JSON.stringify(have) !== JSON.stringify(want)) sameIndexes.push(n);
  }
  check("R2 every index (unique, partial, idempotency) exists after the restore, rebuilt by the models with no migration", sameIndexes.length === 0, sameIndexes.join(",") || "all collections");
  let dup = null;
  try { await D.Property.create({ workspaceId: after.Property[0].workspaceId, name: "dup", code: "P39-A" }); } catch (e) { dup = e; }
  let dupAdm = null;
  try { await D.AnalysisAdmission.create({ ...after.AnalysisAdmission[0], _id: new mongoose.Types.ObjectId() }); } catch (e) { dupAdm = e; }
  check("R3 uniqueness is ENFORCED again after the restore (a duplicate property code and a duplicate audit attempt are both refused)", dup?.code === 11000 && dupAdm?.code === 11000);

  // ---- the application starts and is healthy against the restored database
  const port = 5393;
  child = spawn(process.execPath, [path.join(BACKEND, "server.js")], { env: { ...process.env, NODE_ENV: "test", PORT: String(port), MONGODB_URI: uriFor(DST), LLM_PROVIDER: "test-python", AI_SERVICE_URL: "http://localhost:1" }, stdio: ["ignore", "pipe", "pipe"] });
  let health = null;
  for (let i = 0; i < 60 && !health; i += 1) { try { const r = await fetch(`http://localhost:${port}/api/health`); if (r.ok) health = await r.json(); } catch { /* starting */ } await sleep(300); }
  check("R4 a backend started against the restored database is healthy and connected to it", health?.status === "healthy" && health?.database === "connected");
} finally {
  if (child) { try { child.kill(); } catch { /* gone */ } }
  for (const c of conns) { try { await dropIfMine(c); await c.close(); } catch { /* best effort */ } }
  for (const name of [SRC, DST]) { try { const c = await mongoose.createConnection(uriFor(name)).asPromise(); await dropIfMine(c); await c.close(); } catch { /* best effort */ } }
  fs.rmSync(TMP, { recursive: true, force: true });
}
const leftover = await (async () => { const c = await mongoose.createConnection(base).asPromise(); const l = (await c.getClient().db().admin().listDatabases()).databases.map((d) => d.name).filter((n) => n.startsWith("koi_p39_")); await c.close(); return l; })();
check("Z1 nothing is left behind: no throwaway database, no dump file", leftover.length === 0 && !fs.existsSync(TMP), leftover.join(",") || "none");
console.log(`\nPhase 39 isolated restore rehearsal: ${passed} passed, ${failed} failed (this does NOT verify any real backup provider)`);
process.exit(failed === 0 ? 0 : 1);
