import { isDevelopmentOrTestMode } from "./runtimeMode.js";
import { AppError } from "../utils/AppError.js";

/**
 * Approved production provider policy (Phase 34A-B) - Node's side. The single authoritative place in the backend that
 * says which provider/model identity an Intelligence analysis may carry.
 *
 *   APPROVED_PROVIDER = "gemini"
 *   APPROVED_MODEL    = "gemini-3.1-flash-lite"   (exact stable id: no alias, no preview, no 3.6)
 *
 * It mirrors ai-service/app/provider_policy.py (a different process, so the two constants cannot be shared; the Phase 34
 * validation suite asserts they are equal). Node does NOT trust the AI service's self-reported provenance: every analysis
 * is checked against this policy AFTER validation and BEFORE persistence, and a mismatch discards the response.
 *
 * Neither value is ever read from a request: provider and model are server configuration only.
 *
 * Environment sensitivity (deliberate, fail closed):
 *   production / unknown NODE_ENV   only the approved Gemini identity is accepted. The deterministic test provider is NOT.
 *   development / test NODE_ENV     additionally the deterministic stub's own fixed identity (provider "test", model
 *                                   "deterministic-stub"), so the existing local/test harnesses keep working. Nothing else.
 *
 * HONEST SCOPE: this verifies the identity the AI service reports. That identity is produced by the AI service from its
 * validated configuration and, when the Gemini API reports a model version, cross-checked there (ai-service
 * provider_policy.resolve_observed_model). It is not an independent server-side attestation made by Node.
 */
export const APPROVED_PROVIDER = "gemini";
export const APPROVED_MODEL = "gemini-3.1-flash-lite";
export const TEST_PROVENANCE = Object.freeze({ provider: "test", model: "deterministic-stub" });

export const PROVIDER_IDENTITY_MISMATCH_CODE = "PROVIDER_IDENTITY_MISMATCH";

/** A bounded, printable rendering of an untrusted value for a log line. */
function safe(value, limit = 64) {
  const text = typeof value === "string" ? value : typeof value;
  return text.replace(/[^\x20-\x7e]/g, "?").slice(0, limit);
}

/** The exact identities this process accepts, by runtime mode. */
export function acceptedProvenances({ developmentOrTest = isDevelopmentOrTestMode() } = {}) {
  const accepted = [{ provider: APPROVED_PROVIDER, model: APPROVED_MODEL }];
  if (developmentOrTest) accepted.push({ provider: TEST_PROVENANCE.provider, model: TEST_PROVENANCE.model });
  return accepted;
}

/** True only for an exact (provider, model) match - no trimming, no case folding, no prefix or alias matching. */
export function isApprovedProvenance(provenance, options) {
  if (provenance === null || typeof provenance !== "object" || Array.isArray(provenance)) return false;
  if (typeof provenance.provider !== "string" || typeof provenance.model !== "string") return false;
  return acceptedProvenances(options).some((p) => p.provider === provenance.provider && p.model === provenance.model);
}

/**
 * Throws (and the caller must not persist) unless the analysis' provenance is an accepted identity. Logs only safe,
 * bounded metadata. The client-facing message is fixed and names no model.
 */
export function assertApprovedProvenance(provenance, options) {
  if (isApprovedProvenance(provenance, options)) return;
  console.error(
    "[KOI API] AI provider identity rejected: provider=%s model=%s (intelligence was not generated)",
    safe(provenance?.provider),
    safe(provenance?.model),
  );
  throw new AppError("AI service reported an unapproved provider identity. Intelligence was not generated.", 502, {
    code: PROVIDER_IDENTITY_MISMATCH_CODE,
  });
}

/**
 * True only for the deterministic test provider's exact identity AND only in development/test. This is the single
 * condition under which the Phase 34C claim/safety checks run in COMPATIBILITY mode (absent claims / urgency / action type
 * are tolerated; anything present is still validated in full). Everything else - every real-provider response, and every
 * response in production or an unknown NODE_ENV - is validated strictly.
 */
export function isDeterministicTestProvenance(provenance, { developmentOrTest = isDevelopmentOrTestMode() } = {}) {
  return developmentOrTest && provenance?.provider === TEST_PROVENANCE.provider && provenance?.model === TEST_PROVENANCE.model;
}

/**
 * Request-time route check. In production (and an unknown NODE_ENV) Intelligence may only be produced through the real
 * provider route; the explicit deterministic `test-python` route is development/test only.
 */
export function assertProviderRouteAllowed(nodeProvider, { developmentOrTest = isDevelopmentOrTestMode() } = {}) {
  if (nodeProvider === APPROVED_PROVIDER) return;
  if (nodeProvider === "test-python" && developmentOrTest) return;
  throw new AppError("Intelligence analysis is not available with the configured AI provider route.", 503, {
    code: "PROVIDER_ROUTE_NOT_APPROVED",
  });
}
