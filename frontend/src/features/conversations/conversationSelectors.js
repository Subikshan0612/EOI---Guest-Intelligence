import { conversations, getConversationById, getLatestIntelligence } from "../../data/mockData";
import { startOfLocalDay } from "../../utils/formatDate";

const DAY_MS = 24 * 60 * 60 * 1000;

export function listConversations() {
  return conversations;
}

export function findConversation(conversationId) {
  return getConversationById(conversationId);
}

export function groupConversationsByRecency(items = listConversations(), now = new Date()) {
  const today = startOfLocalDay(now);
  const yesterday = today - DAY_MS;
  const grouped = {
    Today: [],
    Yesterday: [],
    Older: [],
  };

  items.forEach((conversation) => {
    const stamp = startOfLocalDay(conversation.updatedAt);
    if (Number.isNaN(stamp)) return;
    if (stamp >= today) grouped.Today.push(conversation);
    else if (stamp >= yesterday) grouped.Yesterday.push(conversation);
    else grouped.Older.push(conversation);
  });

  return ["Today", "Yesterday", "Older"]
    .map((label) => ({
      label,
      conversations: grouped[label].sort(
        (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
      ),
    }))
    .filter((group) => group.conversations.length > 0);
}

export { getLatestIntelligence };
