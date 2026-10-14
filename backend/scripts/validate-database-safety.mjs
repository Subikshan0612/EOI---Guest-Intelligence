/**
 * Database-safety guard validation (src/config/mongoSafety.js).
 *
 *   node backend/scripts/validate-database-safety.mjs
 *
 * backend/.env holds the real (Atlas) MongoDB URI, so everything that is not the real application must be unable to reach a remote database by accident. This suite proves,
 * WITHOUT ever contacting a real database (every "remote" target below is an unresolvable .invalid host, and a refusal happens before any socket is opened):
 *   P  the URI parser / loopback rule (every host of a multi-host URI, SRV, userinfo, IPv6, look-alikes)
 *   H  HARD enforcement (validation process / NODE_ENV=test) through EVERY connection API: mongoose.connect, mongoose.createConnection, MongoClient#connect, MongoClient.connect
 *   S  SOFT enforcement + opt-in for development / seed / provision scripts, strict (no opt-in) for offline evaluation
 *   N  the normal runtime is NOT governed (the real server keeps using whatever backend/.env says)
 *   D  the listed dev / seed / provision / evaluation scripts are protected (static and by really running one against a remote URI)
 *   I  the intentionally remote Phase 41 Atlas tools are untouched
 *   W  a stray KOI_NO_DOTENV in a real server is reported; no extra .env files exist
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..");
const REPO = path.join(BACKEND, "..");
const read = (p) => fs.readFileSync(p, "utf8");
let passed = 0; let failed = 0;
const check = (name, ok, detail = "") => { if (ok) { passed += 1; console.log(`PASS  ${name}`); } else { failed += 1; console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`); } };

const safety = await import("../src/config/mongoSafety.js");
const { default: mongoose } = await import("mongoose");
const { runtimeWarnings } = await import("../src/config/startupChecks.js");
const { mongoUriHosts, isLoopbackMongoUri, assertMongoUriAllowed, requireLoopbackDatabase, markValidationProcess } = safety;

const REMOTE = "mongodb+srv://guard-user:guard-pass@guard-test-cluster.invalid/guard_db?retryWrites=true";
const REMOTE_PLAIN = "mongodb://guard-user:guard-pass@guard-test-host.invalid:27017/guard_db";
const MULTI_REMOTE_SECOND = "mongodb://127.0.0.1:27017,guard-test-host.invalid:27017/guard_db";
const MULTI_REMOTE_FIRST = "mongodb://guard-test-host.invalid:27017,127.0.0.1:27017/guard_db";
const MULTI_REMOTE_AFTER_AT = "mongodb://u:p@localhost:27017,127.0.0.1:27017,guard-test-host.invalid/guard_db";
const LOOPBACK_OK = ["mongodb://127.0.0.1:27017/x", "mongodb://localhost/x", "mongodb://[::1]:27017/x", "mongodb://u:p@localhost:27017/x?replicaSet=r", "mongodb://127.0.0.1:27017,localhost:27018,[::1]:27019/x"];
const env = { ...process.env };
const restoreEnv = () => { for (const k of ["NODE_ENV", "KOI_NO_DOTENV", "KOI_NO_DOTENV_REASON", "KOI_REQUIRE_LOOPBACK_DB", "KOI_ALLOW_REMOTE_DB"]) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } };
const rejectsRefusal = async (fn) => { const t0 = Date.now(); try { await fn(); return false; } catch (e) { return /Refusing to open a MongoDB connection/.test(e?.message ?? "") && Date.now() - t0 < 3000; } };

// ============================================================================================================ P
console.log("# P. the loopback rule");
check("P1 every ACCEPTABLE form is loopback: 127.0.0.1, localhost, [::1], credentials, a replica-set list made only of loopback hosts", LOOPBACK_OK.every(isLoopbackMongoUri));
check("P2 a single remote host, an Atlas SRV URI, and an SRV URI whose name merely looks local are NOT loopback", ![REMOTE, REMOTE_PLAIN, "mongodb+srv://localhost/x", "mongodb+srv://127.0.0.1/x"].some(isLoopbackMongoUri));
check("P3 EVERY host is validated: a remote host in ANY position of a multi-host list (first, second, or after userinfo) makes the whole URI non-loopback", ![MULTI_REMOTE_SECOND, MULTI_REMOTE_FIRST, MULTI_REMOTE_AFTER_AT].some(isLoopbackMongoUri) && mongoUriHosts(MULTI_REMOTE_SECOND).length === 2);
check("P4 look-alikes and tricks are refused: localhost.<domain>, a user named localhost, 127.0.0.2, 0.0.0.0, a unix socket, an empty host, garbage, null", !["mongodb://localhost.evil.invalid/x", "mongodb://localhost@guard-test-host.invalid/x", "mongodb://127.0.0.2:27017/x", "mongodb://0.0.0.0:27017/x", "mongodb://%2Ftmp%2Fmongodb-27017.sock/x", "mongodb://:27017/x", "not a uri", "", null, undefined, 42].some(isLoopbackMongoUri));

// ============================================================================================================ H
console.log("\n# H. hard enforcement through every connection API");
check("H0 this suite IS a validation process (marked at import): KOI_NO_DOTENV=1 with the reason 'validation', so the enforcement below is the one every suite and every server it spawns runs under", process.env.KOI_NO_DOTENV === "1" && process.env.KOI_NO_DOTENV_REASON === "validation");
const apis = {
  "mongoose.connect()": (u) => mongoose.connect(u),
  "mongoose.createConnection()": (u) => mongoose.createConnection(u),
  "new MongoClient().connect()": (u) => new mongoose.mongo.MongoClient(u).connect(),
  "MongoClient.connect()": (u) => mongoose.mongo.MongoClient.connect(u),
};
for (const [name, call] of Object.entries(apis)) {
  const results = [];
  for (const target of [REMOTE, REMOTE_PLAIN, MULTI_REMOTE_SECOND, MULTI_REMOTE_FIRST]) results.push(await rejectsRefusal(() => call(target)));
  check(`H1 ${name} refuses an Atlas URI, a remote URI and BOTH multi-host forms before any socket is opened`, results.every(Boolean), results.join());
}
// the same with ONLY NODE_ENV=test (no validation marker): the original test-mode protection holds through every API as well
delete process.env.KOI_NO_DOTENV; delete process.env.KOI_NO_DOTENV_REASON; process.env.NODE_ENV = "test";
{
  const results = [];
  for (const call of Object.values(apis)) for (const target of [REMOTE, MULTI_REMOTE_SECOND]) results.push(await rejectsRefusal(() => call(target)));
  check("H2 NODE_ENV=test alone (no validation marker) refuses a single remote URI and a multi-host URI with a remote host through all four APIs", results.every(Boolean), results.join());
  let connectDatabaseRefused = false; try { process.env.MONGODB_URI = REMOTE; const { connectDatabase } = await import("../src/config/database.js"); await connectDatabase(); } catch (e) { connectDatabaseRefused = /Refusing/.test(e.message) || /Missing required/.test(e.message); }
  check("H3 connectDatabase() under NODE_ENV=test refuses a remote URI too (its own early check; env.mongodbUri was captured at import)", connectDatabaseRefused);
}
restoreEnv();
check("H4 an exported remote MONGODB_URI cannot make a validation process write to it: the refusal does not read MONGODB_URI at all, it judges the URI actually being opened", await rejectsRefusal(() => mongoose.connect(REMOTE)));

// ============================================================================================================ S
console.log("\n# S. development / seed / provision scripts (soft) and offline evaluation (strict)");
for (const k of ["KOI_NO_DOTENV", "KOI_NO_DOTENV_REASON"]) delete process.env[k]; delete process.env.NODE_ENV; delete process.env.KOI_REQUIRE_LOOPBACK_DB; delete process.env.KOI_ALLOW_REMOTE_DB;
const argvBefore = [...process.argv];
const refused = (u) => { try { assertMongoUriAllowed(u); return false; } catch (e) { return /Refusing to open a MongoDB connection/.test(e.message); } };
check("S0 before a script calls the guard (and outside a validation / test process) nothing is restricted", !refused(REMOTE));
requireLoopbackDatabase("unit-test");
check("S1 after requireLoopbackDatabase() a remote single URI, an SRV URI and both multi-host forms are refused; loopback URIs are accepted", [REMOTE, REMOTE_PLAIN, MULTI_REMOTE_SECOND, MULTI_REMOTE_FIRST].every(refused) && LOOPBACK_OK.every((u) => !refused(u)));
check("S2 the message names no host, user, password or URI", (() => { try { assertMongoUriAllowed(REMOTE); } catch (e) { return !/guard-test|guard-user|guard-pass|mongodb\+srv|invalid/.test(e.message); } return false; })());
delete process.env.KOI_REQUIRE_LOOPBACK_DB; process.argv.push("--allow-remote-db", "keep-me");
requireLoopbackDatabase("unit-test");
check("S3 --allow-remote-db is the deliberate opt-in: it lifts the restriction for that run, and is removed from argv so the script's own argument parsing never sees it", !refused(REMOTE) && !process.argv.includes("--allow-remote-db") && process.argv.includes("keep-me"));
process.argv.length = 0; process.argv.push(...argvBefore); delete process.env.KOI_REQUIRE_LOOPBACK_DB;
process.env.KOI_ALLOW_REMOTE_DB = "1"; requireLoopbackDatabase("unit-test"); const envOptIn = !refused(REMOTE); delete process.env.KOI_ALLOW_REMOTE_DB; delete process.env.KOI_REQUIRE_LOOPBACK_DB;
process.argv.push("--allow-remote-db"); requireLoopbackDatabase("offline-evaluation", { allowOptIn: false }); const strictRefuses = refused(REMOTE) && process.env.KOI_REQUIRE_LOOPBACK_DB === "strict";
process.argv.length = 0; process.argv.push(...argvBefore); process.env.KOI_ALLOW_REMOTE_DB = "1";
const strictIgnoresEnvOptIn = refused(REMOTE);
delete process.env.KOI_ALLOW_REMOTE_DB; delete process.env.KOI_REQUIRE_LOOPBACK_DB;
check("S4 KOI_ALLOW_REMOTE_DB=1 is the same opt-in; a script that declares { allowOptIn: false } (offline evaluation) has NO opt-in: neither the flag nor the variable lifts the refusal", envOptIn && strictRefuses && strictIgnoresEnvOptIn);
process.env.KOI_NO_DOTENV = "1"; process.env.KOI_NO_DOTENV_REASON = "validation"; process.env.KOI_ALLOW_REMOTE_DB = "1"; process.argv.push("--allow-remote-db");
check("S5 inside a validation process / NODE_ENV=test NO opt-in exists: the flag and the variable are ignored", refused(REMOTE) && refused(MULTI_REMOTE_SECOND));
process.argv.length = 0; process.argv.push(...argvBefore); restoreEnv();

// ============================================================================================================ N
console.log("\n# N. the normal runtime is not governed");
for (const k of ["KOI_NO_DOTENV", "KOI_NO_DOTENV_REASON", "KOI_REQUIRE_LOOPBACK_DB", "KOI_ALLOW_REMOTE_DB"]) delete process.env[k]; process.env.NODE_ENV = "development";
check("N1 with no marker, NODE_ENV=development and no script flag, the guard allows ANY URI (the real backend keeps using the Atlas URI from backend/.env)", !refused(REMOTE) && !refused(MULTI_REMOTE_SECOND));
process.env.NODE_ENV = "production"; check("N2 ... and in production", !refused(REMOTE));
check("N3 markValidationProcess() only marks validate-*.mjs and scripts/phaseNN/* (not Phase 41, not server.js, not start-google-dev, not the dev scripts)", (() => { const keep = { ...process.env }; const probe = (p) => { delete process.env.KOI_NO_DOTENV; delete process.env.KOI_NO_DOTENV_REASON; return markValidationProcess(p); }; const r = [probe("C:\\x\\scripts\\validate-api.mjs"), probe("/x/scripts/phase40/e2e-acceptance.mjs"), probe("C:\\x\\scripts\\phase43d\\browser-fixture.mjs")]; const n = [probe("/x/backend/server.js"), probe("/x/scripts/start-google-dev.mjs"), probe("/x/scripts/phase41/atlas-preflight.mjs"), probe("/x/scripts/create-dev-workspace.mjs"), probe("/x/evaluation/retrieval/run-evaluation.mjs")]; Object.assign(process.env, keep); return r.every(Boolean) && n.every((x) => !x); })());
restoreEnv();

// ============================================================================================================ D
console.log("\n# D. the listed development / seed / provision / evaluation scripts");
const protectedScripts = { "scripts/create-dev-workspace.mjs": true, "scripts/provision-user.mjs": true, "scripts/provision-dev-identity.mjs": true, "scripts/seed-kolam-gandhi-property.mjs": true, "scripts/dry-run-operational-csv.mjs": true, "scripts/workspace-lifecycle.mjs": true, "evaluation/retrieval/run-evaluation.mjs": false };
check("D1 each listed script calls requireLoopbackDatabase() before it does anything (the offline evaluation with { allowOptIn: false }), importing it from the central module", Object.entries(protectedScripts).every(([f, opt]) => { const s = read(path.join(BACKEND, f)); return /import \{ requireLoopbackDatabase \} from "[./]*src\/config\/mongoSafety\.js"/.test(s) && (opt ? /requireLoopbackDatabase\("[a-z-]+"\);/.test(s) : /requireLoopbackDatabase\("[a-z-]+", \{ allowOptIn: false \}\);/.test(s)); }));
const child = spawnSync(process.execPath, [path.join(BACKEND, "scripts", "create-dev-workspace.mjs")], { cwd: BACKEND, encoding: "utf8", timeout: 30000, env: (() => { const e = { ...process.env, MONGODB_URI: REMOTE }; for (const k of ["KOI_NO_DOTENV", "KOI_NO_DOTENV_REASON", "KOI_REQUIRE_LOOPBACK_DB", "KOI_ALLOW_REMOTE_DB", "NODE_ENV"]) delete e[k]; return e; })() });
check("D2 REALLY running create-dev-workspace (normal environment, no markers) against a remote URI refuses before any connection: non-zero exit, the refusal message, nothing printed that names the host or credentials", child.status !== 0 && /Refusing to open a MongoDB connection/.test(`${child.stdout}${child.stderr}`) && !/guard-test|guard-user|guard-pass/.test(`${child.stdout}${child.stderr}`), `${child.status} ${(child.stderr || "").slice(0, 120)}`);
check("D3 the offline retrieval evaluation has NO opt-in: it declares { allowOptIn: false } (guard level 'strict'), so neither --allow-remote-db nor KOI_ALLOW_REMOTE_DB lifts the refusal (proved in S4)", /allowOptIn: false/.test(read(path.join(BACKEND, "evaluation", "retrieval", "run-evaluation.mjs"))));

// ============================================================================================================ I
console.log("\n# I. the intentionally remote Phase 41 Atlas tools");
const atlasTools = fs.readdirSync(path.join(BACKEND, "scripts", "phase41")).filter((f) => /^atlas-.*\.mjs$/.test(f));
check("I1 none of the scripts/phase41 Atlas tools imports the guard or calls requireLoopbackDatabase: their explicit Atlas behaviour is unchanged (they read backend/.env on purpose)", atlasTools.length >= 3 && atlasTools.every((f) => { const s = read(path.join(BACKEND, "scripts", "phase41", f)); return !/mongoSafety|requireLoopbackDatabase/.test(s); }));
check("I2 ... and the entry-name rule leaves them unmarked (a Phase 41 tool is never a 'validation process')", (() => { const keep = { ...process.env }; delete process.env.KOI_NO_DOTENV; delete process.env.KOI_NO_DOTENV_REASON; const r = markValidationProcess("/x/backend/scripts/phase41/atlas-synthetic-test.mjs"); Object.assign(process.env, keep); return r === false; })());
restoreEnv();

// ============================================================================================================ W
console.log("\n# W. warnings and hygiene");
check("W1 a real server with KOI_NO_DOTENV set but NOT as a validation run gets a startup warning (and the warning names no value); a validation run does not", runtimeWarnings({ KOI_NO_DOTENV: "1" }).some((w) => /KOI_NO_DOTENV is set but this is not a validation run/.test(w)) && !runtimeWarnings({ KOI_NO_DOTENV: "1", KOI_NO_DOTENV_REASON: "validation" }).some((w) => /KOI_NO_DOTENV/.test(w)) && !runtimeWarnings({}).some((w) => /KOI_NO_DOTENV/.test(w)));
const envFiles = ["backend", "ai-service", "frontend"].flatMap((d) => fs.readdirSync(path.join(REPO, d)).filter((f) => /^\.env/.test(f)).map((f) => `${d}/${f}`)).sort();
check("W2 no additional .env file exists: backend, ai-service and frontend each hold exactly .env (if present) and .env.example", envFiles.every((f) => /\/\.env(\.example)?$/.test(f)), envFiles.join(","));
check("W3 no secret-shaped value is in the guard, its tests or the messages (no URI with credentials other than the fake .invalid fixtures in this suite)", !/mongodb(\+srv)?:\/\/[^\s"'`/@]+:[^\s"'`/@]+@(?!guard-test)/.test(read(path.join(BACKEND, "src", "config", "mongoSafety.js"))));

console.log(`\nDatabase-safety validation: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
