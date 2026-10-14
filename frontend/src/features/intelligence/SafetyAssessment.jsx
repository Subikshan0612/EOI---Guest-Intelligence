import { OctagonAlert } from "lucide-react";
import { presentSafety } from "./safetyPresentation";

/**
 * The server-validated safety assessment of an analysis, from the structured `safety` object ONLY (see safetyPresentation.js). One coherent block:
 *   - an ALERT for the two safety conditions (CRITICAL SAFETY CONDITION / LIFE-SAFETY HAZARD), with the structured flags IMMEDIATE ACTION REQUIRED and
 *     ESCALATION REQUIRED inside it when - and only when - the structured urgency / action type say so;
 *   - a quiet one-line summary for NORMAL (no alarm wording, and never "safe");
 *   - a neutral note when there is no assessment (an older record) or the state is not one this view knows.
 * It represents the validated analysis, not a sensor reading, and it is informational: no button, no action, no call. State is carried by visible text and an
 * icon, never by colour alone. Only the alert is a live region (role="alert"), so an ordinary page render announces nothing.
 */
export default function SafetyAssessment({ safety }) {
  const view = presentSafety(safety);

  if (view.status === "not_recorded") {
    return <p className="safety-quiet muted">Safety assessment not recorded.</p>;
  }
  if (view.status === "unrecognised") {
    return <p className="safety-quiet muted">Safety assessment present but not recognised by this view.</p>;
  }

  if (!view.alert) {
    // NORMAL stays quiet - but a structured escalation action type is stated plainly (emphasised text, no alarm styling, no live region, never "REQUIRED"),
    // so it is not buried in a list of labels. It does not turn the state into an emergency.
    const parts = [`Validated safety assessment: ${view.stateLabel}`];
    if (view.urgencyLabel) parts.push(`Urgency: ${view.urgencyLabel}`);
    if (view.escalation) parts.push(<strong key="escalation" className="safety-note">Escalation recommended</strong>);
    else if (view.actionTypeLabel) parts.push(`Action type: ${view.actionTypeLabel}`);
    return (
      <>
        <p className="safety-quiet muted">
          {parts.map((part, i) => (
            <span key={i}>
              {i > 0 ? " · " : ""}
              {part}
            </span>
          ))}
        </p>
        {view.reviewRequiredNote ? <p className="safety-quiet muted safety-review-note">{view.reviewRequiredNote}</p> : null}
        {view.accessRefusedNote ? <p className="safety-quiet muted safety-refusal-note">{view.accessRefusedNote}</p> : null}
      </>
    );
  }

  return (
    <section className="safety-alert" data-state={view.state} role="alert" aria-labelledby="safety-alert-headline">
      <OctagonAlert className="safety-alert-icon" size={24} strokeWidth={2} aria-hidden="true" />
      <div className="safety-alert-copy">
        <p className="safety-alert-kicker">Validated safety assessment</p>
        <p className="safety-alert-headline" id="safety-alert-headline">
          {view.headline}
        </p>
        {view.flags.length ? (
          <ul className="safety-alert-flags">
            {view.flags.map((flag) => (
              <li key={flag}>{flag}</li>
            ))}
          </ul>
        ) : null}
        <p className="safety-alert-detail">
          Assessment of this analysis, validated by the server. It is not a sensor reading.
          {view.urgencyLabel ? ` Urgency: ${view.urgencyLabel}.` : ""}
          {view.actionTypeLabel ? ` Action type: ${view.actionTypeLabel}.` : ""}
        </p>
        {view.reviewRequiredNote ? <p className="safety-alert-detail safety-review-note">{view.reviewRequiredNote}</p> : null}
        {view.accessRefusedNote ? <p className="safety-alert-detail safety-refusal-note">{view.accessRefusedNote}</p> : null}
      </div>
    </section>
  );
}
