import { ACTION_TYPES } from "../models/Action.js";
import { AppError } from "../utils/AppError.js";

/**
 * Learning context contract (Phase 32) - the ONLY shape of Learning V1 data that may cross the Node ->
 * AI-service boundary for Intelligence V1, mirroring operationalContextContract.js's own pattern exactly
 * (pure, no I/O, allowlist-only, `project` to build / `assertShape` to verify, fail closed).
 *
 * This is deliberately a SMALL, bounded, purely numeric/enum summary - never a raw Outcome, never an id,
 * never a timestamp, never free text. See backend/docs/LEARNING_INTELLIGENCE_PHASE32.md §3-4 for why: the
 * model must receive historical AGGREGATE STATISTICS it can treat as bounded context, never anything that
 * could be read as an instruction, a database handle, or a fact about the CURRENT Signal.
 *
 * A field that is not listed here cannot reach the model, whatever Phase 31's own API response carries.
 * Adding a field is a deliberate, reviewed edit of this file.
 */

export const LEARNING_CONTEXT_CONTRACT_VERSION = "learning-v1";

export const LEARNING_CONTEXT_LIMITS = Object.freeze({
  // Exactly Phase 29's closed ACTION_TYPES enum length - a small, fixed, server-controlled set (see §17 of
  // the Phase 32 spec: "include the complete small closed action-type set" rather than attempt relevance
  // selection, which would require either client input or an LLM doing the selecting - both rejected).
  maxPatterns: 5,
});

const L = LEARNING_CONTEXT_LIMITS;

// Phase 29's own closed enum - an actionType outside this set is rejected, never silently widened or coerced.
const enumOf = (values) => ({ kind: "enum", values: new Set(values), nullable: false });
const int = (nullable = false) => ({ kind: "int", nullable, min: 0 });
const bool = { kind: "bool", nullable: false };
const rate = { kind: "rate", nullable: true }; // a float in [0,1], or null when undetermined (Phase 31 semantics)

const obj = (fields, { required = [], nullable = false } = {}) => ({ kind: "object", fields, required, nullable });
const arr = (item, max) => ({ kind: "array", item, max, nullable: false });

// Exactly the fields a Learning pattern may carry. No actionId/patternKey/firstObservedAt/lastObservedAt/
// sourceOutcomeCount - none of those are "specifically needed" by the model (Phase 32 spec §3), and omitting
// them keeps this payload free of anything that could be mistaken for a database reference or a timestamp
// signal about the CURRENT case.
export const LEARNING_PATTERN_SHAPE = obj(
  {
    actionType: enumOf(ACTION_TYPES),
    sampleSize: int(false), // == Phase 31's determinedOutcomeCount: unknown outcomes already excluded
    successCount: int(false),
    failedCount: int(false),
    partialCount: int(false),
    successRate: rate, // never called "confidence" - see learningContextService.js
    eligible: bool, // sampleSize >= minimumSampleSize (Phase 31's own threshold, carried through unchanged)
  },
  { required: ["actionType", "sampleSize", "successCount", "failedCount", "partialCount", "successRate", "eligible"] },
);

export const LEARNING_CONTEXT_SHAPE = obj(
  {
    learningVersion: { kind: "literal", value: LEARNING_CONTEXT_CONTRACT_VERSION, nullable: false },
    minimumSampleSize: int(false),
    windowDays: int(false),
    patterns: arr(LEARNING_PATTERN_SHAPE, L.maxPatterns),
  },
  { required: ["learningVersion", "minimumSampleSize", "windowDays", "patterns"] },
);

const INVALID_MESSAGE = "Learning context could not be prepared safely. Intelligence was not generated.";

function fail(reason) {
  // The reason names a path and a rule, never a value: it must not become a data leak in a log.
  console.error("[KOI API] Learning context contract violation:", reason);
  return new AppError(INVALID_MESSAGE, 500);
}

/** BUILD: keeps only the keys `shape` allows; never adds or widens. Mirrors operationalContextContract.project. */
export function project(value, shape) {
  if (value === null || value === undefined) return shape.nullable ? null : undefined;
  switch (shape.kind) {
    case "string":
      return typeof value === "string" && value.length <= shape.max ? value : undefined;
    case "int":
      return Number.isInteger(value) && value >= (shape.min ?? -Infinity) ? value : undefined;
    case "bool":
      return typeof value === "boolean" ? value : undefined;
    case "enum":
      return typeof value === "string" && shape.values.has(value) ? value : undefined;
    case "rate":
      return value === null ? null : typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
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

/** VERIFY: throws (fail closed) unless `value` matches `shape` exactly. Mirrors operationalContextContract.assertShape. */
export function assertShape(value, shape, path = "$") {
  if (value === null) {
    if (shape.nullable) return;
    throw fail(`${path}: null is not allowed`);
  }
  if (value === undefined) throw fail(`${path}: missing`);
  switch (shape.kind) {
    case "string":
      if (typeof value !== "string") throw fail(`${path}: expected a string`);
      if (value.length > shape.max) throw fail(`${path}: longer than ${shape.max}`);
      return;
    case "int":
      if (!Number.isInteger(value)) throw fail(`${path}: expected an integer`);
      if (value < (shape.min ?? -Infinity)) throw fail(`${path}: must be >= ${shape.min}`);
      return;
    case "bool":
      if (typeof value !== "boolean") throw fail(`${path}: expected a boolean`);
      return;
    case "enum":
      if (typeof value !== "string" || !shape.values.has(value)) throw fail(`${path}: not one of the closed enum values`);
      return;
    case "rate":
      if (value === null) return;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw fail(`${path}: expected null or a number in [0,1]`);
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
 * The single gate before a Learning context leaves Node: strict shape, bounded pattern count.
 * @returns the same payload (never a modified copy) when valid; throws AppError(500) otherwise.
 */
export function validateLearningPayload(learning) {
  assertShape(learning, LEARNING_CONTEXT_SHAPE, "learning");
  return learning;
}
