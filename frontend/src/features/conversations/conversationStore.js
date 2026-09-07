const STORAGE_KEY = "koi:conversations";
const STORAGE_VERSION = 1;

export { STORAGE_KEY };

function nowIso() {
  return new Date().toISOString();
}

export function isValidMessage(message) {
  return Boolean(
    message &&
      typeof message === "object" &&
      typeof message.id === "string" &&
      typeof message.role === "string" &&
      typeof message.type === "string",
  );
}

export function sanitizeConversation(item) {
  if (!item || typeof item !== "object") return null;
  if (typeof item.id !== "string" || !item.id) return null;
  if (typeof item.title !== "string") return null;

  const messages = Array.isArray(item.messages) ? item.messages.filter(isValidMessage) : [];

  return {
    id: item.id,
    title: item.title,
    createdAt: typeof item.createdAt === "string" ? item.createdAt : nowIso(),
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : nowIso(),
    messages,
    guestId: item.guestId ?? null,
    stayId: item.stayId ?? null,
    summary: typeof item.summary === "string" ? item.summary : "",
    status: item.status ?? "open",
    origin: item.origin === "seed" ? "seed" : "user",
  };
}

function isEnvelope(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.version === STORAGE_VERSION &&
      Array.isArray(value.items),
  );
}

function writeEnvelope(items) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: STORAGE_VERSION,
      seeded: true,
      items,
    }),
  );
}

export function seedConversations(source) {
  return source.map((item) => sanitizeConversation({ ...item, origin: "seed" })).filter(Boolean);
}

export function loadConversationStore(seedSource = []) {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const seeded = seedConversations(seedSource);
      writeEnvelope(seeded);
      return seeded;
    }

    const parsed = JSON.parse(raw);
    if (!isEnvelope(parsed)) {
      console.warn("[KOI] Ignoring malformed conversation data.");
      writeEnvelope([]);
      return [];
    }

    return parsed.items.map(sanitizeConversation).filter(Boolean);
  } catch (error) {
    console.warn("[KOI] Ignoring unreadable conversation data.", error);
    return [];
  }
}

export function persistConversationStore(items) {
  try {
    writeEnvelope(items.map(sanitizeConversation).filter(Boolean));
  } catch (error) {
    console.warn("[KOI] Could not persist conversations.", error);
  }
}
