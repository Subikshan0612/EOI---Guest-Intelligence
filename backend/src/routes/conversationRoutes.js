import { Router } from "express";
import {
  createConversation,
  createMessage,
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
  updateConversation,
} from "../controllers/conversationController.js";

const conversationRoutes = Router();

conversationRoutes.post("/", createConversation);
conversationRoutes.get("/", listConversations);

conversationRoutes.post("/:conversationId/messages", createMessage);
conversationRoutes.get("/:conversationId/messages", listMessages);

conversationRoutes.get("/:id", getConversation);
conversationRoutes.patch("/:id", updateConversation);
conversationRoutes.delete("/:id", deleteConversation);

export { conversationRoutes };
