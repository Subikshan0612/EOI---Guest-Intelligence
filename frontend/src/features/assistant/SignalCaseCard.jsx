import { useEffect } from "react";
import { Check, Minus, Sparkles } from "lucide-react";
import RetryButton from "../../components/auth/RetryButton";
import SignInButton from "../../components/auth/SignInButton";
import { formatStayDate } from "../../utils/formatDate";
import { formatStatusLabel } from "../operations/operationsMapping";
import { useSignalContext } from "../operations/useSignalContext";
import { useSignalDetail } from "../operations/useSignalDetail";
import ConfidenceBadge from "../dashboard/ConfidenceBadge";
import SafetyAssessment from "../intelligence/SafetyAssessment";
import { useSignalIntelligence } from "../intelligence/useSignalIntelligence";
import { describeContext } from "./assistantMapping";
import { CHECK_AGAIN_LABEL, HAZARD_NOTE, IN_PROGRESS_BODY, IN_PROGRESS_TITLE, STALLED_BODY, STATUS_UNAVAILABLE_BODY, isServerHazard } from "./analysisAttemptPresentation";
import CaseProgress from "./CaseProgress";
import ActionPanel from "./ActionPanel";
import DecisionPanel from "./DecisionPanel";
import OutcomePanel from "./OutcomePanel";
import { caseStages, safetyConstraint } from "./decisionMapping";
import { useCaseAction } from "./useCaseAction";
import { useCaseDecision } from "./useCaseDecision";
import { useCaseOutcome } from "./useCaseOutcome";

/**
 * One case in the conversation, in the words an operator uses: what EOI used, its assessment and recommendation (with the server-validated safety state), the person's
 * decision, the action that follows and what actually happened. Internally this is still Signal -> Context -> Intelligence -> Decision -> Action -> Outcome; this component adds
 * no pipeline and invents no record - it reads the existing endpoints through the existing hooks, and none of those words is shown.
 *
 *   WHAT EOI USED  the deterministic context (useSignalContext: GET /signals/:id/context) - only what that endpoint returned. The operating guidance (business knowledge) is
 *                  retrieved INSIDE the generation, so it is named only once an assessment exists; when nothing matched, it says so and the assessment rests on the records alone.
 *   ASSESSMENT     the stored analysis (a GET on open and on refresh: never a model call). Generation is requested by the page (useCaseGeneration) right after the person sends the report
 *                  and by the visible button here; this card READS again when a request finishes. The safety state is the server's, shown exactly as stored.
 *   DECISION / ACTION / OUTCOME  the existing panels: they only read until a person presses a button. Approving a recommendation also makes its action ready (useCaseAction.prepareFor);
 *                  nothing is carried out by EOI.
 * No id, evidence reference, rule code, score or provider message is displayed.
 */
export default function SignalCaseCard({ signalId, severityStated, generation, onGenerate, onObserve, onRefresh, onRelease }) {
  const { signal, status, refs, reload } = useSignalDetail(signalId);
  const { context, status: contextStatus, reload: reloadContext } = useSignalContext(signalId);
  const intel = useSignalIntelligence(signalId);
  const reloadIntelligence = intel.reload;
  const generationVersion = generation?.version ?? 0;
  // A request for this report finished (on this page): read the stored result. A READ only.
  useEffect(() => {
    if (generationVersion > 0) reloadIntelligence();
  }, [generationVersion, reloadIntelligence]);
  // Re-entry (refresh, coming back to the page): when no assessment is shown, READ the state of this report's analysis once - never start one. If it is still running the page shows
  // that and follows it; if it finished while the person was away the existing read shows the stored assessment (version change above); if it failed it says so. When the report
  // leaves the screen, following it stops (the backend attempt carries on).
  const noAssessmentShown = intel.status === "idle";
  useEffect(() => {
    if (noAssessmentShown) onObserve?.(signalId);
    return () => onRelease?.(signalId);
  }, [noAssessmentShown, signalId, onObserve, onRelease]);
  // The Decision for the stored analysis. It only READS until a person presses one of the panel's buttons; it never touches the AI.
  const decisionState = useCaseDecision(intel.status === "ready" ? intel.intelligence?.id : null);
  // The Action, only once the Decision is APPROVED. Like the Decision it only READS until a person presses a button, and never touches the AI.
  const actionState = useCaseAction(decisionState.decision?.status === "approved" ? decisionState.decision.id : null);
  // The Outcome a PERSON recorded for the APPROVED Action. It only READS until they confirm the form; it never touches the AI and nothing feeds Learning.
  const outcomeState = useCaseOutcome(actionState.action?.status === "approved" ? actionState.action.id : null);

  if (status === "loading") return <p className="muted asst-note" role="status">Loading this report…</p>;
  if (status === "missing") return <p className="muted asst-note">This report is no longer available.</p>;
  if (status === "error" || !signal) {
    return (
      <p className="asst-note" role="alert">
        This report could not be loaded. <RetryButton onClick={reload} />
      </p>
    );
  }

  const where = [refs.unit ? `Room ${refs.unit}` : null, refs.property].filter(Boolean).join(" · ");
  const view = describeContext({ context, contextStatus, intelligence: intel.intelligence });
  const stages = caseStages({ intelligenceReady: intel.status === "ready" && Boolean(intel.intelligence), assessing: generation?.inProgress === true, decision: decisionState.decision, action: actionState.action, outcome: outcomeState.outcome });

  // One approval by a person who may review: the recommendation is approved and its action is made ready (nothing is carried out).
  const panelDecisionState = {
    ...decisionState,
    approve: async (note) => {
      const approved = await decisionState.approve(note);
      if (approved) await actionState.prepareFor(approved.id);
      return approved;
    },
  };
  const preparing = actionState.busy && !actionState.action;

  return (
    <div className="asst-case">
      <CaseProgress stages={stages} />

      <section className="koi-card asst-stage" aria-labelledby={`stage-used-${signalId}`}>
        <p className="intel-section-label" id={`stage-used-${signalId}`}>What EOI used</p>
        <p className="asst-signal-title">{signal.title}</p>
        <p className="asst-chips">
          {where ? <span className="status-chip">{where}</span> : null}
          <span className="status-chip" data-tone={signal.type}>{formatStatusLabel(signal.type)}</span>
          {severityStated ? <span className="status-chip" data-tone={signal.severity}>{formatStatusLabel(signal.severity)}</span> : null}
        </p>
        {contextStatus === "loading" ? <p className="muted asst-note" role="status">Gathering the records…</p> : null}
        {contextStatus === "error" ? (
          <p className="asst-note" role="alert">
            The records for this report aren&apos;t available right now (this may need a higher role). <RetryButton onClick={reloadContext} />
          </p>
        ) : null}
        {contextStatus === "ready" ? (
          <>
            <ul className="asst-checklist">
              {view.operational.map((item) => (
                <li key={item.key} data-present={item.present ? "true" : "false"}>
                  {item.present ? <Check size={15} strokeWidth={2} aria-hidden="true" /> : <Minus size={15} strokeWidth={2} aria-hidden="true" />}
                  <span>{item.label}</span>
                  <span className="muted asst-note">{item.present ? recordDetail(item.key, context) : "none on record for this report"}</span>
                </li>
              ))}
            </ul>
            <h3 className="asst-sub">Earlier reports</h3>
            <p className="asst-note">{view.history.available ? `${view.history.count} earlier report${view.history.count === 1 ? "" : "s"} on record for this room, guest or property. Only those about the same kind of problem inform the assessment.` : "None on record"}</p>
            {view.recurrence ? (
              <div className="asst-recurrence">
                <p className="asst-note">
                  <strong>{view.recurrence.headline}</strong>
                </p>
                {view.recurrence.lines.map((line) => (
                  <p key={line} className="asst-note">
                    {line}
                  </p>
                ))}
                <p className="muted asst-note">{view.recurrence.caveat}</p>
              </div>
            ) : null}
            <h3 className="asst-sub">Operating guidance</h3>
            {view.guidance.state === "listed" ? (
              <ul className="asst-bullets">
                {view.guidance.titles.map((title) => (
                  <li key={title}>{title}</li>
                ))}
              </ul>
            ) : view.guidance.state === "none" ? (
              <p className="muted asst-note">Nothing in your operating guidance matched this report, so the assessment rests on the records above alone. It does not claim any company policy.</p>
            ) : (
              <p className="muted asst-note">Matched against your operating guidance when the assessment is made.</p>
            )}
          </>
        ) : null}
      </section>

      <AssessmentSection intel={intel} generation={generation} onGenerate={() => onGenerate?.(signalId)} onRefresh={() => onRefresh?.(signalId)} hazard={isServerHazard(signal)} signalId={signalId} />

      {intel.status === "ready" && intel.intelligence ? (
        <section className="koi-card asst-stage asst-decision" aria-labelledby={`stage-decision-${signalId}`}>
          <p className="intel-section-label" id={`stage-decision-${signalId}`}>Your decision</p>
          <DecisionPanel intelligence={intel.intelligence} constraint={safetyConstraint(intel.intelligence.safety)} decisionState={panelDecisionState} />
        </section>
      ) : null}

      {intel.status === "ready" && intel.intelligence && decisionState.status === "ready" && decisionState.decision?.status === "approved" ? (
        <section className="koi-card asst-stage asst-action-stage" aria-labelledby={`stage-action-${signalId}`}>
          <p className="intel-section-label" id={`stage-action-${signalId}`}>Action</p>
          {preparing ? (
            <p className="muted asst-note" role="status">Making the action ready…</p>
          ) : (
            <ActionPanel decision={decisionState.decision} constraint={safetyConstraint(intel.intelligence.safety)} actionState={actionState} />
          )}
        </section>
      ) : null}

      {intel.status === "ready" && intel.intelligence && decisionState.status === "ready" && decisionState.decision?.status === "approved" ? (
        <section className="koi-card asst-stage asst-outcome-stage" aria-labelledby={`stage-outcome-${signalId}`}>
          <p className="intel-section-label" id={`stage-outcome-${signalId}`}>Outcome</p>
          <OutcomePanel action={actionState.action} outcomeState={outcomeState} />
        </section>
      ) : null}
    </div>
  );
}

/** What a linked record is, in a few plain words - taken only from what the context endpoint returned (never an id). */
function recordDetail(key, context) {
  if (key === "guest" && context?.guest?.available) {
    const name = [context.guest.firstName, context.guest.lastName].filter(Boolean).join(" ");
    return name || "on record";
  }
  if (key === "stay" && context?.stay?.available) {
    const dates = [context.stay.checkIn ? formatStayDate(context.stay.checkIn) : null, context.stay.checkOut ? formatStayDate(context.stay.checkOut) : null].filter(Boolean).join(" – ");
    const status = context.stay.status ? formatStatusLabel(context.stay.status) : "";
    return [context.stay.reservationId ? `#${context.stay.reservationId}` : null, status, dates].filter(Boolean).join(" · ") || "on record";
  }
  return "on record";
}

// Exported for the deterministic render tests (validate-hybrid-5b-status-ux.mjs); it is only ever used by SignalCaseCard.
export function AssessmentSection({ intel, generation, onGenerate, onRefresh, hazard, signalId }) {
  const { status, intelligence, loadReason, reload } = intel;
  const busy = generation?.busy === true;
  const failure = generation?.failure ?? null;
  const label = <p className="intel-section-label intel-section-label-intelligence" id={`stage-assessment-${signalId}`}>Assessment</p>;

  let body;
  if (status === "ready" && intelligence) {
    body = (
      <>
        <SafetyAssessment safety={intelligence.safety} />
        <section className="koi-card dash-block" aria-label="Assessment">
          <p className="muted dash-note">Generated by AI from your records and guidance. It is a recommendation for a person to review, not a fact.</p>
          <h4 className="card-label">What is happening</h4>
          <p className="dash-text">{intelligence.situation}</p>
          {intelligence.evidence.length ? (
            <>
              <h4 className="card-label">Based on</h4>
              <ul className="dash-evidence">
                {intelligence.evidence.map((item, i) => (
                  <li key={i}>{typeof item === "string" ? item : JSON.stringify(item)}</li>
                ))}
              </ul>
            </>
          ) : null}
          <h4 className="card-label">Why it matters</h4>
          <p className="dash-text">{intelligence.impact}</p>
          <h4 className="card-label">Confidence</h4>
          <ConfidenceBadge confidence={intelligence.confidence} withExplanation />
        </section>
        <section className="koi-card dash-block" aria-label="Recommendation">
          <h4 className="card-label">Recommendation</h4>
          <p className="dash-text">{intelligence.recommendation}</p>
        </section>
      </>
    );
  } else if (busy) {
    body = <p className="muted asst-note" role="status">Assessing this against your records and guidance…</p>;
  } else if (generation?.inProgress || generation?.stalled) {
    // Workstream 5B: the analysis is still running. This is NOT a failure and offers no "try again": the request is still being worked on, and the backend decides when it ends.
    // The wording is fixed (analysisAttemptPresentation.js): no percentage, no estimate, no provider detail. For a report the server classified as a safety hazard one sentence
    // is added so that waiting for the assessment is never read as waiting to deal with the hazard.
    const stalled = generation.stalled;
    const unavailable = generation.statusUnavailable;
    body = (
      <div className="asst-working" role="status" aria-live="polite">
        <p className="asst-working-title">{IN_PROGRESS_TITLE}</p>
        <p className="muted asst-note">{stalled ? STALLED_BODY : unavailable ? STATUS_UNAVAILABLE_BODY : IN_PROGRESS_BODY}</p>
        {hazard ? <p className="asst-hazard-note">{HAZARD_NOTE}</p> : null}
        {stalled || unavailable ? (
          <button type="button" className="text-button" onClick={onRefresh}>
            {CHECK_AGAIN_LABEL}
          </button>
        ) : null}
      </div>
    );
  } else if (failure) {
    body = (
      <div role="alert">
        <p className="op-form-error">{failure.title}</p>
        <p className="muted asst-note">{failure.message}</p>
        {hazard ? <p className="asst-hazard-note">{HAZARD_NOTE}</p> : null}
        {failure.retryable ? <RetryButton onClick={onGenerate} /> : null}
      </div>
    );
  } else if (status === "checking" || generation?.checking) {
    body = <p className="muted asst-note" role="status">Checking for a saved assessment…</p>;
  } else if (status === "loadError") {
    body = (
      <div role="alert">
        {loadReason === "unauthenticated" ? (
          <>
            <p className="op-form-error">Sign in required</p>
            <SignInButton className="text-button" />
          </>
        ) : loadReason === "forbidden" ? (
          <p className="op-form-error">Your role can&apos;t read assessments in this workspace.</p>
        ) : (
          <>
            <p className="op-form-error">The saved assessment could not be loaded.</p>
            <RetryButton onClick={reload} />
          </>
        )}
      </div>
    );
  } else {
    body = (
      <div className="asst-generate">
        <p className="muted asst-note">There is no assessment for this report yet.</p>
        <button type="button" className="primary-button" onClick={onGenerate}>
          <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
          Assess this
        </button>
      </div>
    );
  }

  return (
    <section className="asst-stage asst-intel" aria-labelledby={`stage-assessment-${signalId}`}>
      {label}
      {body}
    </section>
  );
}
