import { Router } from "express";
import { requireAccess } from "../auth/authorize.js";
import {
  createConversation,
  createMessage,
  deleteConversation,
  getConversation,
  intakeTurn,
  listConversations,
  listMessages,
  updateConversation,
} from "../controllers/conversationController.js";

/**
 * Phase 18: Conversations are WORKSPACE-SHARED. Every route is AUTHENTICATED and authorized through the standard
 * chain (bearer token -> active membership of the selected workspace -> permission). The workspace a caller names
 * (body for creating a conversation, query everywhere else) is only a SELECTOR; controllers use the VERIFIED
 * `req.actor.workspaceId`, and every object is resolved inside it (a Message through its parent Conversation).
 *
 *   read   (conversations, one conversation, its messages)   intelligence:view  every member
 *   write  (create/update a conversation, create a message)  operations:manage  operator, reviewer, admin
 *   delete (a conversation)                                  workspace:admin    (every delete is admin-only)
 *
 * There is no Message PATCH/DELETE route, and none is added: a Message is append-only. `Conversation.userId` is
 * legacy, non-authoritative metadata and is never used to authorize anything.
 */
const conversationRoutes = Router();
const inBody = (req) => req.body?.workspaceId;

conversationRoutes.post("/", ...requireAccess("operations:manage", inBody), createConversation);
// Phase 47: one operator turn of the conversational Signal intake. It RECORDS a Signal (through the same createSignal as the structured form, so it needs the same
// permission, operations:manage) or asks a clarifying question. It never calls the AI service; generation stays POST /api/intelligence/analyze/:signalId.
conversationRoutes.post("/intake", ...requireAccess("operations:manage", inBody), intakeTurn);
conversationRoutes.get("/", ...requireAccess("intelligence:view"), listConversations);
conversationRoutes.post("/:conversationId/messages", ...requireAccess("operations:manage"), createMessage);
conversationRoutes.get("/:conversationId/messages", ...requireAccess("intelligence:view"), listMessages);
conversationRoutes.get("/:id", ...requireAccess("intelligence:view"), getConversation);
conversationRoutes.patch("/:id", ...requireAccess("operations:manage"), updateConversation);
conversationRoutes.delete("/:id", ...requireAccess("workspace:admin"), deleteConversation);

export { conversationRoutes };
