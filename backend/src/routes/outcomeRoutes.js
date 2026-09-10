import { Router } from "express";
import {
  createOutcome,
  getOutcome,
  listOutcomes,
  updateOutcome,
} from "../controllers/outcomeController.js";

const outcomeRoutes = Router();

outcomeRoutes.post("/", createOutcome);
outcomeRoutes.get("/", listOutcomes);
outcomeRoutes.get("/:id", getOutcome);
outcomeRoutes.patch("/:id", updateOutcome);

export { outcomeRoutes };
