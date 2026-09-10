import { Router } from "express";
import {
  createGuest,
  deleteGuest,
  getGuest,
  listGuests,
  updateGuest,
} from "../controllers/guestController.js";

const guestRoutes = Router();

guestRoutes.post("/", createGuest);
guestRoutes.get("/", listGuests);
guestRoutes.get("/:id", getGuest);
guestRoutes.patch("/:id", updateGuest);
guestRoutes.delete("/:id", deleteGuest);

export { guestRoutes };
