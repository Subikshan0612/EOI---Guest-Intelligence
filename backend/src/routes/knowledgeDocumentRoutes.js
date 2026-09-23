import { Router } from "express";
import multer from "multer";
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
  limits: { fileSize: 10 * 1024 * 1024 },
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

knowledgeDocumentRoutes.post("/", createKnowledgeDocument);
knowledgeDocumentRoutes.get("/", listKnowledgeDocuments);

// Phase 7F-D2 — dedicated upload endpoint, deliberately separate from the
// manual-entry POST / above rather than overloading it. Defined before the
// generic /:id routes below, same reasoning as the chunk/embeddings routes.
knowledgeDocumentRoutes.post("/upload", handleUpload, uploadKnowledgeDocument);

// Phase 6D — nested chunk sub-resource, same shape as
// conversationRoutes.js's /:conversationId/messages: POST (re)builds,
// GET reads back. Defined before the generic /:id routes below.
knowledgeDocumentRoutes.post("/:documentId/chunks", chunkKnowledgeDocument);
knowledgeDocumentRoutes.get("/:documentId/chunks", listKnowledgeChunks);

// Phase 6E — embeds the document's existing chunks. No GET counterpart:
// GET .../chunks above already returns each chunk's embedding/embeddingModel,
// so a second read endpoint would be redundant.
knowledgeDocumentRoutes.post("/:documentId/embeddings", embedKnowledgeDocument);

knowledgeDocumentRoutes.get("/:id", getKnowledgeDocument);
knowledgeDocumentRoutes.patch("/:id", updateKnowledgeDocument);
knowledgeDocumentRoutes.delete("/:id", deleteKnowledgeDocument);

export { knowledgeDocumentRoutes };
