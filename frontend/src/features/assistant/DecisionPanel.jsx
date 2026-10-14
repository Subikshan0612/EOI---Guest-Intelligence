import { useState } from "react";
import { OctagonAlert } from "lucide-react";
import RetryButton from "../../components/auth/RetryButton";
import { KOI_WORKSPACE_ROLE } from "../../config/workspace";
import { formatShortDate } from "../../utils/formatDate";
import { roleMayPropose, roleMayReview } from "./decisionMapping";

/**
 * DECISION: the human governance record for one Intelligence (Phase 48). The AI recommends; a PERSON decides; the system records it - and carries out nothing.
 *
 * The model is the existing Decision V1 and its state machine (proposed -> approved | rejected): a person who may review confirms their OWN decision in one step
 * (Phase 48.1: EOI is a single-user product today, so the person who asked is the person who decides; the proposer and the reviewer are both still recorded). A
 * member who may only propose submits it for someone with review permission. Permission and workspace membership are server rules; this panel only shows the next
 * step that is possible and never offers one the server would refuse. The Intelligence is never changed: the recommendation under review is shown exactly as stored, and a human who
 * disagrees records their own decision beside it (never over it).
 *
 * SAFETY: `constraint` is derived (decisionMapping.safetyConstraint) from the structured state the server stored with the Intelligence - never from prose - by the case card, which already
 * carries that state to the safety display; this panel never reads the safety object itself. A life-safety hazard is not something a person may simply
 * set aside: rejecting it requires a reason and what will be done instead (enforced by the server; this panel says so before the person tries).
 */
const NO_CONSTRAINT = Object.freeze({ level: "none", reasonRequired: false, alternativeRequired: false });

export default function DecisionPanel({ intelligence, constraint = NO_CONSTRAINT, decisionState }) {
  const { status, decision, busy, actionError, reload, propose, approve, reject } = decisionState;
  const [mode, setMode] = useState("idle"); // idle | confirmApprove | rejecting
  const [note, setNote] = useState("");
  const [alternative, setAlternative] = useState("");
  const role = KOI_WORKSPACE_ROLE;
  const mayReview = roleMayReview(role);

  if (status === "checking" || status === "idle") return <p className="muted asst-note" role="status">Checking for a decision…</p>;
  if (status === "loadError") {
    return (
      <div role="alert">
        <p className="op-form-error">The decision status could not be loaded.</p>
        <RetryButton onClick={reload} />
      </div>
    );
  }

  const error = actionError ? <p className="op-form-error" role="alert">{actionError}</p> : null;
  const safetyNote =
    constraint.level === "hazard" ? (
      <p className="asst-safety-note" role="note">
        <OctagonAlert size={16} strokeWidth={2} aria-hidden="true" />
        <span>
          This recommendation carries a life-safety hazard assessment. It cannot simply be set aside: rejecting it requires a recorded reason and what will be done
          instead, and the hazard needs immediate attention either way.
        </span>
      </p>
    ) : constraint.level === "critical" ? (
      <p className="asst-safety-note" role="note">
        <OctagonAlert size={16} strokeWidth={2} aria-hidden="true" />
        <span>This recommendation carries a critical safety assessment. Rejecting it requires a recorded reason.</span>
      </p>
    ) : null;

  const underReview = (
    <div className="asst-quote">
      <p className="asst-sub">AI recommendation under review (unchanged)</p>
      <p className="dash-text">{intelligence.recommendation}</p>
    </div>
  );

  const reset = () => {
    setMode("idle");
    setNote("");
    setAlternative("");
  };
  const submitReject = async (event) => {
    event.preventDefault();
    if (await reject({ note: note.trim(), alternative: alternative.trim() })) reset();
  };
  const reasonMissing = constraint.reasonRequired && note.trim().length === 0;
  const alternativeMissing = constraint.alternativeRequired && alternative.trim().length === 0;

  // The person's own step: confirm or turn down the recommendation. With no Decision recorded yet, confirming (or rejecting) records it first, then reviews it.
  const reviewControls = (
    <>
      {mode === "idle" ? (
        <div className="asst-actions">
          <button type="button" className="primary-button" onClick={() => setMode("confirmApprove")} disabled={busy}>Approve recommendation</button>
          <button type="button" className="text-button asst-reject" onClick={() => setMode("rejecting")} disabled={busy}>Reject / decide differently</button>
        </div>
      ) : null}
      {mode === "confirmApprove" ? (
        <div className="asst-confirm" role="group" aria-label="Confirm approval">
          <p className="asst-note">Approve this recommendation? This records your decision and makes its action ready for a person to carry out. EOI itself carries nothing out.</p>
          <div className="asst-actions">
            <button type="button" className="primary-button" onClick={async () => { if (await approve()) reset(); }} disabled={busy}>{busy ? "Recording…" : "Confirm approval"}</button>
            <button type="button" className="text-button" onClick={reset} disabled={busy}>Cancel</button>
          </div>
        </div>
      ) : null}
      {mode === "rejecting" ? (
        <form className="asst-reject-form" onSubmit={submitReject} aria-label="Reject the recommendation">
          <label className="asst-field-label" htmlFor="decision-reason">Reason{constraint.reasonRequired ? " (required)" : ""}</label>
          <textarea id="decision-reason" className="asst-input" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} aria-required={constraint.reasonRequired ? "true" : undefined} />
          <label className="asst-field-label" htmlFor="decision-alternative">What will be done instead{constraint.alternativeRequired ? " (required)" : " (optional)"}</label>
          <textarea id="decision-alternative" className="asst-input" rows={2} maxLength={2000} value={alternative} onChange={(e) => setAlternative(e.target.value)} aria-required={constraint.alternativeRequired ? "true" : undefined} />
          <p className="muted asst-note">Your decision is recorded next to the AI recommendation. It never replaces it, and nothing is carried out.</p>
          <div className="asst-actions">
            <button type="submit" className="primary-button" disabled={busy || reasonMissing || alternativeMissing}>{busy ? "Recording…" : "Record rejection"}</button>
            <button type="button" className="text-button" onClick={reset} disabled={busy}>Cancel</button>
          </div>
        </form>
      ) : null}
      {error}
    </>
  );

  // ---- no decision yet ----------------------------------------------------------------------------------------------------------------------------
  if (!decision) {
    return (
      <>
        {underReview}
        {safetyNote}
        {mayReview ? (
          <>
            <p className="asst-note">EOI recommends; you decide. Approve this recommendation, or reject it and record what you decide instead. Nothing is carried out.</p>
            {reviewControls}
          </>
        ) : (
          <>
            <p className="asst-note">EOI recommends; people decide. Submit this recommendation for review: someone with review permission then approves or rejects it. Nothing is carried out.</p>
            {roleMayPropose(role) ? (
              <button type="button" className="primary-button" onClick={propose} disabled={busy}>
                {busy ? "Submitting…" : "Submit for review"}
              </button>
            ) : (
              <p className="muted asst-note">Your role can read decisions but can&apos;t submit recommendations for review.</p>
            )}
            {error}
          </>
        )}
      </>
    );
  }

  // ---- reviewed -----------------------------------------------------------------------------------------------------------------------------------
  if (decision.status !== "proposed") {
    const approved = decision.status === "approved";
    return (
      <>
        {underReview}
        <div className="asst-human" data-outcome={decision.status}>
          <p className="asst-sub">Human decision</p>
          <p className="asst-outcome">
            <span className="status-chip" data-tone={decision.status}>{approved ? "Approved" : "Rejected"}</span>
            {decision.priority ? <span className="status-chip" data-tone={decision.priority}>{decision.priority} priority</span> : null}
          </p>
          <p className="asst-note">
            {approved ? "The recommendation stands." : "The recommendation was not accepted."} {decision.reviewedByYou ? "Reviewed by you" : "Reviewed by a colleague"}
            {decision.reviewedAt ? ` on ${formatShortDate(decision.reviewedAt)}` : ""}.
          </p>
          {decision.reviewNote ? <p className="dash-text"><strong>{approved ? "Note" : "Reason"}:</strong> {decision.reviewNote}</p> : null}
          {decision.alternative ? <p className="dash-text"><strong>Decided instead:</strong> {decision.alternative}</p> : null}
          <p className="muted asst-note">{approved ? "EOI has carried nothing out and never will on its own: the action below is ready for a person to do." : "This records a decision only. No action has been taken, and nothing will be carried out automatically."}</p>
        </div>
      </>
    );
  }

  // ---- submitted, waiting for a reviewer ----------------------------------------------------------------------------------------------------------
  if (!mayReview) {
    return (
      <>
        {underReview}
        {safetyNote}
        <p className="asst-note" role="status"><span className="status-chip" data-tone="proposed">In review</span> Waiting for someone with review permission.</p>
      </>
    );
  }

  // ---- the reviewer's step --------------------------------------------------------------------------------------------------------------------------
  return (
    <>
      {underReview}
      {safetyNote}
      <p className="asst-note" role="status">
        <span className="status-chip" data-tone="proposed">In review</span> {decision.proposedByYou ? "Submitted by you. Waiting for your decision." : "Submitted by a colleague. Review the recommendation above."}
      </p>
      {reviewControls}
    </>
  );
}
