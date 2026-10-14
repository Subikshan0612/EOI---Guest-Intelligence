import mongoose from "mongoose";
import { Action } from "../models/Action.js";
import { AnalysisAdmission } from "../models/AnalysisAdmission.js";
import { AnalysisAttempt } from "../models/AnalysisAttempt.js";
import { Conversation } from "../models/Conversation.js";
import { Decision } from "../models/Decision.js";
import { Guest } from "../models/Guest.js";
import { ImportBatch } from "../models/ImportBatch.js";
import { Intelligence } from "../models/Intelligence.js";
import { KnowledgeChunk } from "../models/KnowledgeChunk.js";
import { KnowledgeDocument } from "../models/KnowledgeDocument.js";
import { Message } from "../models/Message.js";
import { Outcome } from "../models/Outcome.js";
import { Property } from "../models/Property.js";
import { Signal } from "../models/Signal.js";
import { Stay } from "../models/Stay.js";
import { Unit } from "../models/Unit.js";
import { User } from "../models/User.js";
import { Workspace } from "../models/Workspace.js";
import { WorkspaceMembership } from "../models/WorkspaceMembership.js";
import { AppError } from "../utils/AppError.js";
import { requireObjectId } from "../utils/objectId.js";
import { toPlain } from "./queryHelpers.js";

/**
 * WORKSPACE LIFECYCLE (Phase 22). The policy is in docs/WORKSPACE_LIFECYCLE_POLICY_PHASE22.md.
 *
 * DEPENDENCY GRAPH - every record the application can create that belongs to a Workspace, LEAF FIRST (deletion order):
 *
 *   Message            conversationId -> Conversation        (no workspaceId of its own)
 *   Conversation       workspaceId
 *   Outcome            workspaceId
 *   Action             workspaceId
 *   Decision           workspaceId
 *   AnalysisAttempt    workspaceId          (Workstream 5A: metadata-only lifecycle marker of one analysis attempt)
 *   AnalysisAdmission  workspaceId          (Phase 35: metadata-only audit of analysis admission decisions)
 *   Intelligence       workspaceId          (derived AI artifact: analysis, provenance)
 *   KnowledgeChunk     workspaceId          (embedding vectors included)
 *   KnowledgeDocument  workspaceId
 *   ImportBatch        workspaceId
 *   Signal             workspaceId
 *   Stay               workspaceId          (reservation data)
 *   Guest              workspaceId          (PII)
 *   Unit               propertyId -> Property                (no workspaceId of its own)
 *   Property           workspaceId
 *   WorkspaceMembership workspaceId         (the workspace's own membership rows)
 *   Workspace          _id                  (the root, LAST)
 *
 * NEVER deleted: `User` (a global identity that can belong to many workspaces; it is not workspace-owned) and anything not
 * reachable through the graph above (in particular the Messages that are ALREADY orphaned: their Conversation is gone, so no
 * workspace can be attributed to them; they are deliberately left untouched). There is no shared/global knowledge and no
 * learning/pattern collection (Learning is computed on demand from Decision/Action/Outcome).
 */
export const WORKSPACE_DELETION_ORDER = Object.freeze([
  "Message", "Conversation", "Outcome", "Action", "Decision", "AnalysisAttempt", "AnalysisAdmission", "Intelligence", "KnowledgeChunk", "KnowledgeDocument",
  "ImportBatch", "Signal", "Stay", "Guest", "Unit", "Property", "WorkspaceMembership", "Workspace",
]);

/** Models that carry a `workspaceId` (or are reached through one) and therefore MUST appear in the deletion order. */
export const MODELS_NEVER_DELETED_WITH_A_WORKSPACE = Object.freeze(["User"]);

const CHUNK = 500;
const chunked = (ids) => Array.from({ length: Math.ceil(ids.length / CHUNK) }, (_, i) => ids.slice(i * CHUNK, (i + 1) * CHUNK));

/** True when the connected MongoDB supports multi-document transactions (a replica set or sharded cluster). */
export function supportsTransactions() {
  const type = mongoose.connection.getClient?.()?.topology?.description?.type;
  return type === "ReplicaSetWithPrimary" || type === "Sharded";
}

/** How many records of each kind belong to the workspace (a dry run; nothing is changed). */
export async function countWorkspaceData(workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const conversationIds = await Conversation.find({ workspaceId: scope }).distinct("_id");
  const propertyIds = await Property.find({ workspaceId: scope }).distinct("_id");
  return {
    Message: await Message.countDocuments({ conversationId: { $in: conversationIds } }),
    Conversation: conversationIds.length,
    Outcome: await Outcome.countDocuments({ workspaceId: scope }),
    Action: await Action.countDocuments({ workspaceId: scope }),
    Decision: await Decision.countDocuments({ workspaceId: scope }),
    AnalysisAttempt: await AnalysisAttempt.countDocuments({ workspaceId: scope }),
    AnalysisAdmission: await AnalysisAdmission.countDocuments({ workspaceId: scope }),
    Intelligence: await Intelligence.countDocuments({ workspaceId: scope }),
    KnowledgeChunk: await KnowledgeChunk.countDocuments({ workspaceId: scope }),
    KnowledgeDocument: await KnowledgeDocument.countDocuments({ workspaceId: scope }),
    ImportBatch: await ImportBatch.countDocuments({ workspaceId: scope }),
    Signal: await Signal.countDocuments({ workspaceId: scope }),
    Stay: await Stay.countDocuments({ workspaceId: scope }),
    Guest: await Guest.countDocuments({ workspaceId: scope }),
    Unit: await Unit.countDocuments({ propertyId: { $in: propertyIds } }),
    Property: propertyIds.length,
    WorkspaceMembership: await WorkspaceMembership.countDocuments({ workspaceId: scope }),
  };
}

/**
 * Deletes everything the workspace OWNS, leaf first, then its memberships. Every statement is scoped by this workspace's own
 * ids (Messages through THIS workspace's Conversations, Units through THIS workspace's Properties), so nothing of another
 * workspace and no pre-existing orphan can be touched. Every statement is a `deleteMany`: running it twice deletes nothing the
 * second time, so a retry after an interruption is safe and never duplicates an effect. The Workspace document itself is NOT
 * deleted here.
 */
async function purgeOwnedData(scope, options = {}) {
  const deleted = {};
  const conversationIds = await Conversation.find({ workspaceId: scope }, null, options).distinct("_id");
  let messages = 0;
  for (const ids of chunked(conversationIds)) messages += (await Message.deleteMany({ conversationId: { $in: ids } }, options)).deletedCount;
  deleted.Message = messages;
  const byWorkspace = [["Conversation", Conversation], ["Outcome", Outcome], ["Action", Action], ["Decision", Decision], ["AnalysisAttempt", AnalysisAttempt], ["AnalysisAdmission", AnalysisAdmission], ["Intelligence", Intelligence], ["KnowledgeChunk", KnowledgeChunk], ["KnowledgeDocument", KnowledgeDocument], ["ImportBatch", ImportBatch], ["Signal", Signal], ["Stay", Stay], ["Guest", Guest]];
  for (const [name, Model] of byWorkspace) deleted[name] = (await Model.deleteMany({ workspaceId: scope }, options)).deletedCount;
  const propertyIds = await Property.find({ workspaceId: scope }, null, options).distinct("_id");
  let units = 0;
  for (const ids of chunked(propertyIds)) units += (await Unit.deleteMany({ propertyId: { $in: ids } }, options)).deletedCount;
  deleted.Unit = units;
  deleted.Property = (await Property.deleteMany({ workspaceId: scope }, options)).deletedCount;
  deleted.WorkspaceMembership = (await WorkspaceMembership.deleteMany({ workspaceId: scope }, options)).deletedCount;
  return deleted;
}

/**
 * Permanently deletes a workspace and everything it owns. HARD DELETE; there is no soft-delete state and no undo.
 *
 *   1. QUIESCE  the workspace is set to `inactive` (guarded: only from `active`). Every member's next request resolves to the
 *               same 404 as a missing workspace, so nothing can be created or read while data is being removed.
 *   2. PURGE    owned data, leaf first, then the workspace's memberships (see `purgeOwnedData`).
 *   3. REMOVE   the Workspace document, LAST.
 *   With a replica set steps 2-3 run in ONE transaction. On a standalone MongoDB (no transactions) the steps run in order; if
 *   the process is interrupted, the workspace remains `inactive` (unreachable to members) with partial data, and the operator
 *   resumes with `scripts/workspace-lifecycle.mjs delete` - every step is idempotent, so the retry only finishes the job.
 *
 * `confirm` must equal the workspace slug exactly (a hard-delete guard). Returns the deleted workspace's last state.
 */
export async function deleteWorkspaceCascade(id, { confirm, resume = false } = {}) {
  const scope = requireObjectId(id, "workspaceId");
  const workspace = await Workspace.findById(scope);
  if (!workspace) throw new AppError("Workspace not found", 404);
  if (typeof confirm !== "string" || confirm !== workspace.slug) {
    throw new AppError("To delete a workspace, send { \"confirm\": \"<the workspace slug>\" }", 400, { code: "WORKSPACE_DELETE_CONFIRMATION_REQUIRED" });
  }
  if (!resume && workspace.status !== "active") throw new AppError("Workspace not found", 404);

  // 1. quiesce (idempotent; a resume of an already-quiesced workspace is a no-op)
  await Workspace.updateOne({ _id: scope, status: "active" }, { $set: { status: "inactive" } });

  // 2 + 3. purge and remove
  let deleted;
  if (supportsTransactions()) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        deleted = await purgeOwnedData(scope, { session });
        await Workspace.deleteOne({ _id: scope }, { session });
      });
    } finally {
      await session.endSession();
    }
  } else {
    deleted = await purgeOwnedData(scope);
    await Workspace.deleteOne({ _id: scope });
  }
  console.info(`[KOI API] Workspace ${scope} deleted: ${JSON.stringify(deleted)}`);
  return { workspace: toPlain(workspace), deleted };
}

/**
 * LAST-ADMIN INVARIANT helper. A workspace must keep at least one ACTIVE administrator: an `admin` membership with status
 * `active` whose User is `active`. Any future operation that revokes a membership, changes a role, or disables a user calls
 * this BEFORE committing (`excludingMembershipId` = the membership being removed/demoted). No such route exists today
 * (memberships are provisioned out of band), so nothing calls it yet; it is unit-tested so the rule is ready and exact.
 * Not atomic on a standalone MongoDB (two concurrent removals could each see the other admin); a transactional caller or a
 * replica set closes that window.
 */
export async function countActiveAdmins(workspaceId, { excludingMembershipId } = {}) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const filter = { workspaceId: scope, role: "admin", status: "active" };
  if (excludingMembershipId) filter._id = { $ne: requireObjectId(excludingMembershipId, "membershipId") };
  const memberships = await WorkspaceMembership.find(filter, { userId: 1 }).lean();
  if (memberships.length === 0) return 0;
  return User.countDocuments({ _id: { $in: memberships.map((m) => m.userId) }, status: "active" });
}

export async function assertWorkspaceKeepsAdmin(workspaceId, options = {}) {
  if ((await countActiveAdmins(workspaceId, options)) < 1) {
    throw new AppError("A workspace must keep at least one active administrator", 409, { code: "LAST_ADMIN_REQUIRED" });
  }
}
