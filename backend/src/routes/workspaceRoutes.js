import { Router } from "express";
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
} from "../controllers/workspaceController.js";

const workspaceRoutes = Router();

workspaceRoutes.post("/", createWorkspace);
workspaceRoutes.get("/", listWorkspaces);
workspaceRoutes.get("/:id", getWorkspace);
workspaceRoutes.patch("/:id", updateWorkspace);
workspaceRoutes.delete("/:id", deleteWorkspace);

export { workspaceRoutes };
