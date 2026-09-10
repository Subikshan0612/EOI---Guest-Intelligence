import { Router } from "express";
import {
  createUnit,
  deleteUnit,
  getUnit,
  listUnits,
  updateUnit,
} from "../controllers/unitController.js";

const unitRoutes = Router();

unitRoutes.post("/", createUnit);
unitRoutes.get("/", listUnits);
unitRoutes.get("/:id", getUnit);
unitRoutes.patch("/:id", updateUnit);
unitRoutes.delete("/:id", deleteUnit);

export { unitRoutes };
