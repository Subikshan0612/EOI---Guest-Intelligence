const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfLocalDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function formatShortDate(iso) {
  if (!iso) return "";

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatStayDate(iso) {
  if (!iso) return "";

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
  }).format(new Date(iso));
}

export function formatConversationMeta(iso, now = new Date()) {
  if (!iso) return "";

  const date = new Date(iso);
  const today = startOfLocalDay(now);
  const then = startOfLocalDay(date);

  if (then === today) {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  if (then === today - DAY_MS) {
    return "Yesterday";
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
  }).format(date);
}

export function nightsBetween(checkIn, checkOut) {
  if (!checkIn || !checkOut) return null;

  const nights = Math.round((new Date(checkOut) - new Date(checkIn)) / DAY_MS);
  return nights > 0 ? nights : null;
}

export function greetingForNow(now = new Date()) {
  const hour = now.getHours();
  if (hour < 12) return "Good morning.";
  if (hour < 17) return "Good afternoon.";
  return "Good evening.";
}
