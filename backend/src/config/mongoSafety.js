import mongoose from "mongoose";
import { getRuntimeMode } from "./runtimeMode.js";

/**
 * ONE central database-safety guard (no value is ever logged or returned).
 *
 * backend/.env now holds the real (Atlas) MongoDB URI, so anything that is NOT the real application must be unable to reach a remote database by accident:
 *
 *   HARD  - a validation suite or rehearsal tool (scripts/validate-*.mjs, scripts/phaseNN/*; marked below) and every process it spawns, and any process with
 *           NODE_ENV=test: every host of the URI must be localhost, 127.0.0.1 or ::1. Nothing overrides this - not an exported MONGODB_URI, not a flag.
 *   SOFT  - a development / seed / provision script that calls requireLoopbackDatabase(): the same rule, unless the operator passes --allow-remote-db (or sets
 *           KOI_ALLOW_REMOTE_DB=1) to run it against a remote database ON PURPOSE. A script that calls it with { allowOptIn: false } (offline evaluation) has no opt-in.
 *   The real server (server.js), npm run dev / start, and the intentionally remote Phase 41 Atlas tools are NOT governed: this module is inactive for them.
 *
 * The check runs at the lowest level every connection passes through, so no connection API bypasses it: mongoose.connect() and mongoose.createConnection()
 * (both call Connection.openUri), and a MongoClient used directly (MongoClient.prototype.connect, which also covers MongoClient.connect()). It fails closed:
 * an unparseable URI, an SRV (DNS-resolved) URI, a unix-socket host, or any single non-loopback host in a multi-host list is refused BEFORE a socket is opened.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** The hosts named by a MongoDB connection string, lower-cased and without ports; null when the string cannot be parsed. Pure. */
export function mongoUriHosts(uri) {
  if (typeof uri !== "string") return null;
  const match = /^(mongodb(?:\+srv)?):\/\/([^/?#]*)/i.exec(uri.trim());
  if (!match) return null;
  const authority = match[2];
  const hostPart = authority.slice(authority.lastIndexOf("@") + 1); // userinfo may contain anything but a raw "@"; the hosts follow the LAST "@"
  if (hostPart === "") return null;
  const hosts = hostPart.split(",").map((entry) => {
    const h = entry.trim().toLowerCase();
    if (h.startsWith("[")) return h.slice(1, h.indexOf("]") === -1 ? undefined : h.indexOf("]")); // [::1]:27017
    return h.includes(":") && h.split(":").length === 2 ? h.split(":")[0] : h; // host:port
  });
  return hosts.some((h) => h === "") ? null : hosts;
}

/** True only for a plain `mongodb://` URI whose EVERY host is localhost, 127.0.0.1 or ::1. SRV URIs (DNS-resolved) are never loopback. Pure. */
export function isLoopbackMongoUri(uri) {
  if (typeof uri !== "string" || /^mongodb\+srv:/i.test(uri.trim())) return false;
  const hosts = mongoUriHosts(uri);
  return Array.isArray(hosts) && hosts.length > 0 && hosts.every((h) => LOOPBACK_HOSTS.has(h));
}

/** Marks a validation / rehearsal process (and, through inheritance, the servers and tools it spawns). The Phase 41 Atlas tools are deliberately excluded. */
const VALIDATION_ENTRY = /[\\/](validate-[^\\/]+\.mjs|phase(?!41)\d+[a-z0-9]*[\\/][^\\/]+\.mjs)$/i;
export function markValidationProcess(entry = process.argv[1] ?? "") {
  if (!VALIDATION_ENTRY.test(entry)) return false;
  process.env.KOI_NO_DOTENV = "1"; // backend/.env is never read by such a process (src/config/env.js)
  process.env.KOI_NO_DOTENV_REASON = "validation"; // lets the real server tell a legitimate use of KOI_NO_DOTENV from a stray one
  return true;
}
markValidationProcess();

/** Why this process must stay on a loopback database right now, or null when it is not restricted. Evaluated at connect time (NODE_ENV may be set after import). */
function loopbackRequirement() {
  if (process.env.KOI_NO_DOTENV === "1" && process.env.KOI_NO_DOTENV_REASON === "validation") return "this is a validation or rehearsal process";
  if (getRuntimeMode() === "test") return "NODE_ENV=test";
  const flag = process.env.KOI_REQUIRE_LOOPBACK_DB;
  if (flag === "strict") return "this script only ever runs against a local database";
  if (flag === "1") return "this development script defaults to a local database; pass --allow-remote-db to use a remote one on purpose";
  return null;
}

/** Throws (before any connection) when the current process must stay on loopback and `uri` is not. */
export function assertMongoUriAllowed(uri) {
  const reason = loopbackRequirement();
  if (reason === null) return;
  if (!isLoopbackMongoUri(uri)) {
    throw new Error(`Refusing to open a MongoDB connection: ${reason}, and the database URI is not loopback (every host must be localhost, 127.0.0.1 or ::1). Supply a local throwaway MONGODB_URI.`);
  }
}

/**
 * For development / seed / provision / evaluation scripts. Call it at the top of the script: from then on the process refuses any non-loopback database.
 * `--allow-remote-db` (removed from argv so the script's own argument parsing never sees it) or KOI_ALLOW_REMOTE_DB=1 lifts it for a deliberate remote run,
 * with a notice on stderr; `{ allowOptIn: false }` has no opt-in at all.
 */
export function requireLoopbackDatabase(scriptName, { allowOptIn = true } = {}) {
  const at = process.argv.indexOf("--allow-remote-db");
  if (at !== -1) process.argv.splice(at, 1);
  const optIn = allowOptIn && (at !== -1 || process.env.KOI_ALLOW_REMOTE_DB === "1");
  if (optIn) {
    process.env.KOI_REQUIRE_LOOPBACK_DB = "";
    console.error(`[${scriptName}] a REMOTE database is allowed for this run (--allow-remote-db); the host is not shown`);
    return;
  }
  process.env.KOI_REQUIRE_LOOPBACK_DB = allowOptIn ? "1" : "strict";
}

const PATCHED = Symbol.for("koi.mongoSafety.patched");
function install() {
  const Connection = mongoose.Connection;
  if (Connection && !Connection.prototype[PATCHED]) {
    const openUri = Connection.prototype.openUri;
    Connection.prototype.openUri = function guardedOpenUri(uri, ...rest) {
      assertMongoUriAllowed(uri);
      return openUri.call(this, uri, ...rest);
    };
    Connection.prototype[PATCHED] = true;
  }
  const Client = mongoose.mongo?.MongoClient;
  if (Client && !Client.prototype[PATCHED]) {
    const connect = Client.prototype.connect;
    Client.prototype.connect = function guardedClientConnect(...args) {
      const url = this?.s?.url;
      if (loopbackRequirement() !== null && typeof url !== "string") throw new Error("Refusing to open a MongoDB connection: the target cannot be verified as loopback.");
      assertMongoUriAllowed(url);
      return connect.apply(this, args);
    };
    Client.prototype[PATCHED] = true;
  }
}
install();
