import { KnowledgeChunk } from "../models/KnowledgeChunk.js";
import { KnowledgeDocument } from "../models/KnowledgeDocument.js";
import { chunkContent } from "./knowledge/knowledgeChunker.js";
import { requireObjectId } from "../utils/objectId.js";
import { parsePagination, parseSort } from "../utils/pagination.js";
import { AppError } from "../utils/AppError.js";
import { findInWorkspaceOr404, paginateQuery, toPlainList } from "./queryHelpers.js";
import { allowedVisibilities, canAccess, isValidVisibility } from "./knowledge/visibility.js";
import { classifierForProfile } from "./knowledge/corpusProfiles.js";

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

/**
 * Classification: if the document carries a `corpusProfile`, that profile's
 * reviewed mapping is applied AUTOMATICALLY (see knowledge/corpusProfiles.js)
 * - this is the one place both ingestion entrypoints (upload, and manual
 * create -> chunk -> embed) reach, so nobody has to remember to pass a
 * classifier. A stored profile id that is no longer registered stops the
 * rebuild instead of quietly chunking the document without its
 * classification. `options.classify(piece)` (optional, mainly for tests)
 * overrides the profile; it returns `{ include, visibility }` per chunk.
 * A chunk that is not included (held, excluded, or not in the mapping) is
 * never stored, and the remaining chunks are indexed contiguously.
 * Without any classifier, every chunk is stored at the document's own
 * `defaultVisibility` - and a document with no valid default falls back to
 * "restricted", never to a lower level.
 *
 * `options.authorizedLevel` limits which of the saved chunks are RETURNED to
 * the caller (the same visibility rule as the read endpoint); it does not
 * change what is stored. Omitted, it is the lowest level.
 */
export async function rebuildChunksForDocument(documentId, workspaceId, options = {}) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const document = await findInWorkspaceOr404(
    KnowledgeDocument,
    requireObjectId(documentId, "documentId"),
    scope,
    "KnowledgeDocument",
  );

  let classify = options.classify;
  if (!classify && document.corpusProfile) {
    classify = classifierForProfile(document.corpusProfile);
    if (!classify) {
      throw new AppError("This document references an unregistered corpusProfile; refusing to chunk it without its classification.", 500);
    }
  }

  const documentDefault = isValidVisibility(document.defaultVisibility) ? document.defaultVisibility : "restricted";
  const pieces = chunkContent(document.content);
  const classified = pieces
    .map((piece) => {
      if (!classify) return { piece, include: true, visibility: documentDefault };
      const decision = classify(piece);
      return {
        piece,
        include: decision.include === true,
        visibility: isValidVisibility(decision.visibility) ? decision.visibility : "restricted",
      };
    })
    .filter((entry) => entry.include);

  const chunks = classified.map(({ piece, visibility }, chunkIndex) => ({
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
    visibility,
    sectionPath: piece.sectionPath.length > 0 ? piece.sectionPath : undefined,
    text: piece.text,
  }));

  await replaceChunksForDocument(document, chunks);

  const saved = await KnowledgeChunk.find({
    documentId: document._id,
    version: document.version,
    visibility: { $in: allowedVisibilities(options.authorizedLevel) },
  }).sort({ chunkIndex: 1 });

  return {
    documentId: String(document._id),
    version: document.version,
    chunkCount: saved.length,
    chunks: toPlainList(saved),
    // Only when a classifier ran: how many parsed chunks were stored vs.
    // withheld (held, excluded, or unmapped).
    ...(classify
      ? { classification: { profile: document.corpusProfile, stored: chunks.length, withheld: pieces.length - chunks.length } }
      : {}),
  };
}

export async function listKnowledgeChunks(documentId, query, workspaceId, authorizedLevel) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const document = await findInWorkspaceOr404(
    KnowledgeDocument,
    requireObjectId(documentId, "documentId"),
    scope,
    "KnowledgeDocument",
  );

  // A document above the caller's level is not revealed to exist.
  if (!canAccess(authorizedLevel, document.defaultVisibility)) {
    throw new AppError("KnowledgeDocument not found", 404);
  }

  const pagination = parsePagination(query);
  const sort = parseSort(query, ["chunkIndex", "createdAt"], { chunkIndex: 1 });

  const filter = {
    documentId: document._id,
    version: document.version,
    // Only chunks at or below the caller's level; the total reflects this too.
    visibility: { $in: allowedVisibilities(authorizedLevel) },
  };
  // EMBEDDING VECTORS NEVER LEAVE THE SERVER: they stay in MongoDB for retrieval, but are not selected
  // for this HTTP response (a chunk's own text is still returned, at the caller's ceiling).
  const [items, total] = await Promise.all([
    KnowledgeChunk.find(filter).select("-embedding").sort(sort).skip(pagination.skip).limit(pagination.limit),
    KnowledgeChunk.countDocuments(filter),
  ]);
  return {
    items: toPlainList(items),
    pagination: { page: pagination.page, limit: pagination.limit, total, pages: total === 0 ? 0 : Math.ceil(total / pagination.limit) },
  };
}
