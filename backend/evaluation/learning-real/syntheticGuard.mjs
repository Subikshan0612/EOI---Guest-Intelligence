/**
 * Phase 33 §1 — fails closed if the evaluation dataset contains anything that looks like real sensitive
 * data. This is a conservative, pattern-based scan, not a guarantee of perfection - but it is run
 * automatically before ANY real model call, by both the real-evaluation runner and the security suite.
 */
const PATTERNS = [
  { name: "email (non-reserved domain)", re: /[A-Za-z0-9._%+-]+@(?!example\.(com|invalid|test|org)\b)(?!.*\.invalid\b)(?!.*\.test\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: "phone number (7+ consecutive digits, optionally separated)", re: /\b(?:\+?\d[\d\- ]{8,}\d)\b/g },
  { name: "24-hex-char ObjectId-shaped string (possible production database id)", re: /\b[a-f0-9]{24}\b/gi },
  { name: "credential/token/secret-shaped key=value", re: /\b(api[_-]?key|secret|token|password|bearer)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+]{8,}/gi },
  { name: "AWS-style access key", re: /\bAKIA[0-9A-Z]{16}\b/g },
];

const ALLOWLISTED_SUBSTRINGS = ["example.invalid", "example.com", "example.test"];

function scanString(value, path, hits) {
  if (typeof value !== "string") return;
  for (const { name, re } of PATTERNS) {
    const matches = value.match(re);
    if (!matches) continue;
    for (const m of matches) {
      if (ALLOWLISTED_SUBSTRINGS.some((safe) => m.includes(safe))) continue;
      hits.push({ path, pattern: name, matchPreview: m.slice(0, 12) + (m.length > 12 ? "…" : "") });
    }
  }
}

function walk(value, path, hits) {
  if (value === null || value === undefined) return;
  if (typeof value === "string") return scanString(value, path, hits);
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, hits));
    return;
  }
  if (typeof value === "object") {
    for (const [key, v] of Object.entries(value)) walk(v, `${path}.${key}`, hits);
  }
}

/** @returns {{ok: boolean, hits: Array}} never throws - the caller decides whether to fail closed. */
export function scanForSensitiveData(dataset) {
  const hits = [];
  walk(dataset, "$", hits);
  return { ok: hits.length === 0, hits };
}

/** Throws if anything suspicious is found. Call this before every real-model run. */
export function assertSyntheticOnly(dataset) {
  const { ok, hits } = scanForSensitiveData(dataset);
  if (!ok) {
    const preview = hits.slice(0, 5).map((h) => `${h.path}: ${h.pattern} (${h.matchPreview})`).join("; ");
    throw new Error(`Refusing to proceed: dataset may contain real sensitive data - ${hits.length} hit(s): ${preview}`);
  }
}
