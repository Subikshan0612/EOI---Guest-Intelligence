/**
 * Where an operator's report CONFLICTS with the current operational record (Phase 52). Pure and deterministic: no model, no database, no I/O.
 *
 * An operator's words are an UNTRUSTED_SIGNAL (the report); the stay record is a CURRENT_OPERATIONAL_FACT. When the two disagree the record stays authoritative - this module
 * resolves nothing and invents nothing. It only makes the disagreement an explicit, server-derived fact the analysis is given, so the model cannot silently adopt either
 * version: "the report says X, the record says Y, they differ."
 *
 * Deliberately narrow, a closed list, not a language-understanding component. It recognises one kind of claim - WHEN the guest leaves ("staying until tomorrow",
 * "checking out today", "leaving the day after tomorrow") - and compares the day named relative to when the report was made (in the property's timezone) with the
 * linked stay's recorded check-out date. A claim it does not recognise, an explicit calendar date, a missing stay or a missing check-out date yield nothing (no guess).
 * A match with the record yields nothing. Text is untrusted: the worst a hostile report can do is raise a conflict note, which only makes the analysis MORE cautious.
 */
// The longest phrase first, and a LAZY filler, so "the day after tomorrow" is never read as "tomorrow".
const DAY_WORDS = String.raw`(the\s+day\s+after\s+tomorrow|today|tonight|tomorrow)`;
const STAYING_UNTIL = new RegExp(String.raw`\b(?:stay(?:s|ing)?|remain(?:s|ing)?|here)\b[^.;!?]{0,25}?\b(?:until|till|through)\s+${DAY_WORDS}\b`, "i");
const LEAVING = new RegExp(String.raw`\b(?:check(?:s|ing)?[\s-]?out|leav(?:es|ing)|depart(?:s|ing)?)\b[^.;!?]{0,20}?\b(?<!after\s)${DAY_WORDS}\b`, "i");
const OFFSET_DAYS = Object.freeze({ today: 0, tonight: 0, tomorrow: 1, "the day after tomorrow": 2 });
const MAX_CHECKS = 3;

const isoDay = (date) => date.toISOString().slice(0, 10);
const validDate = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};

/** The calendar day (YYYY-MM-DD) of an instant in a timezone; an unknown timezone falls back to UTC. */
function localDay(instant, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
  } catch {
    return isoDay(instant);
  }
}

const addDays = (day, days) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDay(date);
};

/**
 * @param {{ signal?: object, stay?: object|null, property?: object|null }} context  the analysis context (signal title/description/occurredAt, linked stay, property timezone)
 * @returns {{ kind: string, reported: string, recorded: string }[]} server-derived conflicts, empty when there is none (the usual case)
 */
export function detectReportConflicts(context) {
  const stay = context?.stay;
  const recorded = stay && stay.available === true ? validDate(stay.checkOut) : null;
  const madeAt = validDate(context?.signal?.occurredAt);
  if (!recorded || !madeAt) return [];

  const text = [context?.signal?.title, context?.signal?.description].filter((part) => typeof part === "string").join("\n");
  const today = localDay(madeAt, context?.property?.timezone);
  const recordedDay = isoDay(recorded); // stay dates are date-only values stored at UTC midnight

  const checks = [];
  for (const pattern of [STAYING_UNTIL, LEAVING]) {
    const match = pattern.exec(text);
    if (!match) continue;
    const word = match[1].toLowerCase().replace(/\s+/g, " ");
    const reportedDay = addDays(today, OFFSET_DAYS[word]);
    if (reportedDay !== recordedDay && !checks.some((check) => check.reported.endsWith(`(${reportedDay})`))) {
      checks.push({ kind: "stay_checkout_date", reported: `${word} (${reportedDay})`, recorded: recordedDay });
    }
    if (checks.length >= MAX_CHECKS) break;
  }
  return checks;
}
