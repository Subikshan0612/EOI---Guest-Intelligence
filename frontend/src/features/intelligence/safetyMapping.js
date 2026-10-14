/**
 * Phase 43B.1 - the validated safety result, as the API returns it, carried to the UI unchanged.
 *
 * Node decides it (safetyPolicy.js) and stores it on the Intelligence record only after the analysis passed validation; the browser merely carries it.
 * Nothing here interprets, ranks, defaults or derives anything, and nothing reads prose:
 *   null  = no safety result was recorded (a record from before this field existed, or a payload without it). That is NOT "normal" and must never
 *           be presented as safe or as an emergency - a later UI phase must treat it as "unknown".
 *   state / urgency / recommendedActionType are passed through exactly as the server sent them (strings); an absent one is null. Whether a value is
 *   one the UI knows how to render is that later phase's decision (an unknown value must be shown as unknown, never reinterpreted).
 */
export function mapSafety(safety) {
  if (!safety || typeof safety !== "object" || typeof safety.state !== "string" || safety.state === "") return null;
  // `rules`: the policy rule codes the server stored with the result (for example ACCESS_REFUSED), passed through as strings; absent when the server sent none.
  const rules = Array.isArray(safety.rules) ? safety.rules.filter((rule) => typeof rule === "string" && rule !== "") : [];
  return {
    state: safety.state,
    urgency: typeof safety.urgency === "string" && safety.urgency !== "" ? safety.urgency : null,
    recommendedActionType: typeof safety.recommendedActionType === "string" && safety.recommendedActionType !== "" ? safety.recommendedActionType : null,
    ...(rules.length ? { rules } : {}),
  };
}
