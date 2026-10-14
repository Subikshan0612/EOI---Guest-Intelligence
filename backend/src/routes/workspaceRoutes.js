import { Router } from "express";
import { authenticate } from "../auth/authenticate.js";
import { requireAccess } from "../auth/authorize.js";
import { userLimiter } from "../middleware/rateLimit.js";
import {
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
} from "../controllers/workspaceController.js";

const workspaceRoutes = Router();

// Workspace ADMINISTRATION (change or delete a workspace) requires an authenticated
// member with `workspace:admin` IN THAT WORKSPACE. The workspace being acted on is
// the route's own :id - never a query parameter or body field - and it must be an
// ACTIVE workspace the caller is an active member of (anything else is the same 404).
// Before this, PATCH could suspend or rename ANY workspace and DELETE could remove it,
// with no credential, which also locked every authenticated caller out of it.
const workspaceAdmin = requireAccess("workspace:admin", (req) => req.params.id);

// Phase 16:
//   GET  /        authenticated: lists ONLY the workspaces the caller has an ACTIVE membership in
//   GET  /:id     authenticated: an ACTIVE member (any role) of :id; anyone else gets the same 404
//   POST /        RETIRED. Creating a workspace is not an HTTP operation: a new workspace has no
//                 members, and there is no platform-admin concept, so it is an out-of-band
//                 operator act (scripts/create-dev-workspace.mjs). No route exists (404).
const workspaceMember = requireAccess("intelligence:view", (req) => req.params.id);
workspaceRoutes.get("/", authenticate, userLimiter, listWorkspaces);
workspaceRoutes.get("/:id", ...workspaceMember, getWorkspace);
workspaceRoutes.patch("/:id", ...workspaceAdmin, updateWorkspace);
workspaceRoutes.delete("/:id", ...workspaceAdmin, deleteWorkspace);

export { workspaceRoutes };
