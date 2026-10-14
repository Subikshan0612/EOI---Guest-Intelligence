import { isValidRole, knowledgeCeilingForRole } from "../auth/roles.js";
import { isDevelopmentOrTestMode } from "../config/runtimeMode.js";
import { isValidVisibility } from "../services/knowledge/visibility.js";

/**
 * The ONE place that decides which knowledge visibility level a request is
 * authorized to see. Every knowledge-reading endpoint asks this function;
 * nothing reads a level from a request body, query string, or header - a
 * caller can never name their own level.
 *
 * Two sources, in this order:
 *
 *  1. An AUTHENTICATED ACTOR (req.actor, produced only by auth/authenticate.js
 *     + auth/membership.js). Its level is the CEILING OF ITS ROLE
 *     (auth/roles.js: viewer -> guest, operator/reviewer -> staff,
 *     admin -> restricted). An actor with no valid workspace role gets the
 *     lowest level. The actor always wins, even over the fallback below.
 *
 *  2. The DEVELOPMENT FALLBACK, for requests with no actor (which is every
 *     request until later phases enforce authentication on the routes):
 *     KNOWLEDGE_DEV_AUTHORIZED_LEVEL from the SERVER's environment, default
 *     "guest".
 *
 * !!! THE FALLBACK IS NOT AUTHENTICATION !!!
 * It has no identity, is read from the server's environment, and applies to
 * EVERY caller of the process alike, so it is not an authorization boundary
 * between users. It exists only so development and the existing test suites keep
 * working. It is IGNORED when NODE_ENV=production (the lowest level is used), so
 * it can never silently become production authentication.
 *
 * Read on every call (not cached at import) so a test harness can start servers
 * at different levels. Every invalid value fails closed to "guest".
 */
let warnedProductionFallback = false;

export function getAuthorizedKnowledgeLevel(req) {
  const actor = req?.actor;
  if (actor) return isValidRole(actor.role) ? knowledgeCeilingForRole(actor.role) : "guest";

  const configured = (process.env.KNOWLEDGE_DEV_AUTHORIZED_LEVEL || "").trim();
  if (!isDevelopmentOrTestMode()) {
    if (configured && !warnedProductionFallback) {
      warnedProductionFallback = true;
      console.warn("[KOI] KNOWLEDGE_DEV_AUTHORIZED_LEVEL is ignored outside an explicit development/test NODE_ENV; unauthenticated requests get the lowest level.");
    }
    return "guest";
  }
  return isValidVisibility(configured) ? configured : "guest";
}
