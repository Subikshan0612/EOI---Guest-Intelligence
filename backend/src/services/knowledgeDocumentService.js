import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { KnowledgeChunk } from "../models/KnowledgeChunk.js";
import { KnowledgeDocument } from "../models/KnowledgeDocument.js";
import { Property } from "../models/Property.js";
import { Unit } from "../models/Unit.js";
import { Workspace } from "../models/Workspace.js";
import { AppError } from "../utils/AppError.js";
import { parseObjectId, requireObjectId } from "../utils/objectId.js";
import { parsePagination, parseSort } from "../utils/pagination.js";
import {
  assertExists,
  assertSameWorkspace,
  assertWorkspaceUnchanged,
  findByIdOr404,
  findInWorkspaceOr404,
  paginateQuery,
  pickDefined,
  requireFields,
  toPlain,
} from "./queryHelpers.js";
import {
  allowedVisibilities,
  canAccess,
  isValidVisibility,
  maxVisibility,
} from "./knowledge/visibility.js";
import { getCorpusProfile } from "./knowledge/corpusProfiles.js";

/**
 * Phase 6B — thin CRUD only. Phase 6C confirmed this same POST is the
 * authoring/ingestion contract (no new endpoint was needed) and tightened
 * two validations create relies on (assertNonBlankContent,
 * assertValidVersion, below). No chunking, embeddings, or retrieval logic
 * lives here (see the Phase 6A architecture report). This mirrors
 * propertyService.js/signalService.js exactly: the same
 * requireObjectId/findInWorkspaceOr404/assertSameWorkspace pattern already
 * proven for every other tenant-owned resource.
 *
 * `content` and `version` are intentionally excluded from UPDATABLE — a
 * published version's content is immutable (Phase 6A report, Section 6); a
 * new version is a new document row, created via POST, never a PATCH to an
 * existing one.
 */
const UPDATABLE = [
  "propertyId",
  "unitId",
  "title",
  "documentType",
  "sourceType",
  "status",
  "supersedesId",
  "effectiveFrom",
  "effectiveTo",
  "sourceFilename",
  "isTestData",
  "defaultVisibility",
];

/** effectiveFrom/effectiveTo must be valid dates when supplied; both are optional. */
function assertValidDate(value, fieldName) {
  if (value === undefined || value === null || value === "") return;
  if (Number.isNaN(new Date(value).getTime())) {
    throw new AppError(`${fieldName} is not a valid date`, 400);
  }
}

/**
 * `content` has no schema-level `trim` (Phase 6B deliberately preserves an
 * SOP's exact formatting), so — unlike `title` — a whitespace-only value
 * would otherwise pass Mongoose's `required` check untrimmed. Checked here,
 * explicitly, rather than added to the model.
 */
function assertNonBlankContent(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError("content is required", 400);
  }
}

/**
 * The schema's `min: 1` alone accepts non-integers (e.g. 1.5) — versions are
 * a monotonic integer lineage (Phase 6A report, Section 6), not an arbitrary
 * number, so that's checked explicitly on create.
 */
function assertValidVersion(value) {
  if (value === undefined || value === null) return;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new AppError("version must be a positive integer", 400);
  }
}

function assertEffectiveWindowOrdered(effectiveFrom, effectiveTo) {
  if (!effectiveFrom || !effectiveTo) return;
  if (new Date(effectiveTo).getTime() <= new Date(effectiveFrom).getTime()) {
    throw new AppError("effectiveTo must be after effectiveFrom", 400);
  }
}

/** Phase 7F-D1 — isTestData is a plain boolean flag; reject anything else outright rather than let Mongoose loosely cast it. */
function assertValidBoolean(value, fieldName) {
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    throw new AppError(`${fieldName} must be a boolean`, 400);
  }
}

/**
 * Phase 7F-D1 — deterministic SHA-256 of a document's own canonical
 * `content`, exactly as stored (no trimming/normalization added here:
 * content deliberately preserves an SOP's exact formatting, per the
 * existing `content` field's own comment). Same input always produces the
 * same hash; never accepted from a caller, always computed here.
 */
function assertValidCorpusProfile(value) {
  if (value !== undefined && !getCorpusProfile(value)) {
    throw new AppError("corpusProfile is not a registered profile", 400);
  }
}

/**
 * A profile carries its own default visibility. When the caller does not
 * choose one, the profile's applies; a caller-supplied value that
 * contradicts the profile is refused rather than silently overridden.
 */
function resolveDefaultVisibility(body) {
  const profile = getCorpusProfile(body.corpusProfile);
  if (!profile) return body.defaultVisibility;
  if (body.defaultVisibility !== undefined && body.defaultVisibility !== profile.defaultVisibility) {
    throw new AppError(`defaultVisibility must be "${profile.defaultVisibility}" for corpusProfile "${profile.id}"`, 400);
  }
  return profile.defaultVisibility;
}

function assertValidDefaultVisibility(value) {
  if (value !== undefined && !isValidVisibility(value)) {
    throw new AppError("defaultVisibility must be one of: guest, staff, restricted", 400);
  }
}

/**
 * The visibility of the chunks that currently exist for each document's own
 * version, keyed "<documentId>:<version>". One aggregate for the whole batch.
 */
async function chunkVisibilitiesFor(documents) {
  const byDocument = new Map();
  if (documents.length === 0) return byDocument;

  const rows = await KnowledgeChunk.aggregate([
    { $match: { documentId: { $in: documents.map((doc) => new mongoose.Types.ObjectId(String(doc._id))) } } },
    { $group: { _id: { documentId: "$documentId", version: "$version" }, visibilities: { $addToSet: "$visibility" } } },
  ]);
  for (const row of rows) byDocument.set(`${row._id.documentId}:${row._id.version}`, row.visibilities);
  return byDocument;
}

/**
 * A document's stored `content` is the whole source text, so it is only as
 * shareable as the most restricted thing in it: the document's default
 * visibility (which covers anything not classified individually) or any of
 * its chunks, whichever is higher. A missing/invalid default counts as
 * restricted.
 */
function effectiveDocumentVisibility(doc, chunkVisibilities = []) {
  const base = isValidVisibility(doc.defaultVisibility) ? doc.defaultVisibility : "restricted";
  const invalidChunk = chunkVisibilities.some((level) => !isValidVisibility(level)) ? ["restricted"] : [];
  return maxVisibility([base, ...invalidChunk, ...chunkVisibilities]);
}

function withContentVisibility(doc, authorizedLevel, chunkVisibilities) {
  // A document with a corpusProfile never exposes its raw source text through
  // the API, at any level: that text still contains everything the profile
  // withheld from the corpus (held, excluded, and unmapped sections), so
  // returning it would bypass the corpus boundary. It stays stored in MongoDB;
  // only its exposure is closed. The approved chunks are read through the
  // chunk endpoints, which enforce chunk visibility.
  if (!doc.corpusProfile && canAccess(authorizedLevel, effectiveDocumentVisibility(doc, chunkVisibilities))) return doc;
  // eslint-disable-next-line no-unused-vars
  const { content, ...withoutContent } = doc;
  return { ...withoutContent, contentRedacted: true };
}

/**
 * Applies the caller's visibility to ONE already-loaded plain document: the
 * full `content` is included only if the caller may see everything the
 * document contains; otherwise it is omitted and `contentRedacted: true` is
 * set. Used for read responses and for the responses of write endpoints.
 */
export async function redactDocumentForLevel(doc, authorizedLevel) {
  const chunkVisibilities = await chunkVisibilitiesFor([doc]);
  return withContentVisibility(doc, authorizedLevel, chunkVisibilities.get(`${doc._id}:${doc.version}`) || []);
}

export function computeContentHash(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Phase 7F-D1 — resolves and validates the scope (propertyId/unitId) a new
 * version must have relative to the document it supersedes. A "new
 * version" is the same document at a later point in time, not a different
 * document, so its scope must match the superseded document's scope
 * exactly: inherited when the caller didn't specify one, and rejected
 * outright if the caller specified one that disagrees.
 */
function resolveSupersessionScope(superseded, bodyPropertyId, bodyUnitId) {
  const propertyId = bodyPropertyId !== undefined ? bodyPropertyId : superseded.propertyId;
  const unitId = bodyUnitId !== undefined ? bodyUnitId : superseded.unitId;

  const supersededPropertyId = superseded.propertyId ? String(superseded.propertyId) : null;
  const supersededUnitId = superseded.unitId ? String(superseded.unitId) : null;
  const resolvedPropertyId = propertyId ? String(propertyId) : null;
  const resolvedUnitId = unitId ? String(unitId) : null;

  if (resolvedPropertyId !== supersededPropertyId || resolvedUnitId !== supersededUnitId) {
    throw new AppError("A new version's scope (propertyId/unitId) must match the document it supersedes", 400);
  }

  return { propertyId, unitId };
}

/**
 * Validates every optional relationship a KnowledgeDocument may carry —
 * same shape as signalService.js's validateOptionalRefs: not just that each
 * id exists in the right workspace, but that the pieces agree with each
 * other (a unit must belong to the given property, if both are given).
 */
async function validateOptionalRefs(workspaceId, refs) {
  if (refs.propertyId) {
    const property = await findByIdOr404(Property, refs.propertyId, "Property");
    assertSameWorkspace(property, workspaceId, "Property");
  }

  if (refs.unitId) {
    const unit = await findByIdOr404(Unit, refs.unitId, "Unit");
    const unitProperty = await findByIdOr404(Property, unit.propertyId, "Property");
    assertSameWorkspace(unitProperty, workspaceId, "Unit");

    if (refs.propertyId && String(unit.propertyId) !== String(refs.propertyId)) {
      throw new AppError("Unit does not belong to the given property", 400);
    }
  }

  if (refs.supersedesId) {
    const superseded = await findByIdOr404(KnowledgeDocument, refs.supersedesId, "KnowledgeDocument");
    assertSameWorkspace(superseded, workspaceId, "KnowledgeDocument");
  }
}

/**
 * Phase 7F-D1 — when `body.supersedesId` is given, this same create call is
 * also a supersession: the new document's version is always derived from
 * the superseded document server-side (a caller-supplied `version` is
 * ignored entirely in this case — it is never trustworthy, per the phase's
 * explicit requirement), its scope must match the superseded document's
 * scope (resolveSupersessionScope), and — once the new document has been
 * created successfully — the superseded document is marked
 * `status: "superseded"` if it was still `"active"` (left untouched if it
 * was already `"archived"`, since the goal is only ever "never both
 * active," not forcing a specific terminal status).
 *
 * Order matters for safety: the new document is created FIRST, and the old
 * one is only updated after that succeeds. No MongoDB transaction wraps
 * these two writes (this project's established convention — see
 * knowledgeChunkService.js's own reasoning — since the local MongoDB
 * instance is standalone, not a replica set). If a request fails validation
 * (bad workspace, scope mismatch, unknown supersedesId), it throws before
 * either write happens, so an invalid supersession attempt never partially
 * mutates anything. A failure between the two writes (a genuine, rare
 * MongoDB-level failure on the second write) is a known, accepted gap of
 * not using a transaction here — see the phase report's architectural
 * concerns.
 */
export async function createKnowledgeDocument(body) {
  requireFields(body, ["workspaceId", "title", "documentType", "content"]);
  assertNonBlankContent(body.content);
  const workspaceId = requireObjectId(body.workspaceId, "workspaceId");
  assertValidDate(body.effectiveFrom, "effectiveFrom");
  assertValidDate(body.effectiveTo, "effectiveTo");
  assertEffectiveWindowOrdered(body.effectiveFrom, body.effectiveTo);
  assertValidBoolean(body.isTestData, "isTestData");
  assertValidDefaultVisibility(body.defaultVisibility);
  assertValidCorpusProfile(body.corpusProfile);
  const defaultVisibility = resolveDefaultVisibility(body);
  await assertExists(Workspace, workspaceId, "Workspace");

  const refs = {
    propertyId: parseObjectId(body.propertyId, "propertyId"),
    unitId: parseObjectId(body.unitId, "unitId"),
    supersedesId: parseObjectId(body.supersedesId, "supersedesId"),
  };

  await validateOptionalRefs(workspaceId, refs);

  let supersededDocument = null;
  let version;
  let { propertyId, unitId } = refs;

  if (refs.supersedesId) {
    supersededDocument = await findByIdOr404(KnowledgeDocument, refs.supersedesId, "KnowledgeDocument");
    ({ propertyId, unitId } = resolveSupersessionScope(supersededDocument, refs.propertyId, refs.unitId));
    version = supersededDocument.version + 1;
  } else {
    assertValidVersion(body.version);
    version = body.version ?? 1;
  }

  const contentHash = computeContentHash(body.content);

  const document = await KnowledgeDocument.create({
    workspaceId,
    propertyId,
    unitId,
    supersedesId: refs.supersedesId,
    title: body.title,
    documentType: body.documentType,
    sourceType: body.sourceType,
    content: body.content,
    contentHash,
    sourceFilename: body.sourceFilename,
    isTestData: body.isTestData,
    defaultVisibility,
    corpusProfile: body.corpusProfile,
    status: body.status,
    version,
    effectiveFrom: body.effectiveFrom,
    effectiveTo: body.effectiveTo,
  });

  if (supersededDocument && supersededDocument.status === "active") {
    // Same legacy-document safeguard as updateKnowledgeDocument's own
    // backfill: a document created before 7F-D1 shipped may have no
    // contentHash in MongoDB, which would otherwise fail this save's
    // full-document validation over an unrelated field.
    if (!supersededDocument.contentHash) {
      supersededDocument.contentHash = computeContentHash(supersededDocument.content);
    }
    supersededDocument.status = "superseded";
    await supersededDocument.save();
  }

  return toPlain(document);
}

export async function listKnowledgeDocuments(query, authorizedLevel) {
  const workspaceId = requireObjectId(query.workspaceId, "workspaceId");
  const pagination = parsePagination(query);
  const sort = parseSort(query, ["createdAt", "updatedAt", "title", "version", "effectiveFrom"], {
    createdAt: -1,
  });
  // A document is listed only when the caller may read it at all (its default
  // visibility is at or below their level); its content is then further
  // gated by what its chunks contain.
  const filter = { workspaceId, defaultVisibility: { $in: allowedVisibilities(authorizedLevel) } };

  if (query.propertyId) filter.propertyId = parseObjectId(query.propertyId, "propertyId");
  if (query.unitId) filter.unitId = parseObjectId(query.unitId, "unitId");
  if (query.documentType) filter.documentType = query.documentType;
  if (query.status) filter.status = query.status;
  // Phase 7F-D2 follow-up — lets a failed/half-ingested document be found
  // (e.g. GET ?ingestionStatus=failed) without a direct MongoDB query.
  if (query.ingestionStatus) filter.ingestionStatus = query.ingestionStatus;

  const { items, pagination: page } = await paginateQuery(KnowledgeDocument, filter, pagination, sort);
  const chunkVisibilities = await chunkVisibilitiesFor(items);
  return {
    items: items.map((doc) => withContentVisibility(doc, authorizedLevel, chunkVisibilities.get(`${doc._id}:${doc.version}`) || [])),
    pagination: page,
  };
}

export async function getKnowledgeDocumentById(id, workspaceId, authorizedLevel) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const document = await findInWorkspaceOr404(KnowledgeDocument, requireObjectId(id), scope, "KnowledgeDocument");
  // Same 404 as a missing document: a document above the caller's level is
  // not revealed to exist.
  if (!canAccess(authorizedLevel, document.defaultVisibility)) {
    throw new AppError("KnowledgeDocument not found", 404);
  }
  return redactDocumentForLevel(toPlain(document), authorizedLevel);
}

export async function updateKnowledgeDocument(id, body, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const document = await findInWorkspaceOr404(
    KnowledgeDocument,
    requireObjectId(id),
    scope,
    "KnowledgeDocument",
  );
  assertWorkspaceUnchanged(body, document);

  if (body?.content !== undefined) {
    throw new AppError("content cannot be changed — create a new version instead", 400);
  }
  if (body?.version !== undefined) {
    throw new AppError("version cannot be changed directly", 400);
  }
  if (body?.corpusProfile !== undefined) {
    throw new AppError("corpusProfile cannot be changed — create a new version instead", 400);
  }

  const updates = pickDefined(body, UPDATABLE);

  if (Object.keys(updates).length === 0) {
    throw new AppError("No valid fields provided for update", 400);
  }

  for (const key of ["propertyId", "unitId", "supersedesId"]) {
    if (updates[key] !== undefined) {
      updates[key] = parseObjectId(updates[key], key);
    }
  }

  assertValidDate(updates.effectiveFrom, "effectiveFrom");
  assertValidDate(updates.effectiveTo, "effectiveTo");
  assertEffectiveWindowOrdered(
    updates.effectiveFrom ?? document.effectiveFrom,
    updates.effectiveTo ?? document.effectiveTo,
  );
  assertValidBoolean(updates.isTestData, "isTestData");
  assertValidDefaultVisibility(updates.defaultVisibility);

  await validateOptionalRefs(document.workspaceId, {
    propertyId: updates.propertyId ?? document.propertyId,
    unitId: updates.unitId ?? document.unitId,
    supersedesId: updates.supersedesId,
  });

  // Phase 7F-D1 — contentHash is required on the schema going forward, but a
  // document created before this phase shipped has no such field in
  // MongoDB. Backfilling it here (derived from the document's own,
  // unchanged `content`) means an old document self-heals on its next
  // PATCH instead of failing full-document validation on save — no
  // migration script needed.
  if (!document.contentHash) {
    document.contentHash = computeContentHash(document.content);
  }

  Object.assign(document, updates);
  await document.save();
  return toPlain(document);
}

export async function deleteKnowledgeDocument(id, workspaceId) {
  const scope = requireObjectId(workspaceId, "workspaceId");
  const document = await findInWorkspaceOr404(
    KnowledgeDocument,
    requireObjectId(id),
    scope,
    "KnowledgeDocument",
  );
  await document.deleteOne();
  return toPlain(document);
}
