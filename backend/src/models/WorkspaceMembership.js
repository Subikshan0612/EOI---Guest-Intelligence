import mongoose from "mongoose";
import { ROLES } from "../auth/roles.js";

const MEMBERSHIP_STATUSES = ["active", "revoked"];

/**
 * Which workspaces a user belongs to, and in what role. The workspace is the
 * authorization boundary: a user may belong to many workspaces (one row each),
 * and a workspace may have many members. Property-level membership is NOT
 * modelled.
 *
 * The role is one of ROLES; what it may do (permissions) and the knowledge level
 * it may read (ceiling) are derived from it server-side (auth/roles.js) and are
 * never stored here or taken from a request or a token.
 */
const workspaceMembershipSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    role: { type: String, enum: ROLES, required: true },
    status: { type: String, enum: MEMBERSHIP_STATUSES, default: "active" },
  },
  { timestamps: true },
);

workspaceMembershipSchema.index({ userId: 1, workspaceId: 1 }, { unique: true });

export const WorkspaceMembership = mongoose.model("WorkspaceMembership", workspaceMembershipSchema);
export { MEMBERSHIP_STATUSES };
