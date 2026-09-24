import { parse } from "csv-parse/sync";
import { AppError } from "../../utils/AppError.js";
import {
  assertNoDuplicateHeaders,
  buildDateParser,
  clip,
  mapRow,
  resolveStatus,
  validateMappingProfile,
  validateStatusMapping,
} from "./columnMapping.js";

/**
 * Phase 7F-F2 — pure (no MongoDB, no side effects) row normalization.
 *
 * Everything about a CSV row that can be decided from the row itself —
 * required identifiers, dates, status, guest name, adults/children — lives
 * here so the importer (importService.js) and the dry-run helper
 * (previewCsv below) apply exactly the same rules. Anything needing the
 * database (Unit lookup, existing Guest/Stay) stays in importService.js.
 */

export class RowError extends Error {}

// The only honorifics recognised are the ones present in the evaluation
// dataset. Deterministic and case-insensitive; no other titles, no cultural
// name inference.
const HONORIFICS = new Set(["mr", "mrs", "ms"]);

function parseNonNegativeInt(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  if (!/^\d{1,4}$/.test(value)) {
    throw new RowError(`Invalid ${label} value`);
  }
  return Number(value);
}

/**
 * "Mr. Alpha Testone" -> { firstName: "Alpha", lastName: "Testone" }.
 * Rule: drop ONE leading honorific token (Mr/Mrs/Ms, optional trailing
 * period), then the first remaining whitespace-separated token is the
 * firstName and everything after it (joined by single spaces) is the
 * lastName. A single remaining token yields a firstName only. Nothing left
 * after the honorific is an invalid value.
 */
export function splitFullName(value) {
  const tokens = String(value).trim().split(/\s+/).filter(Boolean);
  if (tokens.length > 0 && HONORIFICS.has(tokens[0].replace(/\.$/, "").toLowerCase())) tokens.shift();
  if (tokens.length === 0) throw new RowError("Invalid guest.fullName value");
  const lastName = tokens.slice(1).join(" ");
  return { firstName: tokens[0], ...(lastName ? { lastName } : {}) };
}

/** "2/0" -> { adults: 2, children: 0 }; the profile target name, "stay.adultsChildren", fixes the order. */
export function splitAdultsChildren(value) {
  const match = /^\s*(\d{1,4})\s*\/\s*(\d{1,4})\s*$/.exec(value);
  if (!match) throw new RowError("Invalid stay.adultsChildren value");
  return { adults: Number(match[1]), children: Number(match[2]) };
}

/**
 * A NEW Stay must be fully specified: never silently default the status to
 * the schema's "reserved", and never create a stay without a unit or a date
 * range. (An existing Stay may leave these blank to retain them.)
 */
export function assertNewStayComplete(row) {
  if (!row.status) throw new RowError("Missing required stay.status for a new reservation");
  if (!row.roomNumber) throw new RowError("Missing required stay.roomNumber for a new reservation");
  if (!row.checkIn) throw new RowError("Missing required stay.checkIn for a new reservation");
  if (!row.checkOut) throw new RowError("Missing required stay.checkOut for a new reservation");
}

/**
 * Validates and normalizes one already-mapped row (mapRow output). Returns
 * `{ skipped: true }` for a row that is blank in every mapped column, or the
 * normalized row. Throws RowError for a row that cannot be imported. Check
 * order is part of the behavior (first failure wins).
 */
export function normalizeRow(mapped, { parseDate, statusMapping }) {
  const allBlank = Object.values(mapped).every((value) => value === undefined || value === "");
  if (allBlank) return { skipped: true };

  const reservationId = mapped["stay.reservationId"];
  if (!reservationId) throw new RowError("Missing required stay.reservationId");
  // Optional: a blank/unmapped external id means "identify the guest through
  // the reservation" rather than an error.
  const externalId = mapped["guest.externalId"] || undefined;

  let checkIn;
  if (mapped["stay.checkIn"]) {
    checkIn = parseDate(mapped["stay.checkIn"]);
    if (checkIn === null) throw new RowError("Invalid stay.checkIn date");
  }

  let checkOut;
  if (mapped["stay.checkOut"]) {
    checkOut = parseDate(mapped["stay.checkOut"]);
    if (checkOut === null) throw new RowError("Invalid stay.checkOut date");
  }

  let status;
  if (mapped["stay.status"]) {
    status = resolveStatus(statusMapping, mapped["stay.status"]);
    if (status === undefined) {
      throw new RowError(`Unknown status value: "${clip(mapped["stay.status"])}"`);
    }
  }

  // Guest fields: non-empty values only, so a blank cell never erases
  // previously-known data. (fullName and firstName/lastName are mutually
  // exclusive in a profile, enforced by validateMappingProfile.)
  const guest = {};
  if (mapped["guest.fullName"]) Object.assign(guest, splitFullName(mapped["guest.fullName"]));
  for (const [target, field] of [
    ["guest.firstName", "firstName"],
    ["guest.lastName", "lastName"],
    ["guest.email", "email"],
    ["guest.phone", "phone"],
  ]) {
    if (mapped[target]) guest[field] = mapped[target];
  }

  let adults;
  let children;
  if (mapped["stay.adultsChildren"]) {
    ({ adults, children } = splitAdultsChildren(mapped["stay.adultsChildren"]));
  } else {
    adults = parseNonNegativeInt(mapped["stay.adults"], "stay.adults");
    children = parseNonNegativeInt(mapped["stay.children"], "stay.children");
  }

  return {
    reservationId,
    externalId,
    roomNumber: mapped["stay.roomNumber"] || undefined,
    guest,
    checkIn,
    checkOut,
    status,
    adults,
    children,
  };
}

/**
 * Pure dry-run of the whole file-to-payload transformation: no MongoDB, no
 * Unit lookup, no Guest/Stay/ImportBatch writes. Every row is treated as a
 * NEW reservation (the strictest case). Whether a room number resolves to
 * an existing Unit is the one thing it cannot know — that needs the database.
 */
export function previewCsv({ buffer, mappingProfile: rawMappingProfile, dateFormat, statusMapping: rawStatusMapping, timeZone = "UTC" }) {
  const headerRow = parse(buffer, { bom: true, trim: true, to_line: 1 })[0];
  if (!headerRow || headerRow.length === 0) throw new AppError("CSV file has no header row", 400);
  assertNoDuplicateHeaders(headerRow);
  const mappingProfile = validateMappingProfile(rawMappingProfile, headerRow);
  const parseDate = buildDateParser(dateFormat, timeZone);
  const statusMapping = validateStatusMapping(rawStatusMapping);
  const rows = parse(buffer, { columns: true, bom: true, trim: true, skip_empty_lines: true });

  const results = [];
  const warnings = [];
  const seen = new Map();
  rows.forEach((rawRow, index) => {
    const rowNumber = index + 2;
    try {
      const normalized = normalizeRow(mapRow(rawRow, mappingProfile), { parseDate, statusMapping });
      if (normalized.skipped) {
        results.push({ row: rowNumber, valid: false, error: "Row is blank in every mapped column (would be skipped)" });
        return;
      }
      assertNewStayComplete(normalized);
      if (!normalized.externalId && Object.keys(normalized.guest).length === 0) {
        throw new RowError("Missing guest details for a new reservation without guest.externalId");
      }
      if (normalized.checkOut <= normalized.checkIn) throw new RowError("checkOut must be after checkIn");
      if (seen.has(normalized.reservationId)) {
        warnings.push(`Row ${rowNumber}: duplicate reservationId "${clip(normalized.reservationId)}" (also row ${seen.get(normalized.reservationId)})`);
      }
      seen.set(normalized.reservationId, rowNumber);
      results.push({
        row: rowNumber,
        valid: true,
        payload: {
          reservationId: normalized.reservationId,
          guestExternalId: normalized.externalId ?? null,
          guest: normalized.guest,
          roomNumber: normalized.roomNumber,
          checkIn: normalized.checkIn.toISOString(),
          checkOut: normalized.checkOut.toISOString(),
          status: normalized.status,
          adults: normalized.adults,
          children: normalized.children,
        },
      });
    } catch (error) {
      if (!(error instanceof RowError)) throw error;
      results.push({ row: rowNumber, valid: false, error: error.message });
    }
  });

  const consumed = new Set(Object.values(mappingProfile).map((column) => column.toLowerCase()));
  return {
    rowsExamined: rows.length,
    rowsValid: results.filter((r) => r.valid).length,
    rowsInvalid: results.filter((r) => !r.valid).length,
    mappedColumns: mappingProfile,
    unresolvedColumns: headerRow.filter((column) => !consumed.has(String(column).trim().toLowerCase())),
    warnings,
    rows: results,
  };
}
