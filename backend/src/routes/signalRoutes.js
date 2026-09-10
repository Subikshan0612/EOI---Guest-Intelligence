import { Router } from "express";
import {
  createSignal,
  deleteSignal,
  getSignal,
  listSignals,
  updateSignal,
} from "../controllers/signalController.js";

const signalRoutes = Router();

signalRoutes.post("/", createSignal);
signalRoutes.get("/", listSignals);
signalRoutes.get("/:id", getSignal);
signalRoutes.patch("/:id", updateSignal);
signalRoutes.delete("/:id", deleteSignal);

export { signalRoutes };
