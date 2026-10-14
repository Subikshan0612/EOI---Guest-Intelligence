import { Router } from "express";
import { requireAccess } from "../auth/authorize.js";
import {
  createGuest,
  deleteGuest,
  getGuest,
  listGuests,
  updateGuest,
} from "../controllers/guestController.js";

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
const guestRoutes = Router();
const inBody = (req) => req.body?.workspaceId;

guestRoutes.post("/", ...requireAccess("operations:manage", inBody), createGuest);
guestRoutes.get("/", ...requireAccess("operations:view"), listGuests);
guestRoutes.get("/:id", ...requireAccess("operations:view"), getGuest);
guestRoutes.patch("/:id", ...requireAccess("operations:manage"), updateGuest);
guestRoutes.delete("/:id", ...requireAccess("workspace:admin"), deleteGuest);

export { guestRoutes };
