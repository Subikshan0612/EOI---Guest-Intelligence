/**
 * Translation between the KOI REST shapes and the frontend conversation/message
 * shapes. This is the single service/provider boundary for that mapping — no
 * component should touch `_id`, `metadata`, or backend status strings directly.
 */
import {
  INTELLIGENCE_MESSAGE_TYPE,
  createIntelligenceMessage,
  createUserMessage,
} from "../intelligence/intelligenceContract";

/** metadata key that carries the structured intelligence payload on a Message */
export const INTELLIGENCE_METADATA_KEY = "koiIntelligence";

const INTELLIGENCE_FIELDS = [
  "signal",
  "context",
  "intelligence",
  "risk",
  "decision",
  "action",
  "outcome",
];

function pickIntelligence(source = {}) {
  return INTELLIGENCE_FIELDS.reduce((acc, key) => {
    acc[key] = source[key] ?? null;
    return acc;
  }, {});
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Backend Conversation doc → frontend conversation summary (no messages).
 * `messagesLoaded` tracks whether the message list has been hydrated.
 */
export function mapConversationFromApi(doc) {
  if (!doc) return null;
  const createdAt = doc.createdAt ?? nowIso();
  return {
    id: doc._id,
    title: doc.title || "New Intelligence",
    createdAt,
    updatedAt: doc.updatedAt ?? createdAt,
    status: doc.status === "archived" ? "archived" : "open",
    summary: "",
    origin: "backend",
    guestId: doc.guestId ?? null,
    stayId: doc.stayId ?? null,
    messages: [],
    messagesLoaded: false,
  };
}

/** Backend Message doc → frontend message (user text or intelligence card set). */
export function mapMessageFromApi(doc) {
  if (!doc) return null;
  const type = doc.type || "text";
  if (type === INTELLIGENCE_MESSAGE_TYPE) {
    const payload = doc.metadata?.[INTELLIGENCE_METADATA_KEY] ?? {};
    return createIntelligenceMessage({
      id: doc._id,
      createdAt: doc.createdAt ?? nowIso(),
      ...pickIntelligence(payload),
    });
  }
  return {
    id: doc._id,
    role: doc.role || "user",
    type,
    createdAt: doc.createdAt ?? nowIso(),
    content: doc.content ?? "",
  };
}

/**
 * Frontend message input `{ role, type, content, payload }` → REST body for
 * POST /conversations/:id/messages. Intelligence payloads ride in metadata; a
 * non-empty `content` is always supplied because the backend requires it.
 */
export function toMessageApiPayload(input) {
  if (input.type === INTELLIGENCE_MESSAGE_TYPE) {
    const payload = pickIntelligence(input.payload ?? {});
    const summary = payload.intelligence?.summary?.trim();
    return {
      role: input.role || "assistant",
      type: INTELLIGENCE_MESSAGE_TYPE,
      content: (input.content && input.content.trim()) || summary || "Intelligence response",
      metadata: { [INTELLIGENCE_METADATA_KEY]: payload },
    };
  }
  return {
    role: input.role || "user",
    type: "text",
    content: (input.content ?? "").trim(),
  };
}

/**
 * Optimistic frontend message used while a POST is in flight. Shares the exact
 * shape produced by mapMessageFromApi so the UI renders identically before and
 * after persistence.
 */
export function buildOptimisticMessage(input, id) {
  if (input.type === INTELLIGENCE_MESSAGE_TYPE) {
    return {
      ...createIntelligenceMessage({ id, ...pickIntelligence(input.payload ?? {}) }),
      pending: true,
    };
  }
  return {
    ...createUserMessage({ id, content: input.content ?? "" }),
    pending: true,
  };
}
