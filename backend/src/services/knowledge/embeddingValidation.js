import { AppError } from "../../utils/AppError.js";

/**
 * Phase 6E — pure validation of a Python /v1/embeddings response. No
 * MongoDB, no HTTP, no provider-specific knowledge: this only decides
 * whether what Node received is safe to persist onto KnowledgeChunk rows.
 *
 * `expectedDimension` lets a caller enforce consistency ACROSS multiple
 * batches of the same document (not just within one batch) — pass the
 * value this function returns into the next call. Passing `undefined`
 * treats the first vector's length as the dimension to hold every other
 * vector (in this batch and, if chained, in later batches) to.
 */
export function validateEmbeddingBatch(embeddings, model, expectedCount, expectedDimension) {
  if (!Array.isArray(embeddings) || embeddings.length !== expectedCount) {
    throw new AppError("AI intelligence service returned an unexpected number of embeddings.", 502);
  }
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new AppError("AI intelligence service did not report an embedding model.", 502);
  }

  let dimension = expectedDimension;

  for (const vector of embeddings) {
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new AppError("AI intelligence service returned an empty embedding vector.", 502);
    }
    if (!vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new AppError("AI intelligence service returned non-numeric embedding data.", 502);
    }
    if (dimension === undefined) {
      dimension = vector.length;
    } else if (vector.length !== dimension) {
      throw new AppError("AI intelligence service returned embeddings with inconsistent dimensionality.", 502);
    }
  }

  return dimension;
}
