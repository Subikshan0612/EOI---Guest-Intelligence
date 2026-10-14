/**
 * Phase 41 - READ-ONLY MongoDB Atlas connectivity and state check. It never writes, never prints a credential, a URI or a host name.
 *
 *   node scripts/phase41/atlas-preflight.mjs [--env-file .env]
 *
 * The URI comes from an IGNORED env file (default backend/.env, the single runtime file) or, if --env-file is not given and that file is absent, from MONGODB_URI in the process
 * environment. It is parsed for SAFE metadata only (scheme, whether credentials / a database name / TLS are present). Driver error text is never printed: a
 * failure is mapped to one fixed category with the action the operator must take.
 *
 * Reports: URI shape, the application's production database rules, DNS (SRV record count), TLS, authentication, server version and topology, the roles of the
 * authenticated user, the databases on the cluster (names only), and for the application's database: collections, document counts and index names.
 * Exit 0 = connected and state read; 1 = could not connect; 2 = refused (bad configuration).
 */
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, "..", "..");
const args = process.argv.slice(2);
const fileArg = args.includes("--env-file") ? args[args.indexOf("--env-file") + 1] : path.join(BACKEND, ".env");
const uri = fs.existsSync(fileArg) ? dotenv.parse(fs.readFileSync(fileArg, "utf8")).MONGODB_URI : process.env.MONGODB_URI;
const say = (k, v) => console.log(`${k.padEnd(44)} ${v}`);
if (!uri) { console.error("No MONGODB_URI found (ignored env file or process environment)."); process.exit(2); }

const m = /^(mongodb(?:\+srv)?):\/\/(?:([^@/]*)@)?([^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/.exec(uri.trim());
if (!m) { console.error("MONGODB_URI is not a valid MongoDB connection string."); process.exit(2); }
const [, scheme, userinfo, hosts, dbName, query] = m;
const host = hosts.split(",")[0];
say("URI scheme", scheme);
say("credentials present", userinfo ? "yes (values withheld)" : "NO");
say("database name present", dbName ? "yes" : "NO");
say("TLS implied by scheme / option", scheme.endsWith("srv") || /(^|&)(tls|ssl)=true(&|$)/i.test(query ?? "") ? "yes" : "NO");
say("host is an Atlas host (*.mongodb.net)", /\.mongodb\.net$/i.test(host) ? "yes (name withheld)" : "no");

process.env.NODE_ENV = "production"; // judge it by the application's own PRODUCTION database rules (nothing is started)
const { mongoConfigProblems } = await import("../../src/config/startupChecks.js");
const rules = mongoConfigProblems(uri);
say("application production database rules", rules.fatal.length ? `FAIL: ${rules.fatal.join("; ")}` : rules.warnings.length ? `PASS with warnings: ${rules.warnings.join("; ")}` : "PASS");
if (rules.fatal.length) process.exit(2);

if (scheme.endsWith("srv")) {
  try { const srv = await dns.resolveSrv(`_mongodb._tcp.${host}`); say("DNS SRV resolution", `PASS (${srv.length} seed hosts)`); }
  catch { say("DNS SRV resolution", "FAIL (the cluster host name did not resolve: check the host in the connection string)"); process.exit(1); }
}

const { MongoClient } = await import("mongodb");
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000, connectTimeoutMS: 10000, appName: "koi-phase41-readonly-check" });
const category = (e) => {
  const n = `${e?.name ?? ""} ${e?.codeName ?? ""} ${e?.code ?? ""} ${e?.errorLabelSet ? "" : ""}`;
  if (/AuthenticationFailed|^18$| 18 |bad auth/i.test(`${n} ${e?.message ?? ""}`)) return "AUTHENTICATION FAILED: the database user name or password is wrong, or the user has no access to this cluster/database (check the Atlas Database Access page)";
  if (/MongoServerSelectionError|MongoNetworkTimeoutError|ETIMEDOUT|ECONNREFUSED/i.test(n + " " + (e?.message ?? "")) ) return "CANNOT REACH THE CLUSTER: most likely this machine's public IP is not in the Atlas Network Access list (add this IP temporarily; do NOT open 0.0.0.0/0), or the cluster is paused";
  if (/SSL|TLS|certificate/i.test(`${n} ${e?.message ?? ""}`)) return "TLS FAILURE: a TLS inspection proxy or an outdated trust store is interfering";
  return `CONNECTION FAILED (${e?.name ?? "error"}${e?.code ? ` ${e.code}` : ""})`;
};
try {
  await client.connect();
  say("connection", "PASS");
  say("TLS", client.options?.tls ? "PASS (TLS in use)" : "NOT IN USE");
  const admin = client.db("admin");
  const hello = await admin.command({ hello: 1 });
  const build = await admin.command({ buildInfo: 1 });
  say("authentication", "PASS (the authenticated command ran)");
  say("server version", build.version);
  say("topology", hello.setName ? "replica set (Atlas)" : "standalone");
  const status = await admin.command({ connectionStatus: 1, showPrivileges: false });
  const roles = (status.authInfo?.authenticatedUserRoles ?? []).map((r) => `${r.role}@${r.db}`);
  say("authenticated user roles", roles.length ? roles.join(", ") : "none reported");
  const broad = roles.some((r) => /^(atlasAdmin|dbAdminAnyDatabase|readWriteAnyDatabase|root|clusterAdmin)@/.test(r));
  say("least privilege (not a cluster-wide role)", broad ? "NO - the user holds a broad role; restrict it to readWrite on the application database only" : "yes");
  let names = []; try { names = (await admin.command({ listDatabases: 1, nameOnly: true })).databases.map((d) => d.name); } catch { /* not permitted */ }
  say("databases visible to this user", names.length ? names.join(", ") : "(listing not permitted for this role)");
  const db = client.db(dbName);
  const collections = await db.listCollections({}, { nameOnly: true }).toArray();
  say(`application database "${dbName}" exists`, names.includes(dbName) || collections.length ? "yes" : "no (it will be created on first write)");
  say("collections in the application database", String(collections.length));
  let totalDocs = 0;
  for (const c of collections.sort((a, b) => a.name.localeCompare(b.name))) {
    const n = await db.collection(c.name).estimatedDocumentCount();
    const idx = (await db.collection(c.name).indexes()).map((i) => i.name);
    totalDocs += n;
    console.log(`  - ${c.name}: ${n} documents; indexes: ${idx.join(", ")}`);
  }
  say("application database state", collections.length === 0 ? "EMPTY (no collections)" : totalDocs === 0 ? "COLLECTIONS EXIST BUT HOLD NO DOCUMENTS" : `CONTAINS DATA (${totalDocs} documents)`);
  await client.close();
  process.exit(0);
} catch (e) {
  say("connection", `FAIL - ${category(e)}`);
  try { await client.close(); } catch { /* ignore */ }
  process.exit(1);
}
