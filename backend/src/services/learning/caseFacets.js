/**
 * Case-based Learning L1.2 - STRUCTURED FACETS. Pure and deterministic: text in, closed-vocabulary values out. No model, no database, no I/O.
 *
 * WHY. The application has NO authoritative equipment / problem / symptom field: a Signal carries only `type` (10 values), `severity`, `unitId` and the operator's own words
 * (title, description). L1 matched on the 10 broad topic words of historyRelevance.js (water, climate, noise, electrical ...), where ONE shared topic was enough - so a refrigerator
 * that "is not cooling" matched an AC, and a drain matched every leak. L1.2 therefore derives three small FACETS from the Signal's own words with explicit, closed rules.
 * This is not a classifier of meaning: it recognises a fixed list of explicit words and says UNKNOWN for everything else.
 *
 * THE FACETS (every value is from the closed lists below; nothing a report says can add a value):
 *   equipment   what the report is about (a fixture, a device, a system, or a service subject)
 *   problem     the problem family
 *   condition   a symptom that matters ONLY inside one problem family (temperature_fault: not_cooling | not_heating); NOT_APPLICABLE for every other family
 * Each facet is either a vocabulary value or one of the two states:
 *   UNKNOWN     no explicit word of the vocabulary was found (nothing is guessed, and UNKNOWN is never equal to anything, including another UNKNOWN)
 *   AMBIGUOUS   the report names more than one distinct value (two devices, or two problems): it is a conflict, never resolved by picking one
 *
 * MAPPING SOURCE. Only the Signal's own `title` and `description` (the operator's words) and, for a life-safety hazard, the server safety policy's verdict (see below). Never a model
 * output, never an analysis, never history, never a guest or stay field. The words are untrusted: they can only select a value from the closed lists.
 *
 * EQUIPMENT PRECEDENCE (a report that names a hot-water system AND a shower is about the water heater; one that names an AC and a late check-out is about the AC):
 *   tier 1  hazard source   gas_supply | smoke_fire | co_alarm      ONLY when the server safety policy already classifies the Signal as a life-safety hazard
 *   tier 2  system          water_heater | power_supply
 *   tier 3  fixture/device  air_conditioner | refrigerator | toilet | sink | shower | electrical_outlet | lighting | wifi_network | television | door_lock | stove_oven | neighbouring_guests
 *   tier 4  service subject housekeeping_service | billing_account | stay_booking                  ONLY when no tier 1-3 value was found
 * The highest tier that matched decides; two DIFFERENT values in that tier = AMBIGUOUS.
 *
 * PROBLEM RULES. Which families are considered depends on the equipment: a hazard source -> safety_hazard; a service subject -> service_missing | dispute | request; any other
 * equipment -> the hardware families water_leak | blockage | unusual_noise | electrical_fault | temperature_fault | access_problem | degraded_performance, plus the GENERIC
 * not_operating which applies only when no specific family matched. Two different specific families = AMBIGUOUS.
 */
export const FACET_UNKNOWN = "UNKNOWN";
export const FACET_AMBIGUOUS = "AMBIGUOUS";
export const FACET_NOT_APPLICABLE = "NOT_APPLICABLE";

export const EQUIPMENT_VALUES = Object.freeze([
  "gas_supply", "smoke_fire", "co_alarm",
  "water_heater", "power_supply",
  "air_conditioner", "refrigerator", "toilet", "sink", "shower", "electrical_outlet", "lighting", "wifi_network", "television", "door_lock", "stove_oven", "neighbouring_guests",
  "housekeeping_service", "billing_account", "stay_booking",
]);
export const PROBLEM_VALUES = Object.freeze(["safety_hazard", "water_leak", "blockage", "unusual_noise", "electrical_fault", "temperature_fault", "access_problem", "degraded_performance", "not_operating", "service_missing", "dispute", "request"]);
export const CONDITION_VALUES = Object.freeze(["not_cooling", "not_heating"]);
// L1.3: the values a persisted Signal.issue may hold (a vocabulary value, or one of the two states; NOT_APPLICABLE is not a persisted state)
export const ISSUE_EQUIPMENT_VALUES = Object.freeze([...EQUIPMENT_VALUES, FACET_UNKNOWN, FACET_AMBIGUOUS]);
export const ISSUE_PROBLEM_VALUES = Object.freeze([...PROBLEM_VALUES, FACET_UNKNOWN, FACET_AMBIGUOUS]);
export const ISSUE_CONDITION_VALUES = Object.freeze([...CONDITION_VALUES, FACET_UNKNOWN, FACET_AMBIGUOUS]);

const TIER_HAZARD = 1; const TIER_SYSTEM = 2; const TIER_DEVICE = 3; const TIER_SERVICE = 4;
const w = (source) => new RegExp(source, "i");

const EQUIPMENT_RULES = Object.freeze([
  [TIER_HAZARD, "gas_supply", w(String.raw`\bgas\b`)],
  [TIER_HAZARD, "smoke_fire", w(String.raw`\b(?:smoke|fire)\b`)],
  [TIER_HAZARD, "co_alarm", w(String.raw`\bcarbon\s+monoxide\b|\bCO\b`)],
  [TIER_SYSTEM, "water_heater", w(String.raw`\b(?:geyser|boiler|water\s+heater|hot\s+water|water\s+(?:stays|remains|is|turns|runs)\s+cold|cold\s+water\s+only)\b`)],
  [TIER_SYSTEM, "power_supply", w(String.raw`\b(?:blackout|power\s+(?:cut|outage|supply|failure|is\s+out|went\s+out)|no\s+power|electricity|breaker|fuse|tripp(?:s|ed|ing))\b|\bpower\b(?!\s*(?:socket|point|outlet|strip))`)],
  [TIER_DEVICE, "air_conditioner", w(String.raw`\b(?:a\/c|ac|air[\s-]?con\w*|air\s+conditioners?|hvac)\b`)],
  [TIER_DEVICE, "refrigerator", w(String.raw`\b(?:fridge|refrigerator|mini-?bar)\b`)],
  [TIER_DEVICE, "toilet", w(String.raw`\b(?:toilet|wc|commode)\b`)],
  [TIER_DEVICE, "sink", w(String.raw`\b(?:sink|basin|washbasin)\b`)],
  [TIER_DEVICE, "shower", w(String.raw`\bshower\b`)],
  [TIER_DEVICE, "electrical_outlet", w(String.raw`\b(?:sockets?|outlets?|plug\s+points?)\b`)],
  [TIER_DEVICE, "lighting", w(String.raw`\b(?:lights|bulbs?|lamps?|lighting)\b|\b(?:the|a|ceiling|bedroom|bathroom|room|corridor)\s+light\b`)],
  [TIER_DEVICE, "wifi_network", w(String.raw`\b(?:wi-?fi|internet|router)\b`)],
  [TIER_DEVICE, "television", w(String.raw`\b(?:tv|television)\b`)],
  [TIER_DEVICE, "door_lock", w(String.raw`\b(?:key\s*cards?|keycards?|door\s+lock|lock(?:ed)?)\b`)],
  [TIER_DEVICE, "stove_oven", w(String.raw`\b(?:stove|oven|cooktop|hob)\b`)],
  [TIER_DEVICE, "neighbouring_guests", w(String.raw`\b(?:neighbou?rs?|neighbou?ring|next\s+door|next\s+room|adjacent\s+room)\b`)],
  [TIER_SERVICE, "housekeeping_service", w(String.raw`\b(?:towels?|linen|sheets?|bedding|housekeep\w*|cleaned|cleaning|dirty|amenit\w*)\b`)],
  [TIER_SERVICE, "billing_account", w(String.raw`\b(?:invoice|bill|billing|charges?|charged|deposit|refund\w*|overcharg\w*|payment)\b`)],
  [TIER_SERVICE, "stay_booking", w(String.raw`\b(?:check[\s-]?(?:in|out)|extend\w*|extension|stay)\b`)],
]);

const COOLING = w(String.raw`\b(?:not|isn'?t|stopped|no|won'?t|doesn'?t)\s+(?:\w+\s+)?cool(?:ing)?\b|\bstopped\s+cool\w*\b|\bwarm\b|\bnot\s+cold\b`);
const HEATING = w(String.raw`\bno\s+hot\s+water\b|\bnot\s+heating\b|\bstays?\s+cold\b|\bwater\s+(?:is\s+)?cold\b|\bcold\s+water\s+only\b|\bnot\s+(?:getting\s+)?hot\b`);
const HARDWARE_SPECIFIC = Object.freeze([
  ["water_leak", w(String.raw`\b(?:leak\w*|drip\w*|flood\w*|overflow\w*)\b|\bwater\s+(?:on|spreading\s+(?:across|over|on)|all\s+over)\s+the\s+floor\b`)],
  ["blockage", w(String.raw`\b(?:clog\w*|block\w*|won'?t\s+drain|not\s+draining|drain\w*\s+slow\w*|slow(?:ly)?\s+drain\w*)\b`)],
  ["unusual_noise", w(String.raw`\b(?:noise|noisy|loud|rattl\w*|buzz\w*|humm\w*|grind\w*|squeal\w*|vibrat\w*|music|party)\b`)],
  ["electrical_fault", w(String.raw`\b(?:spark\w*|short[\s-]?circuit\w*)\b|\bburning\s+smell\b|\bsmells?\s+(?:of\s+)?burn\w*|\belectric(?:al)?\s+shock\b`)],
  ["temperature_fault", new RegExp(`${COOLING.source}|${HEATING.source}`, "i")],
  ["access_problem", w(String.raw`\blocked\s+out\b|\b(?:not|n'?t)\s+(?:open\w*|accept\w*)\b|\bwon'?t\s+open\b|\bfails?\s+to\s+open\b|\b(?:key\s*cards?|keycards?)\s+fails?\b`)],
  ["degraded_performance", w(String.raw`\b(?:internet|wi-?fi|connection)\b[^.]{0,30}\b(?:slow\w*|dropp\w*|unstable|intermittent)\b|\b(?:slow|unstable|intermittent)\s+(?:internet|wi-?fi|connection)\b|\bkeeps\s+dropping\b`)],
]);
const GENERIC_NOT_OPERATING = w(String.raw`\b(?:not\s+working|isn'?t\s+working|stopped(?:\s+working)?|broken|broke|dead|down|out\s+of\s+order|not\s+functioning|won'?t\s+(?:turn\s+on|start|work)|blackout|no\s+power|go(?:es)?\s+out|tripp(?:s|ed|ing)|power\s+(?:cut|outage|is\s+out|went\s+out))\b`);
const SERVICE_PROBLEMS = Object.freeze([
  ["service_missing", w(String.raw`\bnot\s+(?:cleaned|changed|replaced)\b|\bno\s+(?:fresh|clean)\b|\b(?:did\s+not|didn'?t)\s+come\b|\bdirty\b|\bmissing\b`)],
  ["dispute", w(String.raw`\b(?:disput\w*|overcharg\w*|double[\s-]?charged|refund\w*)\b|\bwrong(?:ly)?\s+charge\w*`)],
  ["request", w(String.raw`\b(?:late\s+check[\s-]?out|early\s+check[\s-]?(?:in|out)|extend\w*|extension|extra\s+night)\b`)],
]);

const pickDistinct = (matches) => { const set = [...new Set(matches)]; return set.length === 0 ? FACET_UNKNOWN : set.length === 1 ? set[0] : FACET_AMBIGUOUS; };

/**
 * @param {{ title?: string, description?: string }} text  the Signal's own words
 * @param {{ hazard?: boolean }} [context]  hazard: the SERVER safety policy classified the Signal as LIFE_SAFETY_HAZARD (this module never decides safety)
 * @returns {{ equipment: string, problem: string, condition: string }}
 */
export function extractFacets({ title, description } = {}, { hazard = false } = {}) {
  const text = [title, description].filter((p) => typeof p === "string").join("\n");
  // ---- equipment: the highest matching tier decides
  const found = EQUIPMENT_RULES.filter(([tier, , re]) => (tier === TIER_HAZARD ? hazard : true) && re.test(text)).map(([tier, value]) => [tier, value]);
  const best = found.length ? Math.min(...found.map(([t]) => t)) : null;
  const equipment = best === null ? FACET_UNKNOWN : pickDistinct(found.filter(([t]) => t === best).map(([, v]) => v));
  // ---- problem: depends on the kind of equipment
  let problem = FACET_UNKNOWN;
  if (hazard && best === TIER_HAZARD) problem = "safety_hazard";
  else if (best === TIER_SERVICE) problem = pickDistinct(SERVICE_PROBLEMS.filter(([, re]) => re.test(text)).map(([name]) => name));
  else if (best !== null && best !== TIER_HAZARD) {
    const specific = HARDWARE_SPECIFIC.filter(([, re]) => re.test(text)).map(([name]) => name);
    problem = specific.length ? pickDistinct(specific) : GENERIC_NOT_OPERATING.test(text) ? "not_operating" : FACET_UNKNOWN;
  }
  // ---- condition: only inside temperature_fault
  let condition = FACET_NOT_APPLICABLE;
  if (problem === "temperature_fault") {
    const kinds = [COOLING.test(text) ? "not_cooling" : null, HEATING.test(text) ? "not_heating" : null].filter(Boolean);
    condition = kinds.length === 0 ? FACET_UNKNOWN : kinds.length === 1 ? kinds[0] : FACET_AMBIGUOUS;
  }
  return { equipment, problem, condition };
}

const STRICT_COOLING = w(String.raw`\b(?:not|isn'?t|aren'?t|stopped|no)\s+(?:\w+\s+)?cooling\b|\b(?:won'?t|doesn'?t|does\s+not)\s+cool\b`);
const STRICT_HEATING = w(String.raw`\bnot\s+heating\b|\bno\s+heating\b`);
const STRICT_TEMPERATURE = new RegExp(`${STRICT_COOLING.source}|${STRICT_HEATING.source}`, "i");
const STRICT_NOT_OPERATING = w(String.raw`\b(?:not\s+working|isn'?t\s+working|aren'?t\s+working|stopped\s+working|broken|out\s+of\s+order|not\s+functioning|won'?t\s+(?:turn\s+on|start|work))\b`);
const QUANTITY = String.raw`\b(?:multiple|several|many|numerous|both|two|three|four|five|all|every|few)\s+(?:[\w'-]+\s+){0,2}`;
const QUANTIFIED_DEVICES = Object.freeze(EQUIPMENT_RULES.filter(([tier]) => tier === TIER_DEVICE).map(([, value, re]) => [value, new RegExp(`${QUANTITY}(?:${re.source})`, "i")]));

/**
 * Learning L1.3 - the structured issue captured AT SIGNAL INTAKE. Same closed vocabularies and the same equipment / problem rules as extractFacets (nothing is duplicated; the
 * rule tables above are the only ones), with the differences the intake contract needs:
 *   - the problem family and the condition are derived EVEN WHEN no equipment is named ("Room 204 is not cooling" -> equipment UNKNOWN, temperature_fault, not_cooling). The equipment
 *     is still never invented. Without a named device only the STRICT patterns are used (explicit "not cooling", "not working", "broken" ...): the loose ones ("warm", "down", "dead",
 *     "broke") are accepted only next to a named device, where a false reading is far less likely;
 *   - a quantity word in front of the device ("multiple AC units", "all the lights", "both toilets") is AMBIGUOUS: the report does not name a single target;
 *   - the condition is a closed value, UNKNOWN, or AMBIGUOUS - never NOT_APPLICABLE (the intake record has no such state; "condition not stated" is UNKNOWN);
 *   - when the SERVER safety policy says life-safety hazard the problem family is safety_hazard (the existing safety classification, not an inference from words).
 * Pure and deterministic; the words only ever SELECT a listed value.
 * @param {{ title?: string, description?: string }} text  the Signal's own words
 * @param {{ hazard?: boolean }} [context]  hazard: the SERVER safety policy classified the Signal as LIFE_SAFETY_HAZARD
 * @returns {{ equipment: string, problem: string, condition: string }}
 */
export function extractIssueFacets({ title, description } = {}, { hazard = false } = {}) {
  const text = [title, description].filter((p) => typeof p === "string").join("\n");
  const found = EQUIPMENT_RULES.filter(([tier, , re]) => (tier === TIER_HAZARD ? hazard : true) && re.test(text)).map(([tier, value]) => [tier, value]);
  const best = found.length ? Math.min(...found.map(([t]) => t)) : null;
  let equipment = best === null ? FACET_UNKNOWN : pickDistinct(found.filter(([t]) => t === best).map(([, v]) => v));
  if (best === TIER_DEVICE && equipment !== FACET_AMBIGUOUS && QUANTIFIED_DEVICES.some(([value, re]) => value === equipment && re.test(text))) equipment = FACET_AMBIGUOUS; // "multiple AC units": no single target
  const named = best !== null;

  // ---- problem family
  const hardware = named ? HARDWARE_SPECIFIC : HARDWARE_SPECIFIC.map(([name, re]) => (name === "temperature_fault" ? [name, STRICT_TEMPERATURE] : [name, re]));
  const notOperating = named ? GENERIC_NOT_OPERATING : STRICT_NOT_OPERATING;
  let problem = FACET_UNKNOWN;
  if (hazard) problem = "safety_hazard";
  else if (best === TIER_SERVICE) problem = pickDistinct(SERVICE_PROBLEMS.filter(([, re]) => re.test(text)).map(([name]) => name));
  else {
    const specific = hardware.filter(([, re]) => re.test(text)).map(([name]) => name);
    problem = specific.length ? pickDistinct(specific) : notOperating.test(text) ? "not_operating" : FACET_UNKNOWN;
  }

  // ---- condition: a symptom of a temperature fault only; everywhere else it is not stated
  const cooling = named ? COOLING : STRICT_COOLING; const heating = named ? HEATING : STRICT_HEATING;
  let condition = FACET_UNKNOWN;
  const temperatureInvolved = problem === "temperature_fault" || (problem === FACET_AMBIGUOUS && hardware.some(([name, re]) => name === "temperature_fault" && re.test(text)));
  if (temperatureInvolved) {
    const kinds = [cooling.test(text) ? "not_cooling" : null, heating.test(text) ? "not_heating" : null].filter(Boolean);
    condition = kinds.length === 0 ? FACET_UNKNOWN : kinds.length === 1 ? kinds[0] : FACET_AMBIGUOUS;
  }
  return { equipment, problem, condition };
}
