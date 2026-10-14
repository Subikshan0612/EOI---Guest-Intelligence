import express from "express";
import { getJsonBodyLimit } from "../config/runtimeConfig.js";
import { aiWorkspaceLimiter, identityLimiters } from "../middleware/rateLimit.js";
import { AppError } from "../utils/AppError.js";
import { authenticate } from "./authenticate.js";
import { requireWorkspaceMembership } from "./membership.js";
import { PERMISSIONS, hasPermission, isValidRole } from "./roles.js";

/**
 * Authorization: workspace membership -> role -> permission.
 *
 *   authenticate            who is calling            (authenticate.js)
 *   requireWorkspaceMembership  in which workspace, as what role   (membership.js)
 *   requirePermission       may this role do this     (here)
 *
 * The permission comes ONLY from the server-side role map (roles.js) applied to
 * the role on the actor's ACTIVE membership. Nothing a caller sends - a header,
 * a query parameter, a body field or a token claim - can name a role or a
 * permission. Knowledge visibility (what data the actor may READ) is a separate
 * check made by the existing visibility helpers; passing one never implies the
 * other.
 */

/** True when the workspace-resolved actor's role grants `permission`. Fails closed. */
export function actorHasPermission(actor, permission) {
  return Boolean(actor && actor.workspaceId && isValidRole(actor.role) && hasPermission(actor.role, permission));
}

/**
 * Middleware: 403 unless the actor's role grants `permission`. Must run after
 * `requireWorkspaceMembership`. A misspelt permission is a programming error and
 * fails when the route is defined, not silently at request time.
 */
export function requirePermission(permission) {
  if (!PERMISSIONS.includes(permission)) throw new Error(`Unknown permission: ${permission}`);

  return function permissionGate(req, _res, next) {
    const actor = req.actor;
    if (!actor || !actor.userId) return next(new AppError("Authentication is required", 401, { code: "MISSING_CREDENTIAL" }));
    if (!actor.workspaceId) return next(new AppError("A workspace must be selected", 403, { code: "WORKSPACE_NOT_RESOLVED" }));
    if (!actorHasPermission(actor, permission)) {
      return next(new AppError("You do not have permission to do this", 403, { code: "FORBIDDEN", permission }));
    }
    return next();
  };
}

/**
 * The standard chain for a workspace-scoped, permissioned route:
 *   authenticate -> active membership of the requested workspace -> permission.
 * `getWorkspaceId` says where the (untrusted) workspace SELECTION lives; the
 * default is the existing `?workspaceId=` query convention.
 */
export function requireAccess(permission, getWorkspaceId, { tier = "standard" } = {}) {
  // ORDER (Phase 21): authenticate -> identity rate limits -> JSON body parser -> membership -> permission [-> workspace AI limit].
  // The JSON body is parsed only for an AUTHENTICATED, not-yet-rate-limited caller (membership may read a body-supplied
  // workspace selector, so the parser must run before it, but never before authentication).
  const chain = [authenticate, ...identityLimiters({ tier }), jsonBody(), requireWorkspaceMembership(getWorkspaceId), requirePermission(permission)];
  if (tier === "ai") chain.push(aiWorkspaceLimiter);
  return chain;
}

/** JSON body parser for authenticated routes (size limit configurable; malformed JSON -> 400, oversize -> 413). */
export function jsonBody() {
  const parser = express.json({ limit: getJsonBodyLimit(), strict: true });
  Object.defineProperty(parser, "name", { value: "jsonBody" });
  return parser;
}

/** authenticate + identity rate limits, for routes that do their own body handling (multipart uploads). */
export function authenticatedPrelude({ tier = "standard" } = {}) {
  return [authenticate, ...identityLimiters({ tier })];
}
