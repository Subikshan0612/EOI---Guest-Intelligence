import { Router } from "express";
import { requireAccess } from "../auth/authorize.js";
import {
  createProperty,
  deleteProperty,
  getProperty,
  listProperties,
  updateProperty,
} from "../controllers/propertyController.js";

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
const propertyRoutes = Router();
const inBody = (req) => req.body?.workspaceId;

propertyRoutes.post("/", ...requireAccess("workspace:admin", inBody), createProperty);
propertyRoutes.get("/", ...requireAccess("intelligence:view"), listProperties);
propertyRoutes.get("/:id", ...requireAccess("intelligence:view"), getProperty);
propertyRoutes.patch("/:id", ...requireAccess("workspace:admin"), updateProperty);
propertyRoutes.delete("/:id", ...requireAccess("workspace:admin"), deleteProperty);

export { propertyRoutes };
