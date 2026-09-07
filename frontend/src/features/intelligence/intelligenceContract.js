/**
 * KOI intelligence contract
 *
 * Frontend components should render this contract, not a vendor-specific
 * model payload. The future KOI Intelligence Service can swap Anthropic,
 * OpenAI, Gemini, or an internal model without changing these shapes.
 *
 * Flow:
 *   User Signal
 *     → KOI Intelligence Service
 *       → Structured Intelligence Response
 *         → Frontend cards
 *
 * Render with composable cards rather than a single AIResponse component:
 *   SignalCard, ContextCard, IntelligenceCard, RiskIndicator,
 *   DecisionCard, ActionCard, OutcomeCard
 */

export const INTELLIGENCE_MESSAGE_TYPE = "intelligence";

export const emptyIntelligenceResponse = {
  signal: null,
  context: null,
  intelligence: null,
  risk: null,
  decision: null,
  action: null,
  outcome: null,
};

export function createUserMessage({ id, content, createdAt = new Date().toISOString() }) {
  return {
    id,
    role: "user",
    type: "text",
    createdAt,
    content,
  };
}

export function createIntelligenceMessage({
  id,
  createdAt = new Date().toISOString(),
  signal = null,
  context = null,
  intelligence = null,
  risk = null,
  decision = null,
  action = null,
  outcome = null,
}) {
  return {
    id,
    role: "assistant",
    type: INTELLIGENCE_MESSAGE_TYPE,
    createdAt,
    signal,
    context,
    intelligence,
    risk,
    decision,
    action,
    outcome,
  };
}
