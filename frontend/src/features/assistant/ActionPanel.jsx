import { useState } from "react";
import RetryButton from "../../components/auth/RetryButton";
import { KOI_WORKSPACE_ROLE } from "../../config/workspace";
import { formatShortDate } from "../../utils/formatDate";
import { actionAvailability } from "./actionMapping";
import { roleMayPropose, roleMayReview } from "./decisionMapping";

/**
 * ACTION: the proposal of what would be done, derived by the server from an APPROVED Decision (Phase 49). It is a RECORD, not an operation: nothing here sends, dispatches,
 * books, pays, calls a tool or changes anything outside this proposal, and the wording never implies otherwise ("Not executed" is always said).
 *
 * The page only shows the next step that is possible: with no approved Decision there is nothing to propose (a rejected Decision never produces one); an approved Decision
 * offers "Create action proposal"; a proposal offers "Approve action proposal" (after an explicit confirmation) or "Reject". The type, risk and urgency are the server's,
 * fixed by the analysis the Decision came from - a person never chooses them. `constraint` is derived (decisionMapping.safetyConstraint) from the structured state the server
 * stored with the Intelligence by the case card; this panel never reads the safety object itself. Permission and workspace membership are server rules.
 */
const NO_CONSTRAINT = Object.freeze({ level: "none", reasonRequired: false, alternativeRequired: false });
const NOT_EXECUTED = "Not executed. This records what would be done; nothing has been sent, dispatched or changed.";

export default function ActionPanel({ decision, constraint = NO_CONSTRAINT, actionState }) {
  const { status, action, busy, actionError, reload, propose, approve, reject } = actionState;
  const [mode, setMode] = useState("idle"); // idle | confirmApprove | rejecting
  const [note, setNote] = useState("");
  const role = KOI_WORKSPACE_ROLE;
  const availability = actionAvailability(decision);

  if (availability === "waiting") {
    return <p className="muted asst-note">An action proposal becomes available once the decision is approved.</p>;
  }
  if (availability === "closed") {
    return <p className="muted asst-note">This recommendation was not approved, so no action proposal is made.</p>;
  }
  if (status === "checking" || status === "idle") return <p className="muted asst-note" role="status">Checking for an action proposal…</p>;
  if (status === "loadError") {
    return (
      <div role="alert">
        <p className="op-form-error">The action proposal status could not be loaded.</p>
        <RetryButton onClick={reload} />
      </div>
    );
  }

  const error = actionError ? <p className="op-form-error" role="alert">{actionError}</p> : null;
  const safetyNote =
    constraint.level === "hazard" || constraint.level === "critical" ? (
      <p className="asst-note" role="note">
        This proposal follows the safety requirement recorded with the analysis: its type and urgency are fixed by it, and rejecting it needs a recorded reason.
      </p>
    ) : null;

  // ---- no proposal yet ------------------------------------------------------------------------------------------------------------------------------
  if (!action) {
    return (
      <>
        <p className="asst-note">
          The decision is approved. Create an action proposal: a record of what would be done. EOI does not carry it out.
        </p>
        {safetyNote}
        {roleMayPropose(role) ? (
          <button type="button" className="primary-button" onClick={propose} disabled={busy}>
            {busy ? "Creating…" : "Create action proposal"}
          </button>
        ) : (
          <p className="muted asst-note">Your role can read this case but can&apos;t create action proposals.</p>
        )}
        {error}
      </>
    );
  }

  const facts = (
    <>
      <p className="asst-chips">
        {action.typeLabel ? <span className="status-chip">{action.typeLabel}</span> : null}
        {action.riskLabel ? <span className="status-chip" data-tone={action.riskTone}>{action.riskLabel} risk</span> : null}
        {action.urgencyLabel ? <span className="status-chip">{action.urgencyLabel} urgency</span> : null}
      </p>
      <div className="asst-quote">
        <p className="asst-sub">What the approved decision says should be done</p>
        <p className="dash-text">{action.description}</p>
      </div>
    </>
  );

  // ---- reviewed -------------------------------------------------------------------------------------------------------------------------------------
  if (action.status !== "proposed") {
    const approved = action.status === "approved";
    return (
      <>
        <div className="asst-human" data-outcome={action.status}>
          <p className="asst-sub">Action proposal</p>
          <p className="asst-outcome">
            <span className="status-chip" data-tone={action.status}>{approved ? "Action approved" : "Action proposal rejected"}</span>
            <span className="status-chip">Not executed</span>
          </p>
          {facts}
          <p className="asst-note">
            {approved ? "Approved as ready." : "Not going ahead."} {action.reviewedByYou ? "Reviewed by you" : "Reviewed by a colleague"}
            {action.reviewedAt ? ` on ${formatShortDate(action.reviewedAt)}` : ""}.
          </p>
          {action.reviewNote ? <p className="dash-text"><strong>{approved ? "Note" : "Reason"}:</strong> {action.reviewNote}</p> : null}
          <p className="muted asst-note">{NOT_EXECUTED}</p>
        </div>
      </>
    );
  }

  // ---- proposed: waiting for a person ---------------------------------------------------------------------------------------------------------------
  if (!roleMayReview(role)) {
    return (
      <>
        <p className="asst-note" role="status"><span className="status-chip" data-tone="proposed">Ready for review</span> <span className="status-chip">Not executed</span></p>
        {facts}
        {safetyNote}
        <p className="muted asst-note">Waiting for someone with review permission.</p>
      </>
    );
  }
  const reset = () => {
    setMode("idle");
    setNote("");
  };
  const reasonMissing = constraint.level !== "none" && note.trim().length === 0;
  const submitReject = async (event) => {
    event.preventDefault();
    if (await reject({ note: note.trim() })) reset();
  };
  return (
    <>
      <p className="asst-note" role="status"><span className="status-chip" data-tone="proposed">Ready for review</span> <span className="status-chip">Not executed</span></p>
      {facts}
      {safetyNote}
      {mode === "idle" ? (
        <div className="asst-actions">
          <button type="button" className="primary-button" onClick={() => setMode("confirmApprove")} disabled={busy}>Approve action proposal</button>
          <button type="button" className="text-button asst-reject" onClick={() => setMode("rejecting")} disabled={busy}>Reject</button>
        </div>
      ) : null}
      {mode === "confirmApprove" ? (
        <div className="asst-confirm" role="group" aria-label="Confirm action approval">
          <p className="asst-note">Approve this action proposal? This records your approval. Nothing is carried out: no message is sent and nothing is dispatched.</p>
          <div className="asst-actions">
            <button type="button" className="primary-button" onClick={async () => { if (await approve()) reset(); }} disabled={busy}>{busy ? "Recording…" : "Confirm action approval"}</button>
            <button type="button" className="text-button" onClick={reset} disabled={busy}>Cancel</button>
          </div>
        </div>
      ) : null}
      {mode === "rejecting" ? (
        <form className="asst-reject-form" onSubmit={submitReject} aria-label="Reject the action proposal">
          <label className="asst-field-label" htmlFor="action-reason">Reason{constraint.level !== "none" ? " (required)" : " (optional)"}</label>
          <textarea id="action-reason" className="asst-input" rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} aria-required={constraint.level !== "none" ? "true" : undefined} />
          <div className="asst-actions">
            <button type="submit" className="primary-button" disabled={busy || reasonMissing}>{busy ? "Recording…" : "Record rejection"}</button>
            <button type="button" className="text-button" onClick={reset} disabled={busy}>Cancel</button>
          </div>
        </form>
      ) : null}
      {error}
    </>
  );
}
