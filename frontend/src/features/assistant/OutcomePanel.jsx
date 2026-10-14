import { useState } from "react";
import RetryButton from "../../components/auth/RetryButton";
import { KOI_WORKSPACE_ROLE } from "../../config/workspace";
import { formatShortDate } from "../../utils/formatDate";
import { OUTCOME_CHOICES, OUTCOME_TEXT_MAX, outcomeAvailability } from "./outcomeMapping";
import { roleMayPropose } from "./decisionMapping";

/**
 * OUTCOME: what a PERSON says actually happened after an approved Action (Phase 50). "Record what happened" - not "ask the AI": nothing here is generated, inferred,
 * checked or sent anywhere. The Action was never executed by EOI, so an outcome is the person's own report of the real world (the work was done, partly done, failed, was
 * blocked, or is unknown), kept beside - never over - the recommendation, the decision and the action proposal. It is recorded once and is not edited afterwards.
 *
 * The page offers the form only for an APPROVED Action (a proposed one has nothing to report on; a rejected one will never be carried out). Permission and workspace
 * membership are server rules; the role only decides whether the form is shown.
 */
export default function OutcomePanel({ action, outcomeState }) {
  const { status, outcome, busy, actionError, reload, record } = outcomeState;
  const [mode, setMode] = useState("idle"); // idle | form | confirm
  const [result, setResult] = useState("success");
  const [text, setText] = useState("");
  const role = KOI_WORKSPACE_ROLE;
  const availability = outcomeAvailability(action);

  if (availability === "waiting") return <p className="muted asst-note">An outcome can be recorded once the action proposal is approved.</p>;
  if (availability === "closed") return <p className="muted asst-note">This action proposal was rejected, so there is nothing to record an outcome for.</p>;
  if (status === "checking" || status === "idle") return <p className="muted asst-note" role="status">Checking for a recorded outcome…</p>;
  if (status === "loadError") {
    return (
      <div role="alert">
        <p className="op-form-error">The outcome status could not be loaded.</p>
        <RetryButton onClick={reload} />
      </div>
    );
  }

  const error = actionError ? <p className="op-form-error" role="alert">{actionError}</p> : null;

  // ---- recorded -------------------------------------------------------------------------------------------------------------------------------------
  if (outcome) {
    return (
      <div className="asst-human" data-outcome={outcome.status}>
        <p className="asst-sub">Outcome</p>
        <p className="asst-outcome">
          <span className="status-chip" data-tone={outcome.status}>{outcome.statusLabel}</span>
        </p>
        <p className="asst-note">
          {outcome.recordedByYou ? "Recorded by you" : "Recorded by a colleague"}
          {outcome.recordedAt ? ` on ${formatShortDate(outcome.recordedAt)}` : ""}.
        </p>
        {outcome.observation ? <p className="dash-text">{outcome.observation}</p> : null}
        <p className="muted asst-note">Reported by a person. EOI did not observe or check this, and recording it changed nothing else.</p>
      </div>
    );
  }

  // ---- nothing recorded yet -------------------------------------------------------------------------------------------------------------------------
  if (!roleMayPropose(role)) return <p className="muted asst-note">Your role can read this case but can&apos;t record outcomes.</p>;

  const reset = () => {
    setMode("idle");
    setText("");
    setResult("success");
  };
  const empty = text.trim().length === 0;

  return (
    <>
      <p className="asst-note">
        The action proposal is approved; EOI has not carried it out. Record what actually happened, in your own words. EOI does not check it, send it anywhere or act on it.
      </p>
      {mode === "idle" ? (
        <button type="button" className="primary-button" onClick={() => setMode("form")} disabled={busy}>Record outcome</button>
      ) : null}
      {mode === "form" ? (
        <form
          className="asst-reject-form"
          aria-label="Record what happened"
          onSubmit={(event) => {
            event.preventDefault();
            if (!empty) setMode("confirm");
          }}
        >
          <label className="asst-field-label" htmlFor="outcome-result">Result</label>
          <select id="outcome-result" className="asst-input" value={result} onChange={(e) => setResult(e.target.value)}>
            {OUTCOME_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>{choice.label} - {choice.hint}</option>
            ))}
          </select>
          <label className="asst-field-label" htmlFor="outcome-text">What happened (required)</label>
          <textarea id="outcome-text" className="asst-input" rows={3} maxLength={OUTCOME_TEXT_MAX} value={text} onChange={(e) => setText(e.target.value)} aria-required="true" />
          <div className="asst-actions">
            <button type="submit" className="primary-button" disabled={busy || empty}>Review outcome</button>
            <button type="button" className="text-button" onClick={reset} disabled={busy}>Cancel</button>
          </div>
        </form>
      ) : null}
      {mode === "confirm" ? (
        <div className="asst-confirm" role="group" aria-label="Confirm outcome">
          <p className="asst-note">
            Record this outcome as <strong>{OUTCOME_CHOICES.find((c) => c.value === result)?.label}</strong>? It is saved as your own report and is not edited afterwards. Nothing is sent or carried out.
          </p>
          <p className="dash-text">{text.trim()}</p>
          <div className="asst-actions">
            <button type="button" className="primary-button" onClick={async () => { if (await record({ status: result, summary: text.trim() })) reset(); }} disabled={busy}>{busy ? "Recording…" : "Confirm outcome"}</button>
            <button type="button" className="text-button" onClick={() => setMode("form")} disabled={busy}>Back</button>
          </div>
        </div>
      ) : null}
      {error}
    </>
  );
}
