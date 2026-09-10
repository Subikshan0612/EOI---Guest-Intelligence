import { Router } from "express";
import {
  createIntelligence,
  getIntelligence,
  listIntelligence,
} from "../controllers/intelligenceController.js";

const intelligenceRoutes = Router();

intelligenceRoutes.post("/", createIntelligence);
intelligenceRoutes.get("/", listIntelligence);
intelligenceRoutes.get("/:id", getIntelligence);

export { intelligenceRoutes };
