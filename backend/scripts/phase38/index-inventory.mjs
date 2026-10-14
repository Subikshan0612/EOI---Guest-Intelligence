/**
 * Phase 38 - MongoDB index inventory, DERIVED from the real models on a FRESH, ISOLATED database (never the development or a production one).
 *
 *   node scripts/phase38/index-inventory.mjs            # prints the markdown table used by docs/PRODUCTION_ENVIRONMENT_CONTRACT.md
 *
 * For every model it builds the indexes Mongoose declares (exactly what a first start against an empty database does), reads them back from
 * MongoDB, and classifies each by tenant scoping. Nothing is created in, or deleted from, any database except the throwaway one it makes
 * (koi_p38_idx_<ts>), which is dropped at the end (after every model finished initialising, then re-checked: Mongoose builds indexes in the
 * background and can re-create empty collections just after a drop).
 */
import "../../src/config/mongoSafety.js"; // validation / rehearsal tool: loopback databases only
import dotenv from "dotenv";
import mongoose from "mongoose";
import { fileURLToPath } from "node:url";

// Purpose of every UNIQUE / partial index, keyed "Model|keys". Everything else is classified by its shape (see purposeOf).
const UNIQUE_PURPOSE = {
  "Workspace|slug": "one workspace per slug (stable, human-facing identifier)",
  "Property|workspaceId,code": "one property per code within a workspace",
  "Unit|propertyId,unitNumber": "one unit number per property",
  "Guest|workspaceId,externalId": "one guest per external (PMS) id within a workspace (partial: only when an external id exists)",
  "Stay|workspaceId,reservationId": "one stay per reservation id within a workspace (partial)",
  "Intelligence|workspaceId,signalIds,analysisLevel": "IDEMPOTENCY of analysis: at most one V1 analysis per workspace + Signal + level (partial: V1 only) - the multi-instance correctness backstop",
  "Decision|workspaceId,intelligenceId,decisionVersion": "at most one Decision V1 per workspace + Intelligence (partial: V1 only)",
  "Action|workspaceId,decisionId,actionVersion": "at most one Action V1 per workspace + Decision (partial: V1 only)",
  "Outcome|workspaceId,actionId,outcomeVersion": "at most one Outcome V1 per workspace + Action (partial: V1 only)",
  "KnowledgeDocument|workspaceId,propertyId,unitId,contentHash": "no duplicate knowledge document content within a scope (partial)",
  "KnowledgeChunk|documentId,version,chunkIndex": "one chunk per document version + position",
  "User|issuer,subject": "one User per identity-provider issuer + subject (an identity is never matched by e-mail)",
  "WorkspaceMembership|userId,workspaceId": "one membership per user + workspace",
  "User|emailNormalized": "one PASSWORD account per normalised email address (partial: only users that have a password hash); a provider-created user does not occupy the address",
  "AuthIdentity|issuer,subject": "one EOI link per external-provider identity (a Google account belongs to at most one EOI user)",
  "AuthToken|tokenHash": "single-use email tokens (verification, reset) are looked up by the SHA-256 of the token; the token itself is never stored",
  "AnalysisAdmission|workspaceId,attemptId": "one audit row per analysis attempt within a workspace",
  "AnalysisAttempt|workspaceId,signalId,analysisLevel": "at most ONE in-flight analysis attempt per workspace + Signal + level (partial: status in_progress) - the cross-process single-flight",
  "AnalysisAttempt|workspaceId,attemptId": "one attempt marker per attempt id within a workspace",
};
const PARENT_SCOPED = { Unit: "propertyId", Message: "conversationId" }; // no workspaceId of their own by design (CLAUDE.md): scope resolves through the parent
const IDENTITY_MODELS = new Set(["User", "Workspace", "AuthIdentity", "AuthSession", "AuthToken"]); // global identity / the tenant root itself

const keysOf = (index) => Object.keys(index.key);
function scopingOf(model, index) {
  const keys = keysOf(index);
  if (keys.length === 1 && keys[0] === "_id") return "primary key";
  if (IDENTITY_MODELS.has(model)) return model === "Workspace" ? "tenant root" : "global identity / authentication (never tenant data)";
  if (keys[0] === "workspaceId") return "workspace-prefixed";
  if (PARENT_SCOPED[model] && keys[0] === PARENT_SCOPED[model]) return `parent-scoped (${PARENT_SCOPED[model]} -> its workspace)`;
  return "secondary key (the service layer always adds the workspace filter)";
}
function purposeOf(model, index) {
  const keys = keysOf(index);
  const sig = `${model}|${keys.join(",")}`;
  if (keys.length === 1 && keys[0] === "_id") return "primary key";
  if (UNIQUE_PURPOSE[sig]) return UNIQUE_PURPOSE[sig];
  if (index.unique) return null; // an unexplained unique index is a defect of the inventory
  if (index.expireAfterSeconds !== undefined) return "automatic removal of expired authentication records (TTL index)";
  if (model === "AnalysisAdmission" && keys.includes("requestId")) return "find the audit row from the X-Request-Id a client reported (partial: rows that have one)";
  if (model === "AnalysisAdmission") return "audit listing by workspace (newest first) / by Signal";
  if (keys[0] === "workspaceId") return "workspace-scoped list / filter / sort";
  if (keys.length === 1 && /Id$/.test(keys[0])) return `lookup by reference (${keys[0]})`;
  if (keys[0] === "conversationId") return "messages of a conversation, oldest first";
  if (keys.length === 1) return `filter by ${keys[0]}`;
  return null;
}

export async function buildIndexInventory() {
  { const __u = dotenv.parse(process.getBuiltinModule("node:fs").readFileSync(new URL("../../.env", import.meta.url))).MONGODB_URI ?? ""; if (/^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1)/i.test(__u)) process.env.MONGODB_URI ??= __u; } // validation / rehearsal tools take ONLY a loopback database URI from backend/.env, never its real settings
  const base = process.env.MONGODB_URI;
  if (!base) throw new Error("MONGODB_URI is not configured.");
  const name = `koi_p38_idx_${Date.now()}`;
  const uri = base.replace(/(mongodb(?:\+srv)?:\/\/[^/]+\/)([^?]*)/, `$1${name}`);
  if (uri === base || !/koi_p38_idx_\d+/.test(uri)) throw new Error("Could not derive an isolated database URI.");
  await import("../../src/models/index.js"); // registers every model (does not connect)
  const conn = await mongoose.createConnection(uri).asPromise();
  const rows = [];
  try {
    for (const [modelName, model] of Object.entries(mongoose.models)) {
      const m = conn.model(modelName, model.schema);
      await m.init();
      const hasWorkspaceId = Boolean(model.schema.path("workspaceId"));
      for (const index of await m.collection.indexes()) {
        rows.push({
          model: modelName, collection: m.collection.collectionName, keys: Object.entries(index.key).map(([k, v]) => `${k}:${v}`).join(", "),
          unique: Boolean(index.unique), partial: Boolean(index.partialFilterExpression), ttl: index.expireAfterSeconds !== undefined,
          purpose: purposeOf(modelName, index), tenantScoping: scopingOf(modelName, index), carriesWorkspaceId: hasWorkspaceId,
          deploymentStatus: "created by the application on first start (Mongoose autoIndex); no manual migration",
        });
      }
    }
  } finally {
    if (conn.name === name) {
      await Promise.allSettled(Object.values(mongoose.models).map((model) => conn.model(model.modelName).init()));
      await conn.dropDatabase();
      await new Promise((r) => setTimeout(r, 300));
      if ((await conn.db.listCollections().toArray()).length > 0) await conn.dropDatabase();
    }
    await conn.close();
  }
  return { rows, unclassified: rows.filter((r) => r.purpose === null) };
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const { rows, unclassified } = await buildIndexInventory();
  console.log("| Model | Index (keys) | Unique / partial | Purpose | Tenant scoping | Deployment status |\n|---|---|---|---|---|---|");
  for (const r of rows.filter((x) => x.keys !== "_id:1")) console.log(`| ${r.model} | \`${r.keys}\` | ${[r.unique ? "unique" : "", r.partial ? "partial" : ""].filter(Boolean).join(" + ") || "-"} | ${r.purpose ?? "UNCLASSIFIED"} | ${r.tenantScoping} | on first start |`);
  console.log(`\n${rows.length} indexes (${rows.filter((r) => r.keys === "_id:1").length} primary keys), unclassified: ${unclassified.length}`);
  process.exit(unclassified.length === 0 ? 0 : 1);
}
