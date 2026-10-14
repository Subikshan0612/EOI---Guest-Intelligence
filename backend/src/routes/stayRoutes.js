import { Router } from "express";
import { requireAccess } from "../auth/authorize.js";
import {
  createStay,
  deleteStay,
  getStay,
  listStays,
  updateStay,
} from "../controllers/stayController.js";

/**
 * Phase 15: every route is AUTHENTICATED and authorized through the standard chain
 * (bearer token -> active membership of the selected workspace -> permission). The workspace a
 * caller names (query for reads/updates/deletes, body for creates) is only a SELECTOR: it is
 * verified against the caller's membership, and the controllers use the VERIFIED workspace.
 *   read    : operations:view
 *   create  : operations:manage
 *   update  : operations:manage
 *   delete  : workspace:admin
 */
const stayRoutes = Router();
const inBody = (req) => req.body?.workspaceId;

stayRoutes.post("/", ...requireAccess("operations:manage", inBody), createStay);
stayRoutes.get("/", ...requireAccess("operations:view"), listStays);
stayRoutes.get("/:id", ...requireAccess("operations:view"), getStay);
stayRoutes.patch("/:id", ...requireAccess("operations:manage"), updateStay);
stayRoutes.delete("/:id", ...requireAccess("workspace:admin"), deleteStay);

export { stayRoutes };
