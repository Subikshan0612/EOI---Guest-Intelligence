import { severityNote } from "./severitySignal";

/**
 * The RECORDED severity of a Signal, shown as a compact labelled note (only when it is `critical`). It is a recorded fact, not a safety assessment, and is
 * deliberately smaller and quieter than SafetyAssessment's alert so the two are never mistaken for each other or read as a duplicate. Text carries the
 * meaning (never colour alone); it is a static note, not a live region.
 */
export default function SignalSeverityNote({ severity }) {
  const note = severityNote(severity);
  if (!note) return null;
  return (
    <p className="severity-note" data-level={note.level}>
      <span className="severity-note-label">{note.label}:</span> <strong className="severity-note-value">{note.value}</strong>
      <span className="severity-note-detail"> · {note.detail}</span>
    </p>
  );
}
