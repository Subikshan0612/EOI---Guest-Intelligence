import { STAY_STATUSES } from "../../models/Stay.js";
import { AppError } from "../../utils/AppError.js";

/**
 * Phase 7F-E — deterministic mapping/normalization helpers for eZee CSV
 * operational import.
 *
 * No real eZee export has been incorporated into this repository yet, so
 * none of this hard-codes production column names, status vocabulary, or a
 * date format — every one of those is supplied by the caller as explicit,
 * configuration (mappingProfile / statusMapping / dateFormat) and validated
 * deterministically (exact match after trim/case normalization). No fuzzy
 * matching, embeddings, or LLM-based inference.
 */

const GUEST_TARGET_FIELDS = [
  "guest.externalId",
  "guest.firstName",
  "guest.lastName",
  "guest.email",
  "guest.phone",
];

const STAY_TARGET_FIELDS = [
  "stay.reservationId",
  "stay.roomNumber",
  "stay.checkIn",
  "stay.checkOut",
  "stay.status",
  "stay.adults",
  "stay.children",
];

const MAX_SOURCE_COLUMN_LENGTH = 200;
const MAX_DATE_FORMAT_LENGTH = 40;
const MAX_STATUS_MAPPING_ENTRIES = 200;
const MAX_STATUS_TEXT_LENGTH = 100;

/** Bounds any caller/CSV-derived text before it can appear in an error message. */
export function clip(value, max = 40) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

const ALLOWED_TARGET_FIELDS = new Set([...GUEST_TARGET_FIELDS, ...STAY_TARGET_FIELDS]);

/** Without these two, nothing in the import can be matched idempotently. */
const REQUIRED_TARGET_FIELDS = ["guest.externalId", "stay.reservationId"];

/** The single header-matching rule: trim + case-insensitive. Used for both duplicate detection and mapping. */
export function normalizeHeaderKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Rejects a file whose header row has two or more headers that are identical
 * under normalizeHeaderKey (exact, or differing only by whitespace/case) —
 * a duplicate makes column mapping ambiguous, so no row may be processed.
 * Empty header cells are exempt: they can never be mapped (mapping targets
 * must name a non-empty column).
 */
export function assertNoDuplicateHeaders(headerRow) {
  const seen = new Map();
  (headerRow || []).forEach((header, index) => {
    const key = normalizeHeaderKey(header);
    if (key === "") return;
    if (seen.has(key)) {
      throw new AppError(
        `CSV has a duplicate column header "${clip(String(header).trim())}" (columns ${seen.get(key) + 1} and ${index + 1})`,
        400,
      );
    }
    seen.set(key, index);
  });
}

/**
 * Validates the caller-supplied mapping profile against the CSV's actual
 * header row (line 1) and returns a normalized { targetField: sourceColumn }
 * map. Source columns are matched by exact string equality after trimming —
 * deterministic, never fuzzy.
 */
export function validateMappingProfile(mappingProfile, headerRow) {
  if (!mappingProfile || typeof mappingProfile !== "object" || Array.isArray(mappingProfile)) {
    throw new AppError("mappingProfile is required and must be an object", 400);
  }

  const headersByKey = new Map();
  for (const header of headerRow || []) {
    const key = normalizeHeaderKey(header);
    if (key !== "" && !headersByKey.has(key)) headersByKey.set(key, String(header).trim());
  }
  const normalized = {};

  for (const [target, sourceColumn] of Object.entries(mappingProfile)) {
    if (!ALLOWED_TARGET_FIELDS.has(target)) {
      throw new AppError(`mappingProfile has unknown target field "${clip(target)}"`, 400);
    }
    if (typeof sourceColumn !== "string" || sourceColumn.trim() === "") {
      throw new AppError(`mappingProfile target "${target}" must map to a non-empty source column name`, 400);
    }
    const column = sourceColumn.trim();
    if (column.length > MAX_SOURCE_COLUMN_LENGTH) {
      throw new AppError(`mappingProfile target "${target}" has a source column name that is too long`, 400);
    }
    const actualHeader = headersByKey.get(normalizeHeaderKey(column));
    if (actualHeader === undefined) {
      throw new AppError(`mappingProfile source column "${clip(column)}" was not found in the CSV header row`, 400);
    }
    if (actualHeader.length > MAX_SOURCE_COLUMN_LENGTH) {
      throw new AppError(`mappingProfile target "${target}" resolves to a header that is too long`, 400);
    }
    // Stored/used as the file's actual (trimmed) header text.
    normalized[target] = actualHeader;
  }

  for (const required of REQUIRED_TARGET_FIELDS) {
    if (!normalized[required]) {
      throw new AppError(`mappingProfile must map "${required}"`, 400);
    }
  }

  return normalized;
}

/** Applies a validated mapping profile to one parsed CSV row object. */
export function mapRow(rawRow, mappingProfile) {
  const mapped = {};
  for (const [target, sourceColumn] of Object.entries(mappingProfile)) {
    // Source columns are only ever CSV header names: read own string cells
    // only, never anything inherited (e.g. a header named "__proto__").
    const value = Object.hasOwn(rawRow, sourceColumn) ? rawRow[sourceColumn] : undefined;
    mapped[target] = typeof value === "string" ? value.trim() : undefined;
  }
  return mapped;
}

const DATE_TOKEN_PATTERN = /YYYY|MM|DD|HH|mm|ss/g;
const DATE_TOKEN_REGEX_PARTS = {
  YYYY: "(\\d{4})",
  MM: "(\\d{2})",
  DD: "(\\d{2})",
  HH: "(\\d{2})",
  mm: "(\\d{2})",
  ss: "(\\d{2})",
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds a deterministic date parser from a caller-supplied token format
 * (e.g. "DD/MM/YYYY" or "MM-DD-YYYY HH:mm"). No eZee date format is assumed
 * — this must be told the format, never guess it. Returns a function that
 * returns a UTC Date on success, or null on a value that doesn't match the
 * format or has an out-of-range/impossible date component.
 */
export function buildDateParser(dateFormat) {
  if (typeof dateFormat !== "string" || dateFormat.trim() === "") {
    throw new AppError("dateFormat is required", 400);
  }
  if (dateFormat.length > MAX_DATE_FORMAT_LENGTH) {
    throw new AppError("dateFormat is too long", 400);
  }

  const order = [];
  let regexSource = "";
  let cursor = 0;
  let match;
  DATE_TOKEN_PATTERN.lastIndex = 0;
  while ((match = DATE_TOKEN_PATTERN.exec(dateFormat)) !== null) {
    regexSource += escapeRegExp(dateFormat.slice(cursor, match.index));
    regexSource += DATE_TOKEN_REGEX_PARTS[match[0]];
    order.push(match[0]);
    cursor = DATE_TOKEN_PATTERN.lastIndex;
  }
  regexSource += escapeRegExp(dateFormat.slice(cursor));

  if (!order.includes("YYYY") || !order.includes("MM") || !order.includes("DD")) {
    throw new AppError("dateFormat must include YYYY, MM, and DD", 400);
  }
  if (new Set(order).size !== order.length) {
    throw new AppError("dateFormat contains duplicate tokens", 400);
  }

  const regex = new RegExp(`^${regexSource}$`);

  return function parseDate(value) {
    if (typeof value !== "string" || value.trim() === "") return null;
    const parsedMatch = regex.exec(value.trim());
    if (!parsedMatch) return null;

    const parts = {};
    order.forEach((token, index) => {
      parts[token] = Number(parsedMatch[index + 1]);
    });

    const year = parts.YYYY;
    const month = parts.MM;
    const day = parts.DD;
    const hour = parts.HH ?? 0;
    const minute = parts.mm ?? 0;
    const second = parts.ss ?? 0;

    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
      return null;
    }

    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      return null; // rejects rollover dates such as 30 Feb
    }
    return date;
  };
}

function normalizeStatusKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Validates a caller-supplied { eZeeStatusValue: koiStatusEnum } dictionary.
 * Every target must already be one of the existing Stay.status enum values;
 * nothing is invented or guessed here. Returns a normalized (trimmed,
 * lower-cased key) lookup map for deterministic per-row matching.
 */
export function validateStatusMapping(statusMapping) {
  if (
    !statusMapping ||
    typeof statusMapping !== "object" ||
    Array.isArray(statusMapping) ||
    Object.keys(statusMapping).length === 0
  ) {
    throw new AppError("statusMapping is required and must be a non-empty object", 400);
  }

  if (Object.keys(statusMapping).length > MAX_STATUS_MAPPING_ENTRIES) {
    throw new AppError("statusMapping has too many entries", 400);
  }

  // A Map (not a plain object) so a CSV status such as "constructor" or
  // "toString" can never resolve through the prototype chain.
  const normalized = new Map();
  for (const [source, target] of Object.entries(statusMapping)) {
    if (!STAY_STATUSES.includes(target)) {
      throw new AppError(`statusMapping target "${clip(target)}" is not a valid stay status`, 400);
    }
    const key = normalizeStatusKey(source);
    if (key === "" || key.length > MAX_STATUS_TEXT_LENGTH) {
      throw new AppError("statusMapping keys must be non-empty and reasonably short", 400);
    }
    normalized.set(key, target);
  }
  return normalized;
}

/** Resolves one row's raw status text against a validated status mapping. Returns undefined if unmapped. */
export function resolveStatus(normalizedStatusMapping, rawValue) {
  return normalizedStatusMapping.get(normalizeStatusKey(rawValue));
}
