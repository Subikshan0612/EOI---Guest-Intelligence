import { KnowledgeChunk } from "../models/KnowledgeChunk.js";
import { KnowledgeDocument } from "../models/KnowledgeDocument.js";
import { chunkContent } from "./knowledge/knowledgeChunker.js";
import { requireObjectId } from "../utils/objectId.js";
import { parsePagination, parseSort } from "../utils/pagination.js";
import { findInWorkspaceOr404, paginateQuery, toPlainList } from "./queryHelpers.js";

/**
 * Phase 6D — turns a KnowledgeDocument's canonical `content` into
 * KnowledgeChunk rows. No embeddings, no retrieval, no Python involvement —
 * see backend/src/services/knowledge/knowledgeChunker.js for the pure
 * splitting logic this module wires up to MongoDB and tenant isolation.
 *
 * Every scope field written onto a chunk (workspaceId/propertyId/unitId/
 * status/effectiveFrom/effectiveTo) is read from the already-tenant-verified
 * parent document — never from a caller-supplied value. There is no request
 * body for the rebuild endpoint at all, by design: chunking is entirely a
 * function of the document Node already has, not of anything a client sends.
 */

/**
 * Local MongoDB here is a standalone instance (no replica set), so
 * multi-document transactions are unavailable — `mongoose.startSession()` +
 * `withTransaction()` would fail at runtime, and standing up a replica set
 * solely for this phase would be exactly the kind of unnecessary
 * infrastructure Phase 6D was told to avoid. Instead, replacement uses
 * MongoDB's own per-operation atomicity: each new chunk is upserted by its
 * natural unique key (`documentId` + `version` + `chunkIndex`, already
 * enforced by a unique index on KnowledgeChunk), and only chunk indexes
 * beyond the new chunk count are deleted afterward. Because every chunk
 * index that exists both before and after a re-chunk is replaced in place
 * (never deleted-then-reinserted), there is no window where a still-valid
 * chunk index is briefly absent — unlike a naive "delete all, then insert
 * all" rebuild. The operation is also idempotent: re-running it against
 * unchanged content upserts identical documents and deletes nothing.
 */
async function replaceChunksForDocument(document, chunks) {
  if (chunks.length > 0) {
    const operations = chunks.map((chunk) => ({
      replaceOne: {
        filter: { documentId: document._id, version: document.version, chunkIndex: chunk.chunkIndex },
        replacement: chunk,
        upsert: true,
      },
    }));
    await KnowledgeChunk.bulkWrite(operations, { ordered: true });
  }

  // Remove any surplus chunks left over from a previous, longer chunking of
  // this exact document version — never touches another document/version.
  await KnowledgeChunk.deleteMany({
    documentId: document._id,
    version: document.version,
    chunkIndex: { $gte: chunks.length },
  });
}

export async function rebuildChunksForDocument(documentId, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const document = await findInWorkspaceOr404(
    KnowledgeDocument,
    requireObjectId(documentId, "documentId"),
    scope,
    "KnowledgeDocument",
  );

  const pieces = chunkContent(document.content);
  const chunks = pieces.map((piece, chunkIndex) => ({
    documentId: document._id,
    version: document.version,
    workspaceId: document.workspaceId,
    propertyId: document.propertyId,
    unitId: document.unitId,
    status: document.status,
    effectiveFrom: document.effectiveFrom,
    effectiveTo: document.effectiveTo,
    chunkIndex,
    section: piece.section,
    text: piece.text,
  }));

  await replaceChunksForDocument(document, chunks);

  const saved = await KnowledgeChunk.find({
    documentId: document._id,
    version: document.version,
  }).sort({ chunkIndex: 1 });

  return {
    documentId: String(document._id),
    version: document.version,
    chunkCount: saved.length,
    chunks: toPlainList(saved),
  };
}

export async function listKnowledgeChunks(documentId, query, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const document = await findInWorkspaceOr404(
    KnowledgeDocument,
    requireObjectId(documentId, "documentId"),
    scope,
    "KnowledgeDocument",
  );

  const pagination = parsePagination(query);
  const sort = parseSort(query, ["chunkIndex", "createdAt"], { chunkIndex: 1 });

  return paginateQuery(
    KnowledgeChunk,
    { documentId: document._id, version: document.version },
    pagination,
    sort,
  );
}
