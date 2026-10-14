import { AppError } from "../utils/AppError.js";

/**
 * Operational context contract (Phase 27) - the ONLY shape of operational data that may
 * cross the Node -> AI-service boundary for Intelligence V1.
 *
 * This module is pure: no database, no I/O. It defines
 *   - the limits (records, field lengths, total size),
 *   - an allowlist shape per entity, and
 *   - two operations over those shapes: `project` (build: keep only allowed keys, truncate text,
 *     never widen) and `assertShape` (verify: reject anything unexpected, fail closed).
 *
 * A field that is not listed here cannot reach the model, whatever a future model or service adds
 * to a stored record. Adding a field is a deliberate, reviewed edit of this file.
 */

export const OPERATIONAL_CONTEXT_CONTRACT_VERSION = "operational-context-v1";

export const OPERATIONAL_CONTEXT_LIMITS = Object.freeze({
  // records
  guestRecentStays: 5,
  historySignals: 20,
  historicalIntelligence: 3,
  historicalDecisions: 3,
  // how many Decisions are read before their parent Intelligence is checked for visibility
  decisionCandidateScan: 20,
  // field lengths (characters)
  id: 64,
  signalTitle: 200,
  signalDescription: 2000,
  shortText: 120,
  isoDate: 40,
  historyText: 400,
  // the whole serialized {context, operationalHistory} payload (bytes of UTF-8 JSON)
  totalBytes: 32768,
});

const L = OPERATIONAL_CONTEXT_LIMITS;

const str = (max, nullable = true) => ({ kind: "string", max, nullable });
const int = { kind: "int", nullable: true };
const bool = { kind: "bool", nullable: false };
const id = str(L.id);
const iso = str(L.isoDate);

const obj = (fields, { required = [], nullable = false } = {}) => ({ kind: "object", fields, required, nullable });
const arr = (item, max) => ({ kind: "array", item, max, nullable: false });

// Reservation id is kept (Phase 24: an operational reference the analysis grounds on). Guest name,
// e-mail, phone and any guest/stay free-form metadata are NOT in any shape below.
const STAY_FIELDS = {
  id, available: bool, guestId: id, propertyId: id, unitId: id, reservationId: str(L.shortText),
  checkIn: iso, checkOut: iso, status: str(L.shortText), adults: int, children: int, source: str(L.shortText),
};
const stayShape = obj(STAY_FIELDS, { required: ["available"], nullable: true });

const SIGNAL_FIELDS = {
  id: str(L.id, false), type: str(L.shortText, false), source: str(L.shortText, false),
  severity: str(L.shortText, false), status: str(L.shortText, false),
  title: str(L.signalTitle, false), description: str(L.signalDescription),
  occurredAt: iso, detectedAt: iso, propertyId: id, unitId: id, guestId: id, stayId: id,
};

// Guest: ONLY id, availability and the guest's recent stays (Phase 24 allowlist).
const guestShape = obj(
  { id, available: bool, recentStays: arr(obj(STAY_FIELDS, { required: ["available"] }), L.guestRecentStays) },
  { required: ["available"], nullable: true },
);

// Property address, timestamps of the record (createdAt/updatedAt) and any other stored field are excluded.
const propertyShape = obj(
  { id, available: bool, name: str(L.shortText), code: str(L.shortText), timezone: str(L.shortText), status: str(L.shortText) },
  { required: ["available"], nullable: true },
);

const unitShape = obj(
  { id, available: bool, unitNumber: str(L.shortText), type: str(L.shortText), status: str(L.shortText), propertyId: id },
  { required: ["available"], nullable: true },
);

const historySignalShape = obj(
  {
    id: str(L.id, false), type: str(L.shortText, false), severity: str(L.shortText, false), status: str(L.shortText, false),
    title: str(L.signalTitle, false), occurredAt: iso, matchedBy: arr(str(16, false), 4),
  },
  { required: ["id", "type", "severity", "status", "title", "matchedBy"] },
);

// Phase 52: where the operator's report conflicts with a current record, derived by the SERVER (reportConflicts.js) - never by the model. Absent when there is no conflict.
const reportCheckShape = obj({ kind: str(40, false), reported: str(L.shortText, false), recorded: str(L.shortText, false) }, { required: ["kind", "reported", "recorded"] });

export const CONTEXT_SHAPE = obj(
  {
    signal: obj(SIGNAL_FIELDS, { required: ["id", "type", "source", "severity", "status", "title"] }),
    guest: guestShape,
    stay: stayShape,
    property: propertyShape,
    unit: unitShape,
    history: obj({ signals: arr(historySignalShape, L.historySignals) }, { required: ["signals"] }),
    reportChecks: arr(reportCheckShape, 3),
  },
  { required: ["signal", "history"] },
);

// Historical AI output and reviewed decisions carry no ids other than the related Signal's id: the model
// needs the association, never a database handle for the record itself. No reviewer identity, review note,
// provenance, provider, model or knowledge text is included.
const MATCHED_BY = arr(str(16, false), 4);
export const HISTORICAL_INTELLIGENCE_SHAPE = obj(
  {
    kind: { kind: "literal", value: "prior_ai_analysis", nullable: false },
    signalId: str(L.id, false), matchedBy: MATCHED_BY, recordedAt: iso,
    situation: str(L.historyText, false), recommendation: str(L.historyText, false), confidence: str(16, false),
  },
  { required: ["kind", "signalId", "matchedBy", "situation", "recommendation", "confidence"] },
);
export const HISTORICAL_DECISION_SHAPE = obj(
  {
    kind: { kind: "literal", value: "human_reviewed_decision", nullable: false },
    signalId: str(L.id, false), matchedBy: MATCHED_BY, status: str(16, false), priority: str(16, false),
    description: str(L.historyText, false), reviewedAt: iso,
  },
  { required: ["kind", "signalId", "matchedBy", "status", "priority", "description"] },
);

export const OPERATIONAL_HISTORY_SHAPE = obj(
  {
    contractVersion: { kind: "literal", value: OPERATIONAL_CONTEXT_CONTRACT_VERSION, nullable: false },
    intelligence: arr(HISTORICAL_INTELLIGENCE_SHAPE, L.historicalIntelligence),
    decisions: arr(HISTORICAL_DECISION_SHAPE, L.historicalDecisions),
  },
  { required: ["contractVersion", "intelligence", "decisions"] },
);

const INVALID_MESSAGE = "Operational context could not be prepared safely. Intelligence was not generated.";

function fail(reason) {
  // The reason names a path and a rule, never a value: it must not become a data leak in a log.
  console.error("[KOI API] Operational context contract violation:", reason);
  return new AppError(INVALID_MESSAGE, 500);
}

const codepoints = (value) => Array.from(value);

function truncate(value, max) {
  const chars = codepoints(value);
  if (chars.length <= max) return value;
  return `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * BUILD: a copy of `value` that keeps only the keys `shape` allows, truncates over-long text and drops
 * values of the wrong type. It can only remove or shorten - never add or widen. `assertShape` is the check.
 */
export function project(value, shape) {
  if (value === null || value === undefined) return shape.nullable ? null : undefined;
  switch (shape.kind) {
    case "string":
      return typeof value === "string" ? truncate(value, shape.max) : undefined;
    case "int":
      return Number.isInteger(value) ? value : undefined;
    case "bool":
      return typeof value === "boolean" ? value : undefined;
    case "literal":
      return value === shape.value ? value : undefined;
    case "array":
      return Array.isArray(value) ? value.slice(0, shape.max).map((item) => project(item, shape.item)) : undefined;
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) return undefined;
      const out = {};
      for (const [key, spec] of Object.entries(shape.fields)) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const projected = project(value[key], spec);
        if (projected !== undefined) out[key] = projected;
      }
      return out;
    }
    default:
      return undefined;
  }
}

/** VERIFY: throws (fail closed) unless `value` matches `shape` exactly - unknown keys, wrong types, over-limit. */
export function assertShape(value, shape, path = "$") {
  if (value === null) {
    if (shape.nullable) return;
    throw fail(`${path}: null is not allowed`);
  }
  if (value === undefined) throw fail(`${path}: missing`);
  switch (shape.kind) {
    case "string":
      if (typeof value !== "string") throw fail(`${path}: expected a string`);
      if (codepoints(value).length > shape.max) throw fail(`${path}: longer than ${shape.max}`);
      return;
    case "int":
      if (!Number.isInteger(value)) throw fail(`${path}: expected an integer`);
      return;
    case "bool":
      if (typeof value !== "boolean") throw fail(`${path}: expected a boolean`);
      return;
    case "literal":
      if (value !== shape.value) throw fail(`${path}: unexpected constant`);
      return;
    case "array":
      if (!Array.isArray(value)) throw fail(`${path}: expected an array`);
      if (value.length > shape.max) throw fail(`${path}: more than ${shape.max} items`);
      value.forEach((item, index) => assertShape(item, shape.item, `${path}[${index}]`));
      return;
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) throw fail(`${path}: expected an object`);
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(shape.fields, key)) throw fail(`${path}.${key}: field is not allowed`);
      }
      for (const key of shape.required) {
        if (value[key] === undefined) throw fail(`${path}.${key}: required`);
      }
      for (const [key, spec] of Object.entries(shape.fields)) {
        if (value[key] !== undefined) assertShape(value[key], spec, `${path}.${key}`);
      }
      return;
    }
    default:
      throw fail(`${path}: unknown shape`);
  }
}

/**
 * The single gate before the request leaves Node: strict shape of both parts plus the total size ceiling.
 * @returns the same payload (never a modified copy) when valid; throws AppError(500) otherwise.
 */
export function validateOperationalPayload(payload) {
  if (!payload || typeof payload !== "object") throw fail("$: payload missing");
  const extra = Object.keys(payload).filter((key) => key !== "context" && key !== "operationalHistory");
  if (extra.length) throw fail(`$.${extra[0]}: field is not allowed`);
  assertShape(payload.context, CONTEXT_SHAPE, "context");
  assertShape(payload.operationalHistory, OPERATIONAL_HISTORY_SHAPE, "operationalHistory");
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (bytes > L.totalBytes) throw fail(`$: ${bytes} bytes exceeds ${L.totalBytes}`);
  return payload;
}
