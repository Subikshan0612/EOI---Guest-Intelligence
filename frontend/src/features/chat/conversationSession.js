export function createLocalId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function titleFromContent(content) {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length <= 48) return compact;
  return `${compact.slice(0, 45).trim()}…`;
}

export function cloneConversation(seed) {
  const now = new Date().toISOString();

  if (!seed) {
    return {
      id: createLocalId("convo"),
      title: "New intelligence",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }

  return {
    id: seed.id,
    title: seed.title,
    createdAt: seed.createdAt,
    updatedAt: seed.updatedAt,
    guestId: seed.guestId ?? null,
    stayId: seed.stayId ?? null,
    summary: seed.summary ?? "",
    status: seed.status ?? "open",
    messages: (seed.messages ?? []).map((message) => ({ ...message })),
  };
}
