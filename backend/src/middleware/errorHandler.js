import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";
import { duplicateKeyMessage, isDuplicateKeyError } from "../services/queryHelpers.js";

export function errorHandler(err, _req, res, _next) {
  let statusCode = Number(err.statusCode) || Number(err.status) || 500;
  let message = err.message || "Unexpected error";

  if (err.name === "ValidationError") {
    statusCode = 400;
    message =
      Object.values(err.errors || {})
        .map((item) => item.message)
        .join("; ") || "Validation failed";
  } else if (err.name === "CastError") {
    statusCode = 400;
    message = `Invalid ${err.path || "value"}`;
  } else if (isDuplicateKeyError(err)) {
    statusCode = 409;
    message = duplicateKeyMessage(err);
  } else if (!(err instanceof AppError) && statusCode < 400) {
    statusCode = 500;
  }

  const isServerError = statusCode >= 500;

  if (isServerError) {
    console.error("[KOI API]", err);
  }

  res.status(statusCode).json({
    success: false,
    message: isServerError && env.isProduction ? "Internal server error" : message,
    // Phase 7F-D2 follow-up: `details` is an explicit, opt-in field a
    // throwing call site sets deliberately (e.g. AppError's own optional
    // 3rd constructor argument) — unlike `message`, it is never masked for
    // a production 5xx, since by construction it only ever holds something
    // the throwing code already decided was safe to expose (e.g. a
    // resource id the caller's own request just created), never a raw
    // provider error, stack trace, or secret.
    ...(err.details !== undefined ? { details: err.details } : {}),
    ...(env.isProduction || !err.stack ? {} : { stack: err.stack }),
  });
}
