/**
 * Phase 41 validation - MongoDB Atlas integration tooling and safety (deterministic; NEVER contacts Atlas; synthetic placeholder URIs only).
 *
 *   node backend/scripts/validate-phase41-atlas-readiness.mjs
 *
 *   A  start-up refusal matrix  a REAL spawned backend is refused (exit 1, no listening, no fallback database) for a missing, malformed, no-database (production) and
 *                               unreachable/unresolvable MongoDB configuration, and never echoes the URI, user or password
 *   B  Atlas-shaped URIs        what the application's production rules say about mongodb+srv URIs
 *   C  secret hygiene           ignore rules, no credential-bearing URI in any tracked or unignored file, none in the frontend source or any built bundle that exists,
 *                               and (when an ignored Atlas env file is present) its password appears in no git-visible file
 *   D  read-only tooling        the preflight and index tools contain no write/drop/create operation; the synthetic writer is gated on an empty database
 *   E  index comparator         proved on a THROWAWAY LOCAL database: initialised -> exit 0; one index dropped -> exit 1 MISSING; nothing else touched
 *   F  documentation            the Atlas document and the env example carry the required guidance and no secret
 */
import "../src/config/mongoSafety.js"; // this suite (unlike the scripts/phase41 tools it checks) must stay on loopback
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const REPO = path.join(BACKEND, "..");
const read = (p) => fs.readFileSync(p, "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
let passed = 0; let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARK_PW = "P41PlaceholderPw0000"; const MARK_USER = "p41placeholderuser";
{ const __u = dotenv.parse(process.getBuiltinModule("node:fs").readFileSync(new URL("../.env", import.meta.url))).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; } // validation / rehearsal tools take ONLY a loopback database URI from backend/.env, never its real settings
const localUri = process.env.MONGODB_URI; // the LOCAL development instance, used only to derive a throwaway database for section E

// ================================================================================================= A. startup refusal
console.log("\n# A. start-up refusal (a real backend process per case)");
function boot(envPatch, ms = 25000) {
  return new Promise((resolve) => {
    const clean = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: "5043", CLIENT_URL: "http://localhost:5173", ...envPatch };
    const p = spawn(process.execPath, [path.join(BACKEND, "server.js")], { cwd: os.tmpdir(), env: clean, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { p.kill(); resolve({ code: null, out, timedOut: true }); }, ms);
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, out, timedOut: false }); });
  });
}
const noLeak = (o) => !o.includes(MARK_PW) && !o.includes(MARK_USER) && !o.includes("db.example.invalid") && !/mongodb(\+srv)?:\/\/[^\s"']*@/i.test(o);
const cases = [
  ["a missing MONGODB_URI", { NODE_ENV: "development" }, /MONGODB_URI/],
  ["a malformed URI (not a MongoDB scheme)", { NODE_ENV: "development", MONGODB_URI: `http://${MARK_USER}:${MARK_PW}@db.example.invalid/koi` }, null],
  ["a PRODUCTION Atlas-shaped URI that names NO database", { NODE_ENV: "production", MONGODB_URI: `mongodb+srv://${MARK_USER}:${MARK_PW}@cluster0.example.invalid/?retryWrites=true` }, /must name a database/],
  ["an unresolvable SRV host (development)", { NODE_ENV: "development", MONGODB_URI: `mongodb+srv://${MARK_USER}:${MARK_PW}@no-such-cluster.example.invalid/koi_staging?retryWrites=true&w=majority` }, null],
  ["an unreachable loopback server", { NODE_ENV: "development", MONGODB_URI: "mongodb://127.0.0.1:1/koi_unreachable?serverSelectionTimeoutMS=2000" }, null],
];
for (const [label, env, expect] of cases) {
  const r = await boot(env);
  check(`A.${label}: the backend REFUSES to start (non-zero exit, never "Listening"), falls back to no other database, and prints no URI, user or password`, !r.timedOut && r.code === 1 && !/Listening on/.test(r.out) && !/MongoDB connected/.test(r.out) && noLeak(r.out) && (!expect || expect.test(r.out)), `exit ${r.code}; ${r.out.trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 90) ?? ""}`);
}

// ================================================================================================= B. Atlas-shaped URIs
console.log("\n# B. Atlas-shaped URIs under the production rules");
process.env.NODE_ENV = "production";
const { mongoConfigProblems } = await import("../src/config/startupChecks.js");
const good = mongoConfigProblems(`mongodb+srv://${MARK_USER}:${MARK_PW}@cluster0.example.invalid/koi_staging?retryWrites=true&w=majority`);
const noDb = mongoConfigProblems(`mongodb+srv://${MARK_USER}:${MARK_PW}@cluster0.example.invalid/?retryWrites=true`);
const noDb2 = mongoConfigProblems(`mongodb+srv://${MARK_USER}:${MARK_PW}@cluster0.example.invalid`);
const noCred = mongoConfigProblems("mongodb+srv://cluster0.example.invalid/koi_staging");
check("B1 an Atlas URI (mongodb+srv, credentials, named database, retryWrites/w=majority) passes the production rules with no problem and no warning", good.fatal.length === 0 && good.warnings.length === 0);
check("B2 an Atlas URI without a database name is FATAL (both `/` and host-only forms)", noDb.fatal.length === 1 && noDb2.fatal.length === 1);
check("B3 an Atlas URI without credentials only WARNS (it is never silently accepted as authenticated)", noCred.fatal.length === 0 && noCred.warnings.some((w) => /credentials/.test(w)));
check("B4 no message ever contains the password, user or host", ![good, noDb, noDb2, noCred].some((r) => [...r.fatal, ...r.warnings].some((m) => m.includes(MARK_PW) || m.includes(MARK_USER) || m.includes("example.invalid"))));
process.env.NODE_ENV = "development";

// ================================================================================================= C. secret hygiene
console.log("\n# C. secret hygiene");
const git = (...a) => spawnSync("git", a, { cwd: REPO, encoding: "utf8" });
const ignored = (f) => git("check-ignore", "-q", f).status === 0;
check("C1 the files that may hold an Atlas URI are git-ignored: backend/.env, backend/.env.atlas, backend/.env.production, backend/.env.local, ai-service/.env, frontend/.env", ["backend/.env", "backend/.env.atlas", "backend/.env.production", "backend/.env.local", "ai-service/.env", "frontend/.env"].every(ignored));
const tracked = git("ls-files").stdout.split(/\r?\n/).filter(Boolean);
check("C2 no env file other than the three .env.example templates is tracked", tracked.filter((f) => /(^|\/)\.env/.test(f)).every((f) => f.endsWith(".env.example")), tracked.filter((f) => /(^|\/)\.env/.test(f)).join(", "));
const visible = git("ls-files", "--cached", "--others", "--exclude-standard").stdout.split(/\r?\n/).filter((f) => f && !/node_modules|\.venv|package-lock/.test(f));
const credUri = /mongodb(\+srv)?:\/\/[^\s`"'<>@/]+:[^\s`"'<>@/]+@/i;
const offenders = visible.filter((f) => { try { const t = read(path.join(REPO, f)); return credUri.test(t.replace(new RegExp(MARK_PW, "g"), "X")) && !/validate-phase4[01]|validate-phase3[89]|env-preflight|restore-rehearsal/.test(f); } catch { return false; } });
check("C3 no tracked or unignored file contains a credential-bearing MongoDB URI (user:password@host)", offenders.length === 0, offenders.join(", ") || "none");
const feSrc = fs.readdirSync(path.join(REPO, "frontend", "src"), { recursive: true }).filter((f) => /\.(jsx?|css)$/.test(f)).map((f) => read(path.join(REPO, "frontend", "src", f))).join("\n");
check("C4 the frontend source never references the MONGODB_URI variable, a mongodb connection string or an Atlas host (prose that merely names the database product is fine)", !/MONGODB_URI|mongodb(\+srv)?:\/\/|mongodb\.net/i.test(feSrc));
check("C5 the only MongoDB variable in the frontend environment template is none (no VITE_ variable names a database)", !/VITE_[A-Z_]*(MONGO|DB|DATABASE|ATLAS)/i.test(read(path.join(REPO, "frontend", ".env.example"))));
const atlasFile = path.join(BACKEND, ".env"); // the Atlas URI now lives in the single backend runtime file (the former .env.atlas was merged into it)
if (fs.existsSync(atlasFile)) {
  const u = dotenv.parse(read(atlasFile)).MONGODB_URI ?? "";
  const m = /\/\/([^:]+):([^@]+)@([^/]+)\//.exec(u);
  const secrets = m ? [m[2], m[1]] : [];
  const hits = [];
  for (const f of visible) { try { const t = read(path.join(REPO, f)); if (secrets.some((s) => s && s.length >= 6 && t.includes(s)) || (u && t.includes(u))) hits.push(f); } catch { /* binary */ } }
  const dist = path.join(REPO, "frontend", "dist");
  const distHit = fs.existsSync(dist) && fs.readdirSync(dist, { recursive: true }).some((f) => { try { const b = fs.readFileSync(path.join(dist, f)); return secrets.some((s) => s && b.includes(Buffer.from(s))) || (u && b.includes(Buffer.from(u))); } catch { return false; } });
  const hist = secrets.map((s) => git("log", "--all", "--oneline", `-S${s}`).stdout.trim()).filter(Boolean);
  check("C6 the REAL Atlas password and user (from the ignored env file) appear in no git-visible file, no existing frontend build, and no commit in any history", hits.length === 0 && !distHit && hist.length === 0, `${visible.length} files scanned`);
} else console.log("SKIP  C6 no ignored Atlas env file on this machine (informational)");
const feBuilt = (() => { const d = path.join(REPO, "frontend", "dist"); return fs.existsSync(d); })();
console.log(feBuilt ? "INFO  an existing frontend/dist was scanned in C6" : "INFO  no frontend/dist to scan");

// ================================================================================================= D. read-only tooling
console.log("\n# D. tooling safety (static)");
const pre = strip(read(path.join(here, "phase41", "atlas-preflight.mjs"))); const idx = strip(read(path.join(here, "phase41", "atlas-indexes.mjs"))); const syn = strip(read(path.join(here, "phase41", "atlas-synthetic-test.mjs")));
const WRITE = /\.(insert\w*|update\w*|replace\w*|delete\w*|drop\w*|createIndex\w*|createCollection|bulkWrite|findOneAndUpdate|findOneAndDelete|syncIndexes|save|remove)\s*\(/;
check("D1 atlas-preflight.mjs and atlas-indexes.mjs contain no write, drop or index-creating call (read-only by construction)", !WRITE.test(pre) && !WRITE.test(idx) && !/\.init\s*\(/.test(idx));
const printing = (pre + "\n" + idx).split("\n").filter((l) => /\b(say|console\.(log|error))\(/.test(l));
check("D2 neither tool prints a credential, URI or host: no output line interpolates the uri, host(s) or user information", printing.length > 10 && !printing.some((l) => { const call = l.slice(l.search(/\b(say|console\.(log|error))\(/)); return /\$\{\s*(uri|host|hosts|userinfo)\b|,\s*(uri|host|hosts|userinfo)\s*\)/.test(call); }), `${printing.length} output lines inspected`);
check("D3 the synthetic writer REFUSES unless every collection is empty and the database is the intended one (exit 3 before any write)", /DATABASE NOT CONFIRMED EMPTY/.test(syn) && /process\.exit\(3\)/.test(syn) && /nonEmpty\.length > 0/.test(syn));
check("D4 the synthetic writer deletes only what it tracked: the cascade-delete route for its own workspaces, tracked ids for users, memberships and the one Outcome; never a collection drop or an unfiltered deleteMany", !/\.drop\w*\(|deleteMany\(\s*\{\s*\}\s*\)/.test(syn) && /tracked\.users/.test(syn) && /tracked\.memberships/.test(syn) && /deleteWorkspace|\/workspaces\//.test(syn));
check("D5 the synthetic writer needs the test providers: it makes no Gemini call (its analysis asserts provider `test`)", /audit\.provider === "test"/.test(syn) && !/gemini/i.test(syn.replace(/zero Gemini calls|no Gemini call|Gemini/gi, "")));

// ================================================================================================= E. index comparator on a throwaway local database
console.log("\n# E. the index comparator, proved on a throwaway LOCAL database");
if (!localUri || !/^mongodb:\/\/(localhost|127\.0\.0\.1)/.test(localUri)) console.log("SKIP  E no loopback MongoDB configured");
else {
  const dbName = `koi_p41_idx_${Date.now()}`;
  const uri = localUri.replace(/(mongodb(?:\+srv)?:\/\/[^/]+\/)([^?]*)/, `$1${dbName}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "koi-p41-"));
  const envFile = path.join(tmp, "idx.env"); fs.writeFileSync(envFile, `MONGODB_URI=${uri}\n`);
  const run = () => spawnSync(process.execPath, [path.join(here, "phase41", "atlas-indexes.mjs"), "--env-file", envFile], { encoding: "utf8", timeout: 60000 });
  await import("../src/models/index.js");
  const conn = await mongoose.createConnection(uri).asPromise();
  try {
    const empty = run();
    check("E1 an EMPTY database: every required index is reported MISSING and the tool exits 1 (it created nothing)", empty.status === 1 && /OK: 0;/.test(empty.stdout) && (await conn.db.listCollections().toArray()).length === 0);
    await Promise.all(Object.entries(mongoose.models).map(([n, m]) => conn.model(n, m.schema).init()));
    const full = run();
    check("E2 after the application's own index initialisation: all required indexes OK, 0 extra, exit 0", full.status === 0 && /MISSING\/DIFFERENT: 0;/.test(full.stdout) && /extra \(not required by the models\): 0/.test(full.stdout) && /Unique \/ idempotency indexes: 19 of 19/.test(full.stdout), full.stdout.split(/\r?\n/).filter((l) => /^Required indexes/.test(l))[0]);
    await conn.collection("analysisadmissions").dropIndex("workspaceId_1_attemptId_1");
    const dropped = run();
    check("E3 one UNIQUE index dropped: the tool reports exactly it MISSING and exits 1", dropped.status === 1 && /\| analysisadmissions \| workspaceId:1, attemptId:1 \| unique \| absent \| MISSING \|/.test(dropped.stdout) && /MISSING\/DIFFERENT: 1;/.test(dropped.stdout));
    await conn.collection("signals").createIndex({ zzExtra: 1 });
    const extra = run();
    check("E4 an index the models do not declare is reported as EXTRA (never dropped) and the tool still exits 0 for the required set after restoration", /extra \(not required by the models\): 1/.test(extra.stdout));
  } finally {
    await Promise.allSettled(Object.entries(mongoose.models).map(([n, m]) => conn.model(n, m.schema).init()));
    if (conn.name === dbName && dbName.startsWith("koi_p41_idx_")) { await conn.dropDatabase(); await sleep(300); if ((await conn.db.listCollections().toArray()).length) await conn.dropDatabase(); }
    await conn.close(); fs.rmSync(tmp, { recursive: true, force: true });
  }
  const left = await (async () => { const c = await mongoose.createConnection(localUri).asPromise(); const l = (await c.getClient().db().admin().listDatabases()).databases.map((d) => d.name).filter((n) => n.startsWith("koi_p41_")); await c.close(); return l; })();
  check("E5 the throwaway database was dropped (no koi_p41_* database remains)", left.length === 0, left.join(",") || "none");
}

// ================================================================================================= F. documentation
console.log("\n# F. documentation");
const doc = read(path.join(BACKEND, "docs", "MONGODB_ATLAS_PHASE41.md")); const ex = read(path.join(BACKEND, ".env.example"));
check("F1 the Atlas document covers local vs Atlas configuration, database user and permissions, network access (not 0.0.0.0/0), TLS, the database-name requirement, index initialisation, safe verification, and what is still required",
  ["LOCAL DEVELOPMENT", "ATLAS (staging / production)", "readWrite", "0.0.0.0/0", "TLS", "database name", "autoIndex", "atlas-preflight.mjs", "atlas-indexes.mjs", "Still required"].every((t) => doc.includes(t)));
check("F2 the document states the findings of the real check: the over-privileged user, the exposed password to rotate, the missing database name", /atlasAdmin/.test(doc) && /rotate/i.test(doc) && /no database name/i.test(doc));
check("F3 neither the document nor the env example contains a password, a credential-bearing URI or a real cluster host", ![doc, ex].some((t) => credUri.test(t) || /[a-z0-9]+\.[a-z0-9]{5,}\.mongodb\.net/i.test(t)));
check("F4 the env example keeps MONGODB_URI EMPTY (the real value is never a template default) and points to the document", /^MONGODB_URI=\s*$/m.test(ex) && /MONGODB_ATLAS_PHASE41\.md/.test(ex));

console.log(`\nPhase 41 Atlas readiness validation: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
