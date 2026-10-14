/**
 * Phase 41.1 - verify that the Atlas credential in an IGNORED env file is LEAST PRIVILEGE. READ-ONLY; prints no credential, URI or host.
 *
 *   node scripts/phase41/atlas-credential-verify.mjs [--env-file .env] [--database koi_staging]
 *
 * PASS requires ALL of:
 *   - the URI names the intended database;
 *   - the authenticated user holds exactly ONE role: readWrite on that database (no atlasAdmin, no *AnyDatabase role, no dbAdmin, no cluster role);
 *   - none of its privileges is cluster-wide or on another database;
 *   - reads of other databases (admin, local, another name) are DENIED by the server (the probes are read attempts that must fail);
 *   - the application database is readable.
 * It never writes. Exit 0 = least privilege confirmed; 1 = not least privilege or not connected.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const envFile = arg("--env-file", path.join(here, "..", "..", ".env"));
const DB = arg("--database", "koi_staging");
const uri = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile, "utf8")).MONGODB_URI : process.env.MONGODB_URI;
let failed = 0;
const line = (name, ok, note = "") => { if (!ok) failed += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? ` - ${note}` : ""}`); };
if (!uri) { console.error("No MONGODB_URI found."); process.exit(1); }
line("URI names the intended database", new RegExp(`^mongodb(\\+srv)?://[^/]+/${DB}(\\?|$)`).test(uri.trim()), `expected ${DB}`);
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000, appName: "koi-phase41-1-verify" });
try {
  await client.connect();
  line("connected over TLS with the credential", Boolean(client.options?.tls));
  const status = await client.db("admin").command({ connectionStatus: 1, showPrivileges: true });
  const roles = (status.authInfo?.authenticatedUserRoles ?? []).map((r) => `${r.role}@${r.db}`);
  line("exactly one role, readWrite on the application database", roles.length === 1 && roles[0] === `readWrite@${DB}`, `roles: ${roles.join(", ") || "none"}`);
  const resources = (status.authInfo?.authenticatedUserPrivileges ?? []).map((p) => p.resource);
  const outside = resources.filter((r) => r.cluster || (r.db !== undefined && r.db !== DB));
  line("no cluster-wide privilege and no privilege on any other database", resources.length > 0 && outside.length === 0, `${resources.length} privilege entries, ${outside.length} outside the application database`);
  const denied = async (label, fn) => { try { await fn(); line(`${label} is DENIED`, false, "the read SUCCEEDED"); } catch (e) { line(`${label} is DENIED`, /not authorized|not allowed to do action|unauthorized|Unauthorized|requires authentication|13/.test(`${e?.message} ${e?.code} ${e?.codeName}`), e?.codeName ?? "error"); } };
  await denied("reading the admin database", () => client.db("admin").listCollections().toArray());
  await denied("reading the local database", () => client.db("local").collection("startup_log").findOne({}));
  await denied("reading another application-like database", () => client.db(`${DB}_other`).listCollections().toArray());
  const visible = (await client.db("admin").command({ listDatabases: 1, nameOnly: true, authorizedDatabases: true })).databases.map((d) => d.name);
  line("the credential can see only the application database", visible.every((n) => n === DB), `visible: ${visible.join(", ") || "none"}`);
  const collections = await client.db(DB).listCollections({}, { nameOnly: true }).toArray();
  line("the application database is readable", Array.isArray(collections), `${collections.length} collections`);
} catch (e) {
  line("connect and verify", false, "could not connect with this credential (run atlas-preflight.mjs for the reason category)");
} finally { await client.close().catch(() => {}); }
console.log(`\nLeast-privilege verification: ${failed === 0 ? "PASS" : `FAIL (${failed} check(s))`}`);
process.exit(failed === 0 ? 0 : 1);
