import { Router } from "express";
import {
  createDecision,
  getDecision,
  listDecisions,
  updateDecision,
} from "../controllers/decisionController.js";

const decisionRoutes = Router();

decisionRoutes.post("/", createDecision);
decisionRoutes.get("/", listDecisions);
decisionRoutes.get("/:id", getDecision);
decisionRoutes.patch("/:id", updateDecision);

export { decisionRoutes };
