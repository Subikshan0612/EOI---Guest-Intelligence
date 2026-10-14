import { assembleSignalContext } from "./signalContextService.js";

/**
 * Intelligence V1 - context builder.
 *
 * Reuses the existing deterministic, workspace-scoped assembly
 * (signalContextService.js): Signal, Guest, Stay, Property, Unit and recent
 * related Signals, read straight from the database, never inferred. A
 * relationship that is not stored is simply absent (`null`); a stored
 * reference that cannot be resolved inside the workspace is reported as
 * `available: false` - it is never matched by name or fuzzily.
 *
 * On top of that, this builds the context that may be sent to the language
 * model, which must not carry what the analysis does not need: a guest's
 * personal details (name, email, phone) are removed here, at the boundary,
 * so they can never reach a prompt. Operational identifiers and recorded
 * facts (stay id, reservation id, dates, status, unit, property) are kept.
 * Nothing is persisted and nothing is written - the context is recomputed
 * from the source collections each time.
 */

// DATA MINIMIZATION (Phase 24): an ALLOWLIST of the guest facts the analysis may see, so a personal field
// added to the guest context later can never reach a prompt by default.
//   id, available   REQUIRED   the link to the stored record and whether it resolved
//   recentStays     REQUIRED   the guest's stay history (reservation id, dates, recorded status, unit): operational facts
//   firstName, lastName   UNNECESSARY   the analysis reasons about "the guest" and never needs a name
//   email, phone          UNNECESSARY   contact details have no analytical use; only a documented, tested need could justify them
// (Free text typed into a Signal's title/description is not altered: it is the recorded operational fact.)
const GUEST_FIELDS_ALLOWED_FOR_ANALYSIS = new Set(["id", "available", "recentStays"]);

/** A copy of an assembled context without fields the analysis must not see. */
export function sanitizeAnalysisContext(context) {
  const copy = JSON.parse(JSON.stringify(context));
  if (copy.guest) {
    for (const field of Object.keys(copy.guest)) {
      if (!GUEST_FIELDS_ALLOWED_FOR_ANALYSIS.has(field)) delete copy.guest[field];
    }
  }
  return copy;
}

export async function buildAnalysisContext(signalId, workspaceId) {
  return sanitizeAnalysisContext(await assembleSignalContext(signalId, workspaceId));
}
