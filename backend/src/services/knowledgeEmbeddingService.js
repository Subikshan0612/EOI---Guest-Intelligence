import { KnowledgeChunk } from "../models/KnowledgeChunk.js";
import { KnowledgeDocument } from "../models/KnowledgeDocument.js";
import { requestEmbeddingsFromAiService } from "./ai/aiServiceClient.js";
import { validateEmbeddingBatch } from "./knowledge/embeddingValidation.js";
import { AppError } from "../utils/AppError.js";
import { requireObjectId } from "../utils/objectId.js";
import { findInWorkspaceOr404 } from "./queryHelpers.js";

/**
 * Phase 6E — turns a KnowledgeDocument's already-chunked KnowledgeChunk rows
 * into embedded vectors. Node resolves the tenant-scoped document and its
 * chunks, sends only chunk *text* to Python, validates what comes back, and
 * is the only thing that ever writes to MongoDB — Python never sees a
 * workspaceId, a chunk id, or any tenant concept (see
 * backend/src/services/ai/aiServiceClient.js's requestEmbeddingsFromAiService
 * and ai-service/app/routers/embeddings.py).
 *
 * Conservative, independently-chosen Node-side batch size. Not read from
 * Python's own EMBEDDING_BATCH_SIZE config (Node cannot see Python's env —
 * the two are deliberately independent), but set to the same conservative
 * initial value for consistency; tune both together later if needed.
 */
const EMBEDDING_BATCH_SIZE = 20;

function toBatches(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

export async function embedKnowledgeDocument(documentId, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const document = await findInWorkspaceOr404(
    KnowledgeDocument,
    requireObjectId(documentId, "documentId"),
    scope,
    "KnowledgeDocument",
  );

  const chunks = await KnowledgeChunk.find({
    documentId: document._id,
    version: document.version,
  }).sort({ chunkIndex: 1 });

  if (chunks.length === 0) {
    throw new AppError("This document has no chunks to embed — chunk it first.", 400);
  }

  const batches = toBatches(chunks, EMBEDDING_BATCH_SIZE);

  /**
   * Every batch is requested from Python and validated BEFORE anything is
   * written to MongoDB. The alternative — persisting each batch as soon as
   * it succeeds — would risk leaving a document half-embedded if a later
   * batch fails (some chunks carrying a vector, others not), a confusing
   * state a future retrieval phase would have to special-case around.
   * Requiring every batch to succeed first, then writing once, keeps this
   * document in exactly one of two states: fully embedded, or unchanged.
   *
   * The accepted trade-off: a failure on batch N still spends whatever real
   * provider calls were already made for batches before it — those vectors
   * are simply discarded rather than persisted. No MongoDB transaction is
   * used here (the local instance is a standalone MongoDB with no replica
   * set, so multi-document transactions aren't available — see
   * knowledgeChunkService.js's identical reasoning for its own rebuild
   * operation), so this in-memory-then-single-write approach is the
   * strongest guarantee achievable without standing up infrastructure this
   * phase doesn't otherwise need.
   */
  let dimension;
  const results = [];
  for (const batch of batches) {
    const texts = batch.map((chunk) => chunk.text);
    const { embeddings, model } = await requestEmbeddingsFromAiService(texts);
    dimension = validateEmbeddingBatch(embeddings, model, texts.length, dimension);

    batch.forEach((chunk, i) => {
      results.push({ chunk, embedding: embeddings[i], model });
    });
  }

  await KnowledgeChunk.bulkWrite(
    results.map(({ chunk, embedding, model }) => ({
      updateOne: {
        // documentId/version repeated in the filter even though `_id` alone
        // already uniquely identifies the chunk — belt-and-suspenders
        // against ever touching a chunk from another document or version.
        filter: { _id: chunk._id, documentId: document._id, version: document.version },
        update: { $set: { embedding, embeddingModel: model } },
      },
    })),
    { ordered: true },
  );

  return {
    documentId: String(document._id),
    version: document.version,
    chunkCount: results.length,
    embeddingModel: results[0]?.model,
  };
}
