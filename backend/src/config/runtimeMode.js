/**
 * The runtime mode, FAIL CLOSED (Phase 21).
 *
 * Development conveniences (the development token verifier, the dev knowledge-level fallback, error `debug` details)
 * require an EXPLICIT `NODE_ENV=development` or `NODE_ENV=test`. Production refuses them. An UNSET or UNRECOGNISED
 * NODE_ENV is mode "unknown" and is treated like production: it can never silently enable anything meant for development.
 *
 * Read on every call (not cached at import) so tests and tools can set the environment explicitly.
 */
const KNOWN = new Set(["development", "test", "production"]);

export function getRuntimeMode() {
  const raw = (process.env.NODE_ENV ?? "").trim().toLowerCase();
  return KNOWN.has(raw) ? raw : "unknown";
}

export const isProductionMode = () => getRuntimeMode() === "production";

/** True ONLY for an explicit development or test environment. */
export const isDevelopmentOrTestMode = () => {
  const mode = getRuntimeMode();
  return mode === "development" || mode === "test";
};
