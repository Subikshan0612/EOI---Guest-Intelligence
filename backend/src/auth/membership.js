import { User } from "../models/User.js";
import { Workspace } from "../models/Workspace.js";
import { WorkspaceMembership } from "../models/WorkspaceMembership.js";
import { AppError } from "../utils/AppError.js";
import { requireObjectId } from "../utils/objectId.js";
import { isValidRole } from "./roles.js";

/**
 * The reusable mechanism future phases use to turn an authenticated actor into
 * a WORKSPACE-SCOPED actor:
 *
 *   authenticated actor -> active workspace membership -> role -> actor
 *
 * The workspaceId a request names is only a SELECTION: it is validated against
 * the actor's ACTIVE membership and never confers authority by itself. Authority
 * is the membership row plus the server-side role map (roles.js).
 *
 * Not a member (no membership, a revoked one, an unknown or non-active
 * workspace) -> the same 404 as a workspace that does not exist, so a caller
 * cannot probe which workspaces exist. A membership whose stored role is not a
 * known role fails closed with 403. The user is re-checked as active here too,
 * so disabling a user takes effect even inside a long-lived actor.
 *
 * This phase does not call it from any existing route.
 */

export async function resolveWorkspaceActor(actor, workspaceId) {
  if (!actor || !actor.userId) throw new AppError("Authentication is required", 401, { code: "MISSING_CREDENTIAL" });
  const scope = requireObjectId(workspaceId, "workspaceId");

  const notFound = () => new AppError("Workspace not found", 404);
  const [user, workspace, membership] = await Promise.all([
    User.findById(actor.userId, { status: 1 }).lean(),
    Workspace.findById(scope, { status: 1 }).lean(),
    WorkspaceMembership.findOne({ userId: actor.userId, workspaceId: scope }).lean(),
  ]);

  if (!user || user.status !== "active") throw new AppError("This user is disabled", 403, { code: "USER_DISABLED" });
  if (!workspace || workspace.status !== "active" || !membership || membership.status !== "active") throw notFound();
  if (!isValidRole(membership.role)) throw new AppError("The membership role is not valid", 403, { code: "INVALID_ROLE" });

  return Object.freeze({ ...actor, workspaceId: String(scope), role: membership.role });
}

/**
 * Express middleware factory. `getWorkspaceId(req)` says where the (untrusted)
 * workspace selection lives; the default is the existing `?workspaceId=` query
 * convention. Must run after `authenticate`.
 */
export function requireWorkspaceMembership(getWorkspaceId = (req) => req.query?.workspaceId) {
  return async function workspaceMembership(req, _res, next) {
    try {
      req.actor = await resolveWorkspaceActor(req.actor, getWorkspaceId(req));
      next();
    } catch (error) {
      next(error);
    }
  };
}
