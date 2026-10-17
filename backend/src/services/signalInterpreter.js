import { AppError } from "../utils/AppError.js";

/**
 * Conversational Signal intake - the interpreter (Phase 47). PURE and DETERMINISTIC: text and the workspace's own reference data in, a decision out.
 * It makes NO model call, reads NO database and has no tool: a chat message can therefore never reach Gemini, never act, and never change anything by itself.
 * (Generation stays the explicit POST /api/intelligence/analyze/:signalId; this module only helps an operator RECORD a Signal.)
 *
 * WHAT IT MAY DO. Extract only what the operator actually wrote, checked against records the server already holds:
 *   - a LOCATION: a unit number the operator wrote ("room 221") that matches a real Unit of this workspace, and/or a property named by its real name or code;
 *   - a TYPE, from a small closed keyword list (never a diagnosis);
 *   - a SEVERITY only when the operator states one in words ("urgent", "critical", "low priority"); otherwise none is claimed;
 *   - the operator's OWN words as the title (first sentence) and description (verbatim).
 * WHAT IT NEVER DOES. Invent a property, room, guest, stay, severity, cause, diagnosis, status or timestamp. A guest or stay is never picked from the words (the intake SERVICE links only a room's single checked-in stay, from its own records).
 * When the location or the event is missing it asks ONE focused question and creates nothing.
 *
 * CHAT IS UNTRUSTED. The text is data. A message that tries to change the workspace, role, permissions, safety rules, instructions or to run an action is
 * recognised by a closed pattern list: with no operational content it is DECLINED with a fixed sentence (nothing is created); inside a genuine event report it is
 * kept as the report's words (which the existing analysis pipeline already treats as UNTRUSTED_SIGNAL content) and is not followed. Authorisation never comes
 * from here: the workspace and role are the server's, decided before this module runs.
 */
export const INTAKE_LIMITS = Object.freeze({ textMax: 1000, titleMax: 120, propertiesMax: 200, unitsMax: 5000, roomTokensMax: 5 });

export const INTAKE_OUTCOME = Object.freeze({ READY: "ready", CLARIFY: "needs_clarification", DECLINED: "declined" });

const DECLINED_MESSAGE =
  "I can't change permissions, workspaces, safety rules or how I work from this conversation, I can't approve or reject decisions, create action proposals or record outcomes here, and I don't carry out actions." +
  "Describe an operational event - what happened and where - and I'll assess it.";

/** Patterns for attempts to steer the assistant instead of reporting an event. Closed list; used only to DECLINE or to annotate - never to grant anything. */
const META_PATTERNS = Object.freeze([
  /\b(?:make|set|promote|grant|give)\s+(?:me|my\s+account|us)\b[^.\n]{0,40}\b(?:admin\w*|owner|role|permissions?|access|manager|operator|reviewer)\b/i,
  /\b(?:switch|change|move|take)\s+(?:me\s+)?(?:over\s+)?(?:to\s+)?(?:an?\s+|the\s+)?(?:another|other|different)\s+(?:workspace|tenant|organi[sz]ation|account)\b/i,
  /\b(?:ignore|disregard|forget|override|bypass|disable|skip)\b[^.\n]{0,50}\b(?:instructions?|rules?|safety|polic(?:y|ies)|guardrails?|restrictions?|approvals?|governance)\b/i,
  /\b(?:reveal|show|print|repeat|display|leak|tell\s+me)\b[^.\n]{0,40}\b(?:system\s+prompt|prompt|instructions?|api\s*keys?|secrets?|environment|credentials?|configuration)\b/i,
  /\b(?:execute|run|perform|dispatch|approve)\b[^.\n]{0,40}\b(?:automatically|without\s+(?:approval|review|asking))\b/i,
  /\b(?:you\s+are\s+now|act\s+as|pretend\s+(?:to\s+be|you)|new\s+instructions?|developer\s+mode)\b/i,
  // Phase 48: a decision is made by a person on the case (Intelligence -> Decision), never through this conversation.
  /\b(?:approve|reject|accept|sign\s*off(?:\s+on)?|authori[sz]e)\b[^.\n]{0,40}\b(?:decisions?|recommendations?|proposals?|actions?|it|this|that)\b/i,
  /\bfor\s+workspace\s+\S+/i,
]);

// Phase 49: an Action proposal follows an APPROVED Decision and is made on the case; it is never created, run or confirmed through this conversation. Unlike the
// patterns above this one declines EVEN IF the message also describes a room and an event: "create an action to dispatch maintenance to room 221" is an
// instruction to the assistant, not a report, and recording it as a Signal would put a command in the operational record.
const ACTION_COMMAND = /\b(?:create|make|propose|raise|open|execute|run|carry\s+out|perform|trigger|start|dispatch|confirm|mark)\b[^.\n]{0,40}\b(?:actions?|action\s+proposals?)\b/i;
// Phase 50: an Outcome is a person's report of what happened to an Action, recorded on the case with the Outcome form - never through this conversation. (A plain
// description of an event, "the guest moved successfully", is still just a report and may become a Signal; it never becomes an Outcome.)
const OUTCOME_COMMAND = /\b(?:record|log|save|submit|create|add|enter|mark|set|close|file)\b[^.\n]{0,40}\boutcomes?\b/i;

const ROOM_TOKEN = /\b(?:room|rm\.?|unit|suite|apartment|apt\.?|flat|villa|cabin)\s*(?:no\.?|number|#)?\s*([A-Za-z]{0,2}\d{1,4}[A-Za-z]?)\b|#\s*(\d{1,4}[A-Za-z]?)\b/gi;

const TYPE_RULES = Object.freeze([
  ["maintenance", /\b(?:a\/c|ac|air[\s-]?con\w*|hvac|heat(?:er|ing)?|cool(?:ing)?|too\s+hot|very\s+hot|freezing|leak\w*|broken|broke|not\s+working|stopped\s+working|doesn'?t\s+work|won'?t\s+(?:turn|start|flush|work|close|open)|fault\w*|repair\w*|plumb\w*|toilet|shower|faucet|drain\w*|clog\w*|blocked|light\s?bulb|bulb|lights?|electric\w*|power\s+(?:cut|outage|failure)|socket|fridge|refrigerator|oven|stove|boiler|water\s+(?:heater|pressure|damage)|lock|key\s*card|door|window|elevator|lift|wi-?fi|internet|tv|television|mou?ld|pest|insect|cockroach|smell\w*|odou?r|gas|smoke|fire|carbon\s+monoxide|flood\w*)\b/i],
  ["housekeeping", /\b(?:towels?|linen|sheets?|bedding|clean\w*|dirty|housekeep\w*|trash|garbage|amenit\w*|toiletries|vacuum\w*|dust\w*|stain\w*)\b/i],
  ["complaint", /\b(?:complain\w*|unhappy|dissatisfied|upset|angry|rude|unacceptable|disappointed|noise|noisy|loud)\b/i],
  ["guest_request", /\b(?:requests?|requested|wants?|wanted|asks?\s+for|asked\s+for|asking\s+for|needs?|needed|would\s+like|extra|late\s+check[\s-]?out|early\s+check[\s-]?in|upgrade|pillow|blanket|crib|taxi)\b/i],
  ["payment", /\b(?:payment|charge[sd]?|bill\w*|invoice|refund\w*|deposit|overcharg\w*)\b/i],
  ["arrival", /\b(?:arriv\w+|checking\s+in|check[\s-]?in)\b/i],
  ["departure", /\b(?:depart\w+|checking\s+out|check[\s-]?out)\b/i],
  ["sentiment", /\b(?:review|feedback|rating|satisf\w+|happy)\b/i],
  ["system", /\b(?:pms|system\s+(?:error|down|outage)|software|integration|sync\w*)\b/i],
]);

const SEVERITY_RULES = Object.freeze([
  ["low", /\b(?:low\s+priority|not\s+urgent|no\s+rush|minor)\b/i],
  ["critical", /\b(?:critical|emergency|life[\s-]threatening)\b/i],
  ["high", /\b(?:urgent(?:ly)?|asap|high\s+priority|serious)\b/i],
]);

const wordCount = (text) => (text.match(/[\p{L}\p{N}']+/gu) ?? []).length;
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalizeUnit = (value) => String(value ?? "").replace(/\s+/g, "").toUpperCase();

/** Bounded, normalised operator text. The text is never trusted; this only makes it safe to store and match. */
export function normalizeIntakeText(value) {
  if (typeof value !== "string") throw new AppError("content must be a string", 400, { code: "INVALID_FIELD", field: "content" });
  const text = value.normalize("NFKC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length === 0) throw new AppError("content is required", 400, { code: "INVALID_FIELD", field: "content" });
  if (text.length > INTAKE_LIMITS.textMax) throw new AppError(`content must be at most ${INTAKE_LIMITS.textMax} characters`, 400, { code: "INVALID_FIELD", field: "content" });
  return text;
}

const hasMeta = (text) => META_PATTERNS.some((pattern) => pattern.test(text));

function roomTokens(text) {
  const tokens = [];
  for (const match of text.matchAll(ROOM_TOKEN)) {
    const token = normalizeUnit(match[1] ?? match[2]);
    if (token && !tokens.includes(token)) tokens.push(token);
    if (tokens.length >= INTAKE_LIMITS.roomTokensMax) break;
  }
  return tokens;
}

/** Properties the operator NAMED (full name, or a code of 3+ characters), as whole words. */
function namedProperties(text, properties) {
  return properties.filter((property) => {
    const name = String(property.name ?? "").trim();
    const code = String(property.code ?? "").trim();
    if (name.length >= 3 && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "iu").test(text)) return true;
    return code.length >= 3 && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(code)}(?![\\p{L}\\p{N}])`, "iu").test(text);
  });
}

/** @returns {{ status: "resolved"|"ambiguous"|"not_found"|"none", propertyId?, unitId?, unitNumber?, propertyName?, token?, candidates?: string[] }} */
function resolveLocation(text, properties, units) {
  const propertyById = new Map(properties.map((p) => [String(p._id), p]));
  const named = namedProperties(text, properties);
  const tokens = roomTokens(text);

  for (const token of tokens) {
    let matches = units.filter((unit) => normalizeUnit(unit.unitNumber) === token && propertyById.has(String(unit.propertyId)));
    if (named.length > 0) matches = matches.filter((unit) => named.some((p) => String(p._id) === String(unit.propertyId)));
    if (matches.length === 1) {
      const property = propertyById.get(String(matches[0].propertyId));
      return { status: "resolved", propertyId: String(property._id), unitId: String(matches[0]._id), unitNumber: matches[0].unitNumber, propertyName: property.name, token };
    }
    if (matches.length > 1) {
      return { status: "ambiguous", token, candidates: [...new Set(matches.map((m) => propertyById.get(String(m.propertyId))?.name).filter(Boolean))].slice(0, 5) };
    }
  }
  if (named.length === 1) return { status: "resolved", propertyId: String(named[0]._id), propertyName: named[0].name, token: tokens[0] };
  if (named.length > 1) return { status: "ambiguous", token: tokens[0], candidates: named.map((p) => p.name).slice(0, 5) };
  if (tokens.length > 0) return { status: "not_found", token: tokens[0] };
  return { status: "none" };
}

/**
 * EXPLICIT operational context. When the operator chose the Property (and optionally the Guest and Stay) BEFORE describing the issue, that choice is AUTHORITATIVE and the
 * words only ever describe the event: the text can neither replace the selected property nor pick a record from another property. The location is therefore taken from the
 * selection - the stay's own unit when a stay was chosen, otherwise a room the operator wrote that is a unit OF THE SELECTED PROPERTY (a room number that exists only in
 * another property is simply not matched), otherwise the property alone. `fixed` is { propertyId, propertyName, unitId?, unitNumber? } built by the server from the verified
 * records (signalIntakeService.js), never from a browser value.
 */
function resolveFixedLocation(text, units, fixed) {
  const base = { status: "resolved", propertyId: String(fixed.propertyId), propertyName: fixed.propertyName };
  if (fixed.unitId) return { ...base, unitId: String(fixed.unitId), unitNumber: fixed.unitNumber, token: fixed.unitNumber };
  if (fixed.locked) return base; // a selected stay without a unit: the room is not guessed from the words (a Signal's unit must be its stay's unit)
  for (const token of roomTokens(text)) {
    const matches = units.filter((unit) => String(unit.propertyId) === String(fixed.propertyId) && normalizeUnit(unit.unitNumber) === token);
    if (matches.length === 1) return { ...base, unitId: String(matches[0]._id), unitNumber: matches[0].unitNumber, token };
  }
  return base;
}

const firstSentence = (text) => {
  const sentence = text.split(/(?<=[.!?])\s+|\n/).map((part) => part.trim()).find(Boolean) ?? text;
  return sentence.length > INTAKE_LIMITS.titleMax ? `${sentence.slice(0, INTAKE_LIMITS.titleMax - 1).trimEnd()}…` : sentence;
};

function classify(text) {
  const rule = TYPE_RULES.find(([, pattern]) => pattern.test(text));
  return rule ? { type: rule[0], classified: true } : { type: "other", classified: false };
}

const severityStatedIn = (text) => SEVERITY_RULES.find(([, pattern]) => pattern.test(text))?.[0];

const FILLER = new Set(["at", "in", "the", "a", "an", "is", "it", "its", "this", "that", "for", "of", "on", "to", "and", "please", "about", "regarding", "there", "guest", "guests", "room", "unit"]);

/** The words that describe an EVENT: what is left once the location the operator named (room token, property name or code) and filler words are removed. */
function eventWords(text, properties) {
  let rest = text.replace(ROOM_TOKEN, " ");
  for (const property of properties) {
    for (const label of [property.name, property.code]) {
      const value = String(label ?? "").trim();
      if (value.length >= 3) rest = rest.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`, "giu"), " ");
    }
  }
  return (rest.match(/[\p{L}\p{N}']+/gu) ?? []).filter((word) => !FILLER.has(word.toLowerCase())).length;
}

function interpretOnce(text, { properties, units, fixed }) {
  const location = fixed ? resolveFixedLocation(text, units, fixed) : resolveLocation(text, properties, units);
  const { type, classified } = classify(text);
  // An event is a recognised kind of event, or at least three words of description beyond WHERE it happened ("room 221 at Harbour View" is a place, not an event).
  const hasEvent = classified || eventWords(text, properties) >= 3;
  const label = location.unitNumber ? `room ${location.unitNumber}${location.propertyName ? ` at ${location.propertyName}` : ""}` : location.propertyName ?? (location.token ? `room ${location.token}` : null);
  return { location, type, classified, hasEvent, label };
}

/**
 * @param {{ text: string, pendingText?: string, properties: object[], units: object[] }} input  `text` is already normalised (normalizeIntakeText)
 * @returns {{ outcome: string, message?: string, question?: string, missing?: string[], pendingText?: string, instructionsIgnored?: boolean, draft?: object }}
 */
export function interpretOperatorMessage({ text, pendingText, properties, units, fixed }) {
  const reference = { properties: properties.slice(0, INTAKE_LIMITS.propertiesMax), units: units.slice(0, INTAKE_LIMITS.unitsMax), ...(fixed ? { fixed } : {}) };
  if (ACTION_COMMAND.test(text) || OUTCOME_COMMAND.test(text)) return { outcome: INTAKE_OUTCOME.DECLINED, message: DECLINED_MESSAGE };
  const metaInText = hasMeta(text);

  // With an explicit property selected, a report that NAMES a different property is not silently recorded against the selected one (nor moved to the named one): it is
  // declined with one fixed sentence and nothing is created - the operator starts the investigation for the other property.
  if (fixed) {
    const other = namedProperties(text, reference.properties).find((property) => String(property._id) !== String(fixed.propertyId));
    if (other) return { outcome: INTAKE_OUTCOME.DECLINED, message: `This investigation is for ${fixed.propertyName}, but the report names ${other.name}. Start a new investigation for ${other.name}, or describe what happened at ${fixed.propertyName}.` };
  }

  // A standalone complete report always wins; otherwise the answer is read together with the question that was asked (same conversation, server-held).
  let source = text;
  let read = interpretOnce(text, reference);
  // With an explicit selection the location is always resolved, so a message that steers the assistant must show a RECOGNISED kind of event (not merely a few words) to be
  // recorded as a report; otherwise it is declined exactly like it is without a selection.
  const complete = (r) => r.location.status === "resolved" && r.hasEvent && (!(fixed && metaInText) || r.classified);
  if (!complete(read) && pendingText) {
    source = `${pendingText}\n${text}`;
    read = interpretOnce(source, reference);
  }

  // Instructions to the assistant with no complete event behind them: decline, create nothing, remember nothing.
  if (metaInText && !complete(read)) return { outcome: INTAKE_OUTCOME.DECLINED, message: DECLINED_MESSAGE };

  if (read.location.status === "ambiguous") {
    const where = read.location.candidates.join(", ");
    return {
      outcome: INTAKE_OUTCOME.CLARIFY,
      missing: ["property"],
      question: read.location.token ? `Room ${read.location.token} exists in more than one property (${where}). Which property is this regarding?` : `Which property is this regarding (${where})?`,
      pendingText: source.slice(0, INTAKE_LIMITS.textMax),
    };
  }
  if (read.location.status === "not_found") {
    return {
      outcome: INTAKE_OUTCOME.CLARIFY,
      missing: ["property"],
      question: `I couldn't find room ${read.location.token} in this workspace. Which property is this regarding?`,
      pendingText: source.slice(0, INTAKE_LIMITS.textMax),
    };
  }
  if (read.location.status === "none") {
    return { outcome: INTAKE_OUTCOME.CLARIFY, missing: ["location"], question: "Which property or room is this regarding?", pendingText: source.slice(0, INTAKE_LIMITS.textMax) };
  }
  if (!read.hasEvent) {
    return { outcome: INTAKE_OUTCOME.CLARIFY, missing: ["event"], question: `What happened in ${read.label}?`, pendingText: source.slice(0, INTAKE_LIMITS.textMax) };
  }

  const severity = severityStatedIn(source);
  const description = source;
  return {
    outcome: INTAKE_OUTCOME.READY,
    instructionsIgnored: metaInText,
    draft: {
      propertyId: read.location.propertyId,
      unitId: read.location.unitId,
      type: read.type,
      severity,
      severityStated: Boolean(severity),
      typeBasis: read.classified ? "keyword" : "unclassified",
      title: firstSentence(source),
      description,
      location: { unitNumber: read.location.unitNumber, propertyName: read.location.propertyName, basis: fixed ? "explicit_selection" : read.location.unitId ? "unit_record" : "property_name" },
    },
  };
}
