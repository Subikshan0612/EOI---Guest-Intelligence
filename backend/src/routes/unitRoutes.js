import { Router } from "express";
import { requireAccess } from "../auth/authorize.js";
import {
  createUnit,
  deleteUnit,
  getUnit,
  listUnits,
  updateUnit,
} from "../controllers/unitController.js";

/**
 * Phase 15: every route is AUTHENTICATED and authorized through the standard chain
 * (bearer token -> active membership of the selected workspace -> permission). The workspace a
 * caller names (query for reads/updates/deletes, body for creates) is only a SELECTOR: it is
 * verified against the caller's membership, and the controllers use the VERIFIED workspace.
 *   read    : intelligence:view
 *   create  : workspace:admin
 *   update  : workspace:admin
 *   delete  : workspace:admin
 */
const unitRoutes = Router();
const inBody = (req) => req.body?.workspaceId;

unitRoutes.post("/", ...requireAccess("workspace:admin", inBody), createUnit);
unitRoutes.get("/", ...requireAccess("intelligence:view"), listUnits);
unitRoutes.get("/:id", ...requireAccess("intelligence:view"), getUnit);
unitRoutes.patch("/:id", ...requireAccess("workspace:admin"), updateUnit);
unitRoutes.delete("/:id", ...requireAccess("workspace:admin"), deleteUnit);

export { unitRoutes };
