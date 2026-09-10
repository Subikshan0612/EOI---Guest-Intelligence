import { Router } from "express";
import {
  createAction,
  getAction,
  listActions,
  updateAction,
} from "../controllers/actionController.js";

const actionRoutes = Router();

actionRoutes.post("/", createAction);
actionRoutes.get("/", listActions);
actionRoutes.get("/:id", getAction);
actionRoutes.patch("/:id", updateAction);

export { actionRoutes };
