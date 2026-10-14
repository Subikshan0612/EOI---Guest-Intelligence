/**
 * Phase 41 - compare the indexes the application REQUIRES (declared by the Mongoose models) with the indexes that EXIST in a MongoDB database. READ-ONLY.
 *
 *   node scripts/phase41/atlas-indexes.mjs [--env-file .env] [--full]
 *
 * It never creates, drops or changes an index. Initialising indexes is the application's own job (Mongoose autoIndex when the backend connects, or
 * `npm`-less `Model.init()`); run this before and after to see the difference. Prints no credential, URI or host.
 * Exit 0 = every required index is present with the expected options; 1 = something is missing or differs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..", "..");
const args = process.argv.slice(2);
const fileArg = args.includes("--env-file") ? args[args.indexOf("--env-file") + 1] : path.join(BACKEND, ".env");
const FULL = args.includes("--full");
const uri = fs.existsSync(fileArg) ? dotenv.parse(fs.readFileSync(fileArg, "utf8")).MONGODB_URI : process.env.MONGODB_URI;
if (!uri) { console.error("No MONGODB_URI found."); process.exit(2); }
await import("../../src/models/index.js");

const sigOf = (keys, o = {}) => JSON.stringify({ k: Object.entries(keys).map(([f, d]) => `${f}:${d}`), u: Boolean(o.unique), p: o.partialFilterExpression ? JSON.stringify(o.partialFilterExpression) : null, s: Boolean(o.sparse), t: o.expireAfterSeconds ?? null });
const expected = [];
for (const [name, model] of Object.entries(mongoose.models)) {
  const coll = model.collection.collectionName;
  const seen = new Set();
  for (const [keys, options] of model.schema.indexes()) { const s = sigOf(keys, options); if (!seen.has(s)) { seen.add(s); expected.push({ model: name, coll, keys, options: options ?? {}, sig: s }); } }
}
const client = new mongoose.mongo.MongoClient(uri, { serverSelectionTimeoutMS: 15000, appName: "koi-phase41-index-check" });
let rows = []; let extras = [];
try {
  await client.connect();
  const dbName = /^(?:[^:]+):\/\/[^/]+\/([^?]*)/.exec(uri)?.[1];
  const db = client.db(dbName);
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const actualByColl = {};
  for (const c of existing) actualByColl[c] = (await db.collection(c).indexes()).filter((i) => i.name !== "_id_").map((i) => ({ name: i.name, sig: sigOf(i.key, i), key: i.key, i }));
  for (const e of expected) {
    const actual = actualByColl[e.coll] ?? null;
    const hit = actual?.find((a) => a.sig === e.sig);
    const sameKeys = actual?.find((a) => JSON.stringify(Object.entries(a.key)) === JSON.stringify(Object.entries(e.keys)));
    rows.push({ ...e, status: !existing.has(e.coll) ? "MISSING (collection absent)" : hit ? "OK" : sameKeys ? "OPTIONS DIFFER" : "MISSING" });
  }
  const expSigs = new Set(expected.map((e) => `${e.coll}|${e.sig}`));
  for (const [coll, list] of Object.entries(actualByColl)) for (const a of list) if (!expSigs.has(`${coll}|${a.sig}`)) extras.push(`${coll}: ${a.name}`);
} catch { console.error("Could not read the database (run atlas-preflight.mjs for the reason)."); process.exit(2); } finally { await client.close().catch(() => {}); }

const label = (e) => `${e.keys ? Object.entries(e.keys).map(([f, d]) => `${f}:${d}`).join(", ") : ""}`;
const opts = (o) => [o.unique ? "unique" : "", o.partialFilterExpression ? "partial" : "", o.sparse ? "sparse" : "", o.expireAfterSeconds !== undefined ? "ttl" : ""].filter(Boolean).join("+") || "-";
const important = (r) => r.options.unique || /^(AnalysisAdmission|Intelligence|Decision|Action|Outcome)$/.test(r.model) || /^workspaceId/.test(label(r));
const shown = rows.filter((r) => FULL || important(r) || r.status !== "OK");
console.log("| COLLECTION | REQUIRED INDEX | EXPECTED | ACTUAL | STATUS |\n|---|---|---|---|---|");
for (const r of shown) console.log(`| ${r.coll} | ${label(r)} | ${opts(r.options)} | ${r.status === "OK" ? "present" : r.status.startsWith("OPTIONS") ? "present, other options" : "absent"} | ${r.status} |`);
const ok = rows.filter((r) => r.status === "OK").length;
console.log(`\nRequired indexes: ${rows.length}; OK: ${ok}; MISSING/DIFFERENT: ${rows.length - ok}; extra (not required by the models): ${extras.length}${extras.length ? ` -> ${extras.join("; ")}` : ""}`);
const must = rows.filter((r) => r.options.unique);
console.log(`Unique / idempotency indexes: ${must.filter((r) => r.status === "OK").length} of ${must.length} present`);
console.log(`Tenant (workspaceId-prefixed) indexes: ${rows.filter((r) => /^workspaceId/.test(label(r)) && r.status === "OK").length} of ${rows.filter((r) => /^workspaceId/.test(label(r))).length} present`);
console.log(`AnalysisAdmission indexes: ${rows.filter((r) => r.model === "AnalysisAdmission" && r.status === "OK").length} of ${rows.filter((r) => r.model === "AnalysisAdmission").length} present`);
process.exit(rows.length === ok ? 0 : 1);
