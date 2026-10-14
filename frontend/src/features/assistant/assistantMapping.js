import { describeRecurrence } from "./recurrencePresentation";
/**
 * Translation between the conversation REST shapes and what the assistant page renders (Phase 47). Presentation mapping only:
 *   - an id is a React key and a route/query value, NEVER displayed text;
 *   - the server's own words in a failed request are never shown: the page shows the fixed sentence chosen here from the status;
 *   - `metadata.koiIntake` is read ONLY from ASSISTANT messages. A browser can create user messages (with free-form metadata) but never assistant ones
 *     (backend messageService.js), so a user-supplied lookalike can never make the page draw a Signal card.
 */
const OBJECT_ID = /^[0-9a-f]{24}$/i;

export const INTAKE_OUTCOME = Object.freeze({ SIGNAL_CREATED: "signal_created", CLARIFY: "needs_clarification", DECLINED: "declined" });

export function mapMessage(doc) {
  if (!doc || typeof doc !== "object") return null;
  const intake = doc.role === "assistant" && doc.metadata && typeof doc.metadata === "object" ? doc.metadata.koiIntake : null;
  const outcome = intake && Object.values(INTAKE_OUTCOME).includes(intake.outcome) ? intake.outcome : null;
  return {
    id: String(doc._id),
    role: doc.role === "assistant" ? "assistant" : "user",
    content: typeof doc.content === "string" ? doc.content : "",
    createdAt: doc.createdAt ?? null,
    outcome,
    signalId: outcome === INTAKE_OUTCOME.SIGNAL_CREATED && typeof intake.signalId === "string" && OBJECT_ID.test(intake.signalId) ? intake.signalId : null,
    severityStated: outcome === INTAKE_OUTCOME.SIGNAL_CREATED && intake.severityStated === true,
    instructionsIgnored: outcome === INTAKE_OUTCOME.SIGNAL_CREATED && intake.instructionsIgnored === true,
  };
}

export function mapMessages(items) {
  return (Array.isArray(items) ? items : []).map(mapMessage).filter(Boolean);
}

export function mapConversation(doc) {
  if (!doc || typeof doc !== "object") return null;
  return { id: String(doc._id), title: typeof doc.title === "string" && doc.title.trim() ? doc.title.trim() : "Conversation", updatedAt: doc.updatedAt ?? doc.createdAt ?? null };
}

/** The result of one turn: the (possibly new) conversation id and the two stored messages, in display order. */
export function mapTurn(result) {
  const conversation = mapConversation(result?.conversation);
  const messages = [mapMessage(result?.userMessage), mapMessage(result?.assistantMessage)].filter(Boolean);
  if (!conversation || messages.length !== 2) throw new Error("The server returned an unexpected conversation response.");
  return { conversation, messages };
}

/**
 * What the CONTEXT card may honestly say. It lists only what the server's context endpoint actually returned for this Signal, and the knowledge ("operating
 * guidance") only once an analysis has been generated - the retrieval happens inside that explicit generation, so before it nothing is claimed.
 * Titles shown are the human-readable section names the server recorded; no chunk id, score, rule code or evidence reference is ever returned from here.
 */
export function describeContext({ context, contextStatus, intelligence }) {
  const linked = (record) => Boolean(record && record.available);
  const operational = context
    ? [
        { key: "property", label: "Property information", present: linked(context.property) },
        { key: "unit", label: "Room information", present: linked(context.unit) },
        { key: "guest", label: "Guest information", present: linked(context.guest) },
        { key: "stay", label: "Stay information", present: linked(context.stay) },
      ]
    : [];
  const titles = [];
  for (const p of intelligence?.provenance ?? []) {
    const title = (p.section || (Array.isArray(p.sectionPath) ? p.sectionPath[p.sectionPath.length - 1] : "") || "").trim();
    if (title && !titles.includes(title)) titles.push(title);
  }
  const relatedCount = Array.isArray(context?.history?.signals) ? context.history.signals.length : 0;
  return {
    recurrence: describeRecurrence(context?.recurrence),
    contextStatus,
    operational,
    guidance: !intelligence ? { state: "pending", titles: [] } : titles.length > 0 ? { state: "listed", titles: titles.slice(0, 6) } : { state: "none", titles: [] },
    history: { available: relatedCount > 0, count: relatedCount },
  };
}

/** Fixed, user-safe wording for a failed turn (never the server's message, a code, a status or an id). */
export function describeTurnFailure(error) {
  const status = error?.status;
  if (status === 403) return "Your role in this workspace can't record reports. Ask an administrator if you need that access.";
  if (status === 404) return "This conversation is no longer available. Start a new one.";
  if (status === 409) return "This conversation is archived. Start a new one.";
  if (status === 429) return "Too many messages in a short time. Please wait a moment and try again.";
  if (status === 400) return "That message couldn't be recorded. Check it and try again.";
  if (status === 0) return "We couldn't reach EOI. Check your connection and try again.";
  return "We couldn't record that. Please try again.";
}
