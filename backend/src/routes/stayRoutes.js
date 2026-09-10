import { Router } from "express";
import {
  createStay,
  deleteStay,
  getStay,
  listStays,
  updateStay,
} from "../controllers/stayController.js";

const stayRoutes = Router();

stayRoutes.post("/", createStay);
stayRoutes.get("/", listStays);
stayRoutes.get("/:id", getStay);
stayRoutes.patch("/:id", updateStay);
stayRoutes.delete("/:id", deleteStay);

export { stayRoutes };
