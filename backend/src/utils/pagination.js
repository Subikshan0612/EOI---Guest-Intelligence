import { AppError } from "./AppError.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function parsePagination(query = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  let limit = Number.parseInt(query.limit, 10) || DEFAULT_LIMIT;

  if (limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  const skip = (page - 1) * limit;

  return { page, limit, skip };
}

export function buildPagination({ page, limit, total }) {
  return {
    page,
    limit,
    total,
    pages: total === 0 ? 0 : Math.ceil(total / limit),
  };
}

export function parseSort(query = {}, allowedFields = ["createdAt"], defaultSort = { createdAt: -1 }) {
  const raw = typeof query.sort === "string" ? query.sort.trim() : "";
  if (!raw) return defaultSort;

  const direction = raw.startsWith("-") ? -1 : 1;
  const field = raw.replace(/^[-+]/, "");

  if (!allowedFields.includes(field)) {
    throw new AppError(`Unsupported sort field: ${field}`, 400);
  }

  return { [field]: direction };
}
