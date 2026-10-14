import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";
import { isDuplicateKeyError } from "../services/queryHelpers.js";
import { logEvent, redactRoute } from "../utils/logEvent.js";

/**
 * The single error-response strategy (Phase 20). FAIL CLOSED.
 *
 * Contract (unchanged shape): `{ success: false, message, details? }`.
 *   - `message` is either a message a developer AUTHORED on purpose (AppError), or a fixed generic string chosen here.
 *     It is NEVER an exception's own text, so it cannot carry stack frames, file paths, Mongo/Mongoose/driver text,
 *     collection names or schema paths.
 *   - `details` is opt-in on an AppError (e.g. `{ code: "FORBIDDEN" }`) and gets a stable `code` on every mapped error.
 *   - `debug` (name, original message, stack) appears ONLY when KOI_EXPOSE_ERROR_DETAILS=true AND NODE_ENV is not
 *     production. Being "not production" alone exposes nothing, and an omitted variable means "hidden".
 *
 * Statuses are preserved: 400 validation, 401 authentication, 403 permission, 404 hidden/not found, 409 conflict, 413 body
 * too large, 502/503/504 downstream AI/service failures (their AppError messages are authored and safe).
 * Anything unrecognised is a 500 "Internal server error"; the real error is logged SERVER-SIDE only.
 */

const DOWNSTREAM_STATUSES = new Set([502, 503, 504]);

function mapUnknown(err) {
  if (err?.type === "entity.parse.failed") return { status: 400, message: "Malformed JSON body", code: "MALFORMED_JSON" };
  if (err?.type === "entity.too.large") return { status: 413, message: "Request body is too large", code: "PAYLOAD_TOO_LARGE" };
  if (err?.name === "ValidationError") return { status: 400, message: "The request contains invalid or missing values", code: "VALIDATION_ERROR" };
  if (err?.name === "CastError") return { status: 400, message: "The request contains an invalid value", code: "INVALID_VALUE" };
  if (isDuplicateKeyError(err)) return { status: 409, message: "Duplicate value violates a unique constraint", code: "DUPLICATE_VALUE" };
  const status = Number(err?.statusCode) || Number(err?.status);
  if (status >= 400 && status < 500) {
    const generic = { 400: "Bad request", 404: "Not found", 405: "Method not allowed", 413: "Request body is too large", 415: "Unsupported media type" };
    return { status, message: generic[status] ?? "Request could not be processed", code: "REQUEST_ERROR" };
  }
  return { status: 500, message: "Internal server error", code: "INTERNAL_ERROR" };
}

const GOVERNANCE_CODES = new Set(["SEPARATION_OF_DUTIES", "PROPOSER_UNKNOWN"]);

export function errorHandler(err, _req, res, _next) {
  let status;
  let message;
  let details;

  if (err instanceof AppError) {
    status = Number(err.statusCode) || 500;
    // An AppError message is authored on purpose. 5xx are masked unless they are the downstream (AI/service) statuses.
    const masked = status >= 500 && !DOWNSTREAM_STATUSES.has(status);
    message = masked ? "Internal server error" : err.message;
    details = masked ? { code: "INTERNAL_ERROR" } : err.details;
  } else {
    const mapped = mapUnknown(err);
    status = mapped.status;
    message = mapped.message;
    details = { code: mapped.code };
  }

  // Phase 36: authentication/authorization denials and governance refusals leave a structured, content-free event (codes, status and a
  // redacted route only - never ids, tokens, headers or request content), so an operator can see them without reading anything sensitive.
  const code = details?.code;
  if (status === 401 || status === 403 || GOVERNANCE_CODES.has(code)) {
    logEvent(GOVERNANCE_CODES.has(code) ? "governance.rejected" : "authz.denied", {
      requestId: _req?.requestId, httpStatus: status, code, permission: details?.permission, method: _req?.method, route: redactRoute(_req?.originalUrl),
    });
  }

  if (status >= 500) {
    // Server-side only: the stack never leaves the process.
    console.error("[KOI API]", err);
  }

  res.status(status).json({
    success: false,
    message,
    ...(details !== undefined ? { details } : {}),
    ...(env.exposeErrorDetails ? { debug: { name: err?.name, message: err?.message, stack: err?.stack } } : {}),
  });
}
