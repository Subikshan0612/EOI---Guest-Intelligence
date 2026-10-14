/**
 * Phase 43B / 43B.2 - what the UI may say about a Signal's RECORDED severity.
 *
 * Recorded severity (a closed enum set when the Signal was logged) is a different thing from the validated safety assessment of an analysis
 * (`safety.state`, see safetyPresentation.js): one is a fact somebody recorded, the other is Node's validated result for an AI analysis. The UI keeps them
 * apart - this note says only what was recorded, never "AI assessment", urgency or escalation. It reads ONLY the structured `severity` value, never text,
 * through a closed own-property lookup (an unknown or missing value yields null: no note, nothing invented).
 */
const SEVERITY_NOTES = Object.freeze({
  critical: Object.freeze({
    level: "critical",
    label: "Signal severity",
    value: "CRITICAL",
    detail: "Recorded when the signal was created.",
  }),
});

/** @returns {{level: string, label: string, value: string, detail: string} | null} */
export function severityNote(severity) {
  if (typeof severity !== "string") return null;
  return Object.prototype.hasOwnProperty.call(SEVERITY_NOTES, severity) ? SEVERITY_NOTES[severity] : null;
}
