/**
 * Which earlier reports may inform the analysis of THIS report (Phase 52). Pure and deterministic: no model, no database, no I/O.
 *
 * Why it exists. The relational history assembly (signalContextService.js) deliberately selects by relationship only - same stay, guest, unit or property - and
 * performs "no interpretation". Handed to the model unfiltered, an unrelated earlier incident in the same room (a gas smell) becomes evidence for a later,
 * unrelated report (an AC fault) and drives its urgency. Relationship is necessary but not sufficient: an earlier report is only relevant to the current one when
 * it is about the same KIND of problem.
 *
 * The rule. Each report is classified into a small CLOSED set of topics by whole-word patterns over its own words (the current report: title and description;
 * an earlier report: its title - the only text history carries). An earlier report is kept iff it shares at least one topic with the current report. When
 * neither report has a recognised topic, they are related only if they have the same report type. When one has a topic and the other does not, they are not
 * related (nothing is guessed). So a previous AC fault is useful for a new AC fault; a previous gas smell is not evidence for an AC fault - and a previous gas
 * smell IS relevant to a new one.
 *
 * What this is NOT. It does not decide safety (safetyPolicy.js derives that from the CURRENT report alone, and takes no history); it does not delete or alter
 * any record (the context endpoint and the stored history still show everything); and it cannot make a record visible that tenant scoping or the caller's level
 * excluded - it only ever REMOVES items from a list that was already scoped. Text is untrusted: a topic word in a report can only widen which of the
 * workspace's OWN earlier reports are shown to the model, never grant anything.
 */
const TOPICS = Object.freeze([
  ["life_safety", /\bgas\b|\bsmoke\b|\bfire\b|\bburning\b|\bexplo\w*|\bcarbon\s+monoxide\b|\bCO\s+(?:alarm|detector)\b/i],
  ["climate", /\b(?:a\/c|ac|air[\s-]?con\w*|hvac|cool(?:ing)?|heat(?:er|ing)?|thermostat|temperature|freezing|too\s+(?:hot|cold)|fan)\b/i],
  ["water", /\b(?:water|leak\w*|plumb\w*|toilet|shower|faucet|tap|drain\w*|pipe\w*|flood\w*|clog\w*|sink|geyser|boiler)\b/i],
  ["electrical", /\b(?:power|electric\w*|lights?|bulb|sockets?|outlet|fuse|breaker|tripp\w*|blackout|generator|inverter)\b/i],
  ["appliance_it", /\b(?:fridge|refrigerator|oven|stove|microwave|kettle|washing\s+machine|dryer|tv|television|wi-?fi|internet|router)\b/i],
  ["noise", /\b(?:noise|noisy|loud|music|party|disturb\w*)\b/i],
  ["cleanliness", /\b(?:clean\w*|dirty|towels?|linen|sheets?|bedding|housekeep\w*|trash|garbage|stain\w*|pests?|cockroach\w*|insects?|bed\s*bugs?|mou?ld)\b/i],
  ["access", /\b(?:lock\w*|key\s*cards?|keys?|door|entry|enter\w*)\b/i],
  ["stay_timing", /\b(?:late\s+check[\s-]?out|early\s+check[\s-]?in|check[\s-]?(?:in|out)|extend\w*|extension)\b/i],
  ["billing", /\b(?:payment|charg\w*|bill\w*|invoice|refund\w*|deposit|overcharg\w*)\b|\$\s?\d/i],
]);

const text = (value) => (typeof value === "string" ? value : "");

/** @returns {Set<string>} the topics a piece of report text is about (empty when none is recognised). */
export function topicsOf(...parts) {
  const joined = parts.map(text).join("\n");
  return new Set(TOPICS.filter(([, pattern]) => pattern.test(joined)).map(([name]) => name));
}

/**
 * @param {{ title?: string, description?: string, type?: string }} current  the report being analysed
 * @param {{ title?: string, type?: string }} earlier                          one history item (history carries a title and a type only)
 */
export function isHistoryRelevant(current, earlier) {
  const now = topicsOf(current?.title, current?.description);
  const before = topicsOf(earlier?.title);
  if (now.size > 0 && before.size > 0) return [...now].some((topic) => before.has(topic));
  if (now.size === 0 && before.size === 0) return typeof current?.type === "string" && current.type === earlier?.type;
  return false;
}

/** The history items that may inform the current report, in their original order. */
export function relevantHistory(current, items) {
  return (Array.isArray(items) ? items : []).filter((item) => isHistoryRelevant(current, item));
}
