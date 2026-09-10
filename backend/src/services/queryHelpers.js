import mongoose from "mongoose";
import { AppError } from "../utils/AppError.js";

export async function findByIdOr404(Model, id, label = "Resource") {
  const document = await Model.findById(id);
  if (!document) {
    throw new AppError(`${label} not found`, 404);
  }
  return document;
}

export async function assertExists(Model, id, label = "Resource") {
  if (!id) return null;
  const exists = await Model.exists({ _id: id });
  if (!exists) {
    throw new AppError(`${label} not found`, 404);
  }
  return id;
}

/**
 * Synchronous workspace-ownership guard.
 *
 * This intentionally does no async work: it compares two ids that the caller
 * has already loaded. Keeping it synchronous means every call site fails
 * cleanly through the normal AppError path instead of producing an unhandled
 * promise rejection when the guard is not awaited.
 */
export function assertSameWorkspace(document, workspaceId, label = "Resource") {
  if (!document || !workspaceId) return;
  if (String(document.workspaceId) !== String(workspaceId)) {
    throw new AppError(`${label} does not belong to the given workspace`, 400);
  }
}

/**
 * Loads a tenant-owned document scoped to a workspace.
 *
 * Returns a 404 (never a 403) when the document exists but belongs to another
 * workspace, so callers cannot probe for the existence of other tenants' data.
 */
export async function findInWorkspaceOr404(Model, id, workspaceId, label = "Resource") {
  const document = await Model.findOne({ _id: id, workspaceId });
  if (!document) {
    throw new AppError(`${label} not found`, 404);
  }
  return document;
}

/**
 * Blocks tenant reassignment through an update: a PATCH may echo the resource's
 * own workspaceId, but must never point it at a different workspace.
 */
export function assertWorkspaceUnchanged(body, document) {
  if (
    body?.workspaceId !== undefined &&
    document?.workspaceId !== undefined &&
    String(body.workspaceId) !== String(document.workspaceId)
  ) {
    throw new AppError("workspaceId cannot be changed", 400);
  }
}

export function pickDefined(source, fields) {
  const result = {};
  for (const field of fields) {
    if (source[field] !== undefined) {
      result[field] = source[field];
    }
  }
  return result;
}

export function requireFields(body, fields) {
  for (const field of fields) {
    const value = body[field];
    if (value === undefined || value === null || value === "") {
      throw new AppError(`${field} is required`, 400);
    }
  }
}

export function toPlain(document) {
  if (!document) return document;
  return typeof document.toObject === "function" ? document.toObject({ flattenMaps: true }) : document;
}

export function toPlainList(documents) {
  return documents.map((document) => toPlain(document));
}

export function isDuplicateKeyError(error) {
  return Boolean(error && (error.code === 11000 || error.code === 11001));
}

export function duplicateKeyMessage(error, fallback = "Duplicate value violates a unique constraint") {
  const key = error?.keyValue ? Object.keys(error.keyValue).join(", ") : null;
  return key ? `Duplicate value for ${key}` : fallback;
}

export async function paginateQuery(Model, filter, { page, limit, skip }, sort) {
  const [items, total] = await Promise.all([
    Model.find(filter).sort(sort).skip(skip).limit(limit),
    Model.countDocuments(filter),
  ]);

  return {
    items: toPlainList(items),
    pagination: {
      page,
      limit,
      total,
      pages: total === 0 ? 0 : Math.ceil(total / limit),
    },
  };
}

export { mongoose };
