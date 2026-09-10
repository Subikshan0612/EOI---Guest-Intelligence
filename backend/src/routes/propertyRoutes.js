import { Router } from "express";
import {
  createProperty,
  deleteProperty,
  getProperty,
  listProperties,
  updateProperty,
} from "../controllers/propertyController.js";

const propertyRoutes = Router();

propertyRoutes.post("/", createProperty);
propertyRoutes.get("/", listProperties);
propertyRoutes.get("/:id", getProperty);
propertyRoutes.patch("/:id", updateProperty);
propertyRoutes.delete("/:id", deleteProperty);

export { propertyRoutes };
