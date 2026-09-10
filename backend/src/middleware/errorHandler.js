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
    ...(env.isProduction || !err.stack ? {} : { stack: err.stack }),
  });
}
