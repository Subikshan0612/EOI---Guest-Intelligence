import { Router } from "express";
import multer from "multer";
import { authenticatedPrelude, requireAccess } from "../auth/authorize.js";
import { aiWorkspaceLimiter } from "../middleware/rateLimit.js";
import { requireWorkspaceMembership } from "../auth/membership.js";
import { requirePermission } from "../auth/authorize.js";
import { AppError } from "../utils/AppError.js";
import {
  chunkKnowledgeDocument,
  createKnowledgeDocument,
  deleteKnowledgeDocument,
  embedKnowledgeDocument,
  getKnowledgeDocument,
  listKnowledgeChunks,
  listKnowledgeDocuments,
  updateKnowledgeDocument,
  uploadKnowledgeDocument,
} from "../controllers/knowledgeDocumentController.js";

const knowledgeDocumentRoutes = Router();

// Phase 7F-D2 — memory storage only: the raw upload is never written to
// disk or any blob store (an explicit D2 decision — see the phase report;
// only the extracted, normalized text is ever persisted, via the existing
// KnowledgeDocument.content). 10 MB matches the phase's approved limit;
// deliberately does not touch app.js's own express.json() body limit,
// which this route doesn't use at all.
const upload = multer({
  storage: multer.memoryStorage(),
  // fileSize 10 MB; one file; a few small text fields (metadata), each <= 100 KB.
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 20, fieldSize: 100 * 1024, parts: 30 },
});

/**
 * Thin adapter so a multer failure (oversized file, malformed multipart
 * body) becomes the same AppError-shaped response every other validation
 * failure in this codebase already produces, instead of an unhandled
 * MulterError reaching errorHandler.js as a generic 500.
 */
function handleUpload(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return next(new AppError("File exceeds the maximum upload size of 10 MB", 413));
      }
      return next(new AppError("File upload failed", 400));
    }
    if (err) return next(err);
    next();
  });
}

// KNOWLEDGE MANAGEMENT (create, edit, delete, chunk, embed, upload, visibility) is ADMIN-ONLY:
// bearer -> active membership -> workspace:admin. Changing a document's visibility changes
// what retrieval can expose, so it is never a lower-trust act. The workspace a request names is
// only a selection (a JSON/form body field for creates and uploads, the ?workspaceId= query for
// the rest); the verified membership decides.
const manage = (getWorkspaceId, options) => requireAccess("workspace:admin", getWorkspaceId, options);
// Routes that reach the AI service (auto chunk + embed after create, embeddings) use the stricter AI rate-limit tier.
const manageAi = (getWorkspaceId) => manage(getWorkspaceId, { tier: "ai" });
const fromBody = (req) => req.body?.workspaceId;

knowledgeDocumentRoutes.post("/", ...manageAi(fromBody), createKnowledgeDocument);
// READS: authenticated, intelligence:view, the role's knowledge ceiling, the verified workspace.
const readAccess = () => requireAccess("intelligence:view");
knowledgeDocumentRoutes.get("/", ...readAccess(), listKnowledgeDocuments);

// Phase 7F-D2 — dedicated upload endpoint, deliberately separate from the
// manual-entry POST / above rather than overloading it. Defined before the
// generic /:id routes below, same reasoning as the chunk/embeddings routes.
// authenticate BEFORE the multipart parser (an unauthenticated body is never parsed); the workspace
// field is inside the form, so membership is resolved after it.
knowledgeDocumentRoutes.post("/upload", ...authenticatedPrelude({ tier: "ai" }), handleUpload, requireWorkspaceMembership(fromBody), requirePermission("workspace:admin"), aiWorkspaceLimiter, uploadKnowledgeDocument);

// Phase 6D — nested chunk sub-resource, same shape as
// conversationRoutes.js's /:conversationId/messages: POST (re)builds,
// GET reads back. Defined before the generic /:id routes below.
knowledgeDocumentRoutes.post("/:documentId/chunks", ...manage(), chunkKnowledgeDocument);
knowledgeDocumentRoutes.get("/:documentId/chunks", ...readAccess(), listKnowledgeChunks);

// Phase 6E — embeds the document's existing chunks. No GET counterpart:
// GET .../chunks above already returns each chunk's embedding/embeddingModel,
// so a second read endpoint would be redundant.
knowledgeDocumentRoutes.post("/:documentId/embeddings", ...manageAi(), embedKnowledgeDocument);

knowledgeDocumentRoutes.get("/:id", ...readAccess(), getKnowledgeDocument);
knowledgeDocumentRoutes.patch("/:id", ...manage(), updateKnowledgeDocument);
knowledgeDocumentRoutes.delete("/:id", ...manage(), deleteKnowledgeDocument);

export { knowledgeDocumentRoutes };
