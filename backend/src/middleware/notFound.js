import { AppError } from "../utils/AppError.js";

// The message is fixed: the requested URL (which may carry ids or query values) is not reflected back.
export function notFoundHandler(_req, _res, next) {
  next(new AppError("Route not found", 404, { code: "ROUTE_NOT_FOUND" }));
}
