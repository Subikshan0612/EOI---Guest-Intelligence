// Phase 43A - read-only counts of the normal local `koi` database (no data printed) and the list of koi_p* leftovers.
import "../../src/config/mongoSafety.js"; // validation / rehearsal tool: loopback databases only
import dotenv from "dotenv";
import mongoose from "mongoose";
{ const __u = dotenv.parse(process.getBuiltinModule("node:fs").readFileSync(new URL("../../.env", import.meta.url))).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; } // validation / rehearsal tools take ONLY a loopback database URI from backend/.env, never its real settings
await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const c = async (n) => db.collection(n).countDocuments({});
console.log("db:", db.databaseName);
for (const n of ["users", "workspacememberships", "workspaces", "knowledgedocuments", "knowledgechunks", "intelligences", "decisions", "actions", "outcomes", "analysisadmissions"]) console.log(n, await c(n));
const dbs = (await mongoose.connection.getClient().db().admin().listDatabases()).databases.map((d) => d.name).filter((n) => /^koi_p/.test(n));
console.log("leftover koi_p* databases:", dbs.length ? dbs.join(",") : "none");
await mongoose.disconnect();
