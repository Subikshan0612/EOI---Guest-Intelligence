function unitSuffix(text) {
  const match = text.match(/\b(?:apartment|apt\.?|unit|room)\s*([a-z]?\d+[a-z]?)\b/i);
  if (!match) return "";

  const kind = /apartment|apt/i.test(match[0]) ? "Apartment" : "Unit";
  return ` — ${kind} ${match[1].toUpperCase()}`;
}

function truncateTitle(text, max = 42) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;

  const sliced = compact.slice(0, max);
  const boundary = sliced.lastIndexOf(" ");
  return `${(boundary > 18 ? sliced.slice(0, boundary) : sliced).trim()}…`;
}

export function generateConversationTitle(content) {
  const text = content.replace(/\s+/g, " ").trim();
  if (!text) return "New Intelligence";

  const lower = text.toLowerCase();
  const place = unitSuffix(text);

  if (/\btowel/.test(lower)) return "Extra towels request";
  if (/late checkout|check out late|checkout late|late check-?out/.test(lower)) {
    return "Late checkout request";
  }
  if (/ac\b|air.?con|cooling|warm air|hvac/.test(lower)) return `AC issue${place}`;
  if (/housekeep/.test(lower)) return `Housekeeping${place}`;
  if (/\bcrib\b/.test(lower)) return "Crib request";
  if (/noise|loud/.test(lower)) return `Noise complaint${place}`;
  if (/complain|complaint/.test(lower)) return `Guest complaint${place}`;
  if (/reserv|booking|check-?in/.test(lower)) return "Reservation issue";

  return truncateTitle(text);
}
