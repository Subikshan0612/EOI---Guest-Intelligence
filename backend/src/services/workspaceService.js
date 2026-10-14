import { User } from "../models/User.js";
import { Workspace } from "../models/Workspace.js";
import { WorkspaceMembership } from "../models/WorkspaceMembership.js";
import { ROLES } from "../auth/roles.js";
import { AppError } from "../utils/AppError.js";
import { assertBoundedJson, requireBoundedString } from "../utils/boundedJson.js";
import { deleteWorkspaceCascade } from "./workspaceLifecycleService.js";
import { requireObjectId } from "../utils/objectId.js";
import { parsePagination, parseSort } from "../utils/pagination.js";
import {
  findByIdOr404,
  paginateQuery,
  pickDefined,
  requireFields,
  toPlain,
} from "./queryHelpers.js";

const UPDATABLE = ["name", "slug", "status", "settings"];

/**
 * RETIRED FROM HTTP (Phase 16): there is no POST /api/workspaces route. This function remains ONLY as
 * an in-process fixture/bootstrap factory (validation suites; scripts/create-dev-workspace.mjs creates
 * its workspace directly). Nothing in the application serves it.
 */
export async function createWorkspace(body) {
  requireFields(body, ["name", "slug"]);
  const workspace = await Workspace.create({
    name: body.name,
    slug: body.slug,
    status: body.status,
    settings: body.settings,
  });
  return toPlain(workspace);
}

/**
 * GET /api/workspaces: ONLY the ACTIVE workspaces in which the caller holds an ACTIVE membership with a
 * known role. Never an enumeration of workspaces; a `workspaceId`, role or permission in the query
 * cannot widen it. The caller must be an active user.
 */
export async function listWorkspacesForActor(actor, query) {
  const user = await User.findById(actor.userId, { status: 1 }).lean();
  if (!user || user.status !== "active") throw new AppError("This user is disabled", 403, { code: "USER_DISABLED" });
  const workspaceIds = await WorkspaceMembership.find({ userId: actor.userId, status: "active", role: { $in: ROLES } }).distinct("workspaceId");
  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt", "updatedAt", "name"], { createdAt: -1 });
  const filter = { _id: { $in: workspaceIds }, status: "active" };
  if (query.slug) filter.slug = String(query.slug).toLowerCase();
  return paginateQuery(Workspace, filter, pagination, sort);
}

export async function listWorkspaces(query) {
  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt", "updatedAt", "name"], { createdAt: -1 });
  const filter = {};

  if (query.status) filter.status = query.status;
  if (query.slug) filter.slug = String(query.slug).toLowerCase();

  return paginateQuery(Workspace, filter, pagination, sort);
}

export async function getWorkspaceById(id) {
  const workspace = await findByIdOr404(Workspace, requireObjectId(id), "Workspace");
  return toPlain(workspace);
}

// Field bounds for the fields a workspace administrator may change (settings was free-form and unbounded).
const SETTINGS_LIMITS = Object.freeze({ maxBytes: 8192, maxDepth: 4, maxKeys: 50, maxArray: 50, maxString: 1000 });
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,98}$/;

/**
 * PATCH /workspaces/:id (workspace:admin). WHAT "suspended" MEANS today: a workspace whose status is not `active` (both
 * `inactive` and `suspended`) is resolved as "not found" for EVERY member, administrators included (membership resolution
 * requires an active workspace), and no API route can reactivate it. So an administrator setting a non-active status through
 * the API always leaves the workspace with NO administrator able to reach it - the "at least one active administrator who can
 * still access it" invariant can never hold after such a change, however many administrators exist. It is therefore REFUSED
 * (409 WORKSPACE_LOCKOUT_PREVENTED). Suspending/reactivating a tenant is an operator act (scripts/workspace-lifecycle.mjs).
 */
export async function updateWorkspace(id, body) {
  const workspace = await findByIdOr404(Workspace, requireObjectId(id), "Workspace");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError("A JSON object body is required", 400, { code: "INVALID_BODY" });
  const updates = pickDefined(body, UPDATABLE);

  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields provided for update", 400);
  }

  if (updates.status !== undefined) {
    if (updates.status !== workspace.status) {
      throw new AppError(
        "A workspace cannot be suspended or deactivated through the API: it would become inaccessible to every member, administrators included. This is an operator action.",
        409,
        { code: "WORKSPACE_LOCKOUT_PREVENTED" },
      );
    }
    delete updates.status; // same value: a no-op
    if (Object.keys(updates).length === 0) return toPlain(workspace);
  }
  if (updates.name !== undefined) updates.name = requireBoundedString(updates.name, { max: 200, label: "name" });
  if (updates.slug !== undefined) {
    updates.slug = requireBoundedString(updates.slug, { max: 100, label: "slug" }).toLowerCase();
    if (!SLUG_PATTERN.test(updates.slug)) throw new AppError("slug may contain only lowercase letters, digits and hyphens", 400, { code: "INVALID_FIELD", field: "slug" });
  }
  if (updates.settings !== undefined) {
    if (updates.settings === null || typeof updates.settings !== "object" || Array.isArray(updates.settings)) throw new AppError("settings must be an object", 400, { code: "INVALID_FIELD", field: "settings" });
    assertBoundedJson(updates.settings, SETTINGS_LIMITS, "settings");
  }

  Object.assign(workspace, updates);
  await workspace.save();
  return toPlain(workspace);
}

/**
 * DELETE /workspaces/:id (workspace:admin): PERMANENT deletion of the workspace and everything it owns (see
 * workspaceLifecycleService.js and docs/WORKSPACE_LIFECYCLE_POLICY_PHASE22.md). Requires `{ "confirm": "<slug>" }`.
 */
export async function deleteWorkspace(id, body) {
  const { workspace } = await deleteWorkspaceCascade(id, { confirm: body?.confirm });
  return workspace;
}
