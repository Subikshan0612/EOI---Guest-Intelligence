import { randomUUID } from "node:crypto";

/**
 * Request correlation id (Phase 36). The smallest safe mechanism: one random uuid per request, exposed as `req.requestId` and the
 * `X-Request-Id` response header, and carried by structured events (utils/logEvent.js).
 *
 * A caller-supplied `X-Request-Id` is honoured ONLY when it is itself a canonical uuid; anything else is ignored and replaced, so a
 * client cannot inject free text, a workspace/user id or a log-forging string into the log stream. The id contains no workspace id,
 * user id or content. It is not an authorization input and nothing reads it for any decision.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requestId(req, res, next) {
  const supplied = req.headers["x-request-id"];
  const id = typeof supplied === "string" && UUID.test(supplied) ? supplied.toLowerCase() : randomUUID();
  req.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}
