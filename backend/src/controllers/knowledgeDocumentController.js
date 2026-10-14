import { AppError } from "../utils/AppError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendList, sendSuccess } from "../utils/response.js";
import * as knowledgeDocumentService from "../services/knowledgeDocumentService.js";
import * as knowledgeChunkService from "../services/knowledgeChunkService.js";
import * as knowledgeEmbeddingService from "../services/knowledgeEmbeddingService.js";
import { extractDocumentText, sanitizeFilename } from "../services/knowledge/documentExtractor.js";
import { getAuthorizedKnowledgeLevel } from "../middleware/knowledgeAccess.js";

export const createKnowledgeDocument = asyncHandler(async (req, res) => {
  const data = await knowledgeDocumentService.createKnowledgeDocument({ ...req.body, workspaceId: req.actor.workspaceId });
  sendSuccess(res, await knowledgeDocumentService.redactDocumentForLevel(data, getAuthorizedKnowledgeLevel(req)), 201);
});

/**
 * Phase 7F-D2 — multipart/form-data equivalent of the create above, for
 * TXT/Markdown files (knowledgeDocumentRoutes.js's `handleUpload`
 * middleware already rejected an oversized/malformed multipart request
 * before this ever runs). This handler stays thin by design: extraction
 * happens here (documentExtractor.js), but document creation is the exact
 * same knowledgeDocumentService.createKnowledgeDocument() the manual-entry
 * path above uses — no second creation/validation/dedup/supersession
 * system. multipart/form-data fields arrive as strings; `isTestData` is
 * the one field whose type actually matters to the service's own
 * validation, so it's the only one normalized here before hand-off.
 *
 * After creation, this makes the existing chunk + embed steps happen
 * synchronously in the same request — the phase's explicit requirement
 * that a successful upload leaves the document retrieval-ready, not
 * merely created. If either step fails, the error propagates as this
 * request's response (see this phase's own report for the accepted
 * tradeoff: the document is not rolled back, matching how the existing
 * 3-step manual create/chunk/embed flow already tolerates a document
 * existing before it's fully chunked/embedded).
 */
export const uploadKnowledgeDocument = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new AppError("A file is required", 400);
  }

  // Phase 7F-D3: extractDocumentText is now async (PDF parsing is
  // inherently asynchronous) — the one necessary change to this file for
  // PDF support; TXT/Markdown handling inside the extractor itself is
  // completely unchanged.
  const { text, sourceType } = await extractDocumentText({
    originalName: req.file.originalname,
    buffer: req.file.buffer,
  });

  const isTestData =
    req.body.isTestData === "true" ? true : req.body.isTestData === "false" ? false : req.body.isTestData;

  const data = await knowledgeDocumentService.createKnowledgeDocument({
    ...req.body,
    workspaceId: req.actor.workspaceId,
    isTestData,
    content: text,
    sourceType,
    sourceFilename: sanitizeFilename(req.file.originalname),
  });

  // Phase 7F-D2 follow-up: document creation already succeeded above (its
  // _id is real and persisted) — if chunking or embedding now fails, that
  // same error is re-thrown completely unchanged (same message, same
  // statusCode: knowledgeEmbeddingService.js already marked the document
  // ingestionStatus:"failed" with a safe error internally before this
  // catch even runs). The only addition is attaching the already-created
  // document's id to the error's `details`, via AppError's existing,
  // previously-unused constructor field errorHandler.js now serializes —
  // so a caller who gets an error back still has something to act on
  // (retry via the existing POST /:id/chunks + /:id/embeddings, or list
  // ?ingestionStatus=failed) instead of an error with no way to find what
  // was actually created.
  try {
    await knowledgeChunkService.rebuildChunksForDocument(data._id, data.workspaceId);
    await knowledgeEmbeddingService.embedKnowledgeDocument(data._id, data.workspaceId);
  } catch (error) {
    // Merged, not "only when absent": AI-service errors carry a stable `details.code` (Phase 34A-B / 35), and the id must not be lost
    // because the error was already classified. Existing details (the code) are kept as they are.
    if (error instanceof AppError) {
      error.details = { ...(error.details ?? {}), knowledgeDocumentId: data._id };
    }
    throw error;
  }

  sendSuccess(res, await knowledgeDocumentService.redactDocumentForLevel(data, getAuthorizedKnowledgeLevel(req)), 201);
});

export const listKnowledgeDocuments = asyncHandler(async (req, res) => {
  const { items, pagination } = await knowledgeDocumentService.listKnowledgeDocuments(
    { ...req.query, workspaceId: req.actor.workspaceId },
    getAuthorizedKnowledgeLevel(req),
  );
  sendList(res, items, pagination);
});

export const getKnowledgeDocument = asyncHandler(async (req, res) => {
  const data = await knowledgeDocumentService.getKnowledgeDocumentById(
    req.params.id,
    req.actor.workspaceId,
    getAuthorizedKnowledgeLevel(req),
  );
  sendSuccess(res, data);
});

export const updateKnowledgeDocument = asyncHandler(async (req, res) => {
  const data = await knowledgeDocumentService.updateKnowledgeDocument(
    req.params.id,
    req.body,
    req.actor.workspaceId,
  );
  sendSuccess(res, await knowledgeDocumentService.redactDocumentForLevel(data, getAuthorizedKnowledgeLevel(req)));
});

export const deleteKnowledgeDocument = asyncHandler(async (req, res) => {
  const data = await knowledgeDocumentService.deleteKnowledgeDocument(
    req.params.id,
    req.actor.workspaceId,
  );
  // The delete response echoes the removed document, so it gets the same
  // content redaction as every other response that returns the document.
  sendSuccess(res, await knowledgeDocumentService.redactDocumentForLevel(data, getAuthorizedKnowledgeLevel(req)));
});

/** Phase 6D — (re)chunks the document's current canonical content. No request body: chunking derives entirely from the document Node already holds. */
export const chunkKnowledgeDocument = asyncHandler(async (req, res) => {
  const data = await knowledgeChunkService.rebuildChunksForDocument(
    req.params.documentId,
    req.actor.workspaceId,
    { authorizedLevel: getAuthorizedKnowledgeLevel(req) },
  );
  sendSuccess(res, data, 201);
});

export const listKnowledgeChunks = asyncHandler(async (req, res) => {
  const { items, pagination } = await knowledgeChunkService.listKnowledgeChunks(
    req.params.documentId,
    req.query,
    req.actor.workspaceId,
    getAuthorizedKnowledgeLevel(req),
  );
  sendList(res, items, pagination);
});

/** Phase 6E — embeds the document's current chunks via Python. No request body: chunk text is loaded from MongoDB, never accepted from a caller. */
export const embedKnowledgeDocument = asyncHandler(async (req, res) => {
  const data = await knowledgeEmbeddingService.embedKnowledgeDocument(
    req.params.documentId,
    req.actor.workspaceId,
  );
  sendSuccess(res, data, 201);
});
