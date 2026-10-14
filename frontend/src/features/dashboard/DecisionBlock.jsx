import SignInButton from "../../components/auth/SignInButton";
import ConfidenceBadge from "./ConfidenceBadge";
import { DECISION_STATUS_LABELS, formatLabel } from "./dashboardMapping";
import { formatShortDate } from "../../utils/formatDate";
import RetryButton from "../../components/auth/RetryButton";

/**
 * Read-only Decision V1. A Decision is a proposal derived from the stored
 * Intelligence; it says nothing about anything having been done, and there is no
 * reviewer identity to show (none exists), so none is ever claimed.
 */
export default function DecisionBlock({ resolved, onRetry }) {
  const { state, decision } = resolved;
  if (state === "na") return null;

  let body;
  if (state === "loading") {
    body = <p className="muted">Loading Decision status…</p>;
  } else if (state === "unavailable" && resolved.reason === "unauthenticated") {
    body = (
      <div role="alert">
        <p className="dash-decision-status">Sign in required</p>
        <p className="muted">Decision status can&apos;t be shown until you sign in again.</p>
        <SignInButton className="text-button" />
      </div>
    );
  } else if (state === "unavailable" && resolved.reason === "forbidden") {
    body = (
      <div role="alert">
        <p className="dash-decision-status">Not authorized</p>
        <p className="muted">This identity is not permitted to read Decisions in this workspace.</p>
      </div>
    );
  } else if (state === "unavailable") {
    body = (
      <div role="alert">
        <p className="muted">Decision status unavailable.</p>
        <RetryButton onClick={onRetry} />
      </div>
    );
  } else if (state === "none") {
    body = (
      <>
        <p className="dash-decision-status">Not proposed</p>
        <p className="muted">No Decision has been proposed for this analysis.</p>
      </>
    );
  } else {
    const reviewed = decision.status !== "proposed";
    body = (
      <>
        <dl className="context-dl">
          <div className="dash-dl-row">
            <dt>Status</dt>
            <dd>
              <span className="status-chip" data-tone={decision.status}>
                {DECISION_STATUS_LABELS[decision.status]}
              </span>
            </dd>
          </div>
          <div className="dash-dl-row">
            <dt>Priority</dt>
            <dd>
              <span className="status-chip" data-tone={decision.priority}>
                {formatLabel(decision.priority)}
              </span>
            </dd>
          </div>
          <div className="dash-dl-row">
            <dt>Confidence</dt>
            <dd>
              <ConfidenceBadge confidence={decision.confidence} />
            </dd>
          </div>
          {reviewed ? (
            <div className="dash-dl-row">
              <dt>Reviewed</dt>
              <dd>{decision.reviewedAt ? formatShortDate(decision.reviewedAt) : "—"}</dd>
            </div>
          ) : null}
          {reviewed && decision.reviewNote ? (
            <div className="dash-dl-row">
              <dt>Review note</dt>
              <dd className="dash-text">{decision.reviewNote}</dd>
            </div>
          ) : null}
        </dl>
        <h4 className="card-label">Proposal</h4>
        <p className="muted dash-note">Snapshot of the stored recommendation</p>
        <p className="dash-text">{decision.description}</p>
        {decision.status === "proposed" ? <p className="muted">Waiting for human review.</p> : null}
        <p className="muted dash-note">
          A Decision is a proposal. Its status does not mean any action was taken.
        </p>
      </>
    );
  }

  return (
    <section className="koi-card dash-block" aria-labelledby="dash-decision">
      <p className="intel-section-label intel-section-label-intelligence" id="dash-decision">
        Decision
      </p>
      <p className="muted dash-note">Proposal status, separate from the recommendation above</p>
      {body}
    </section>
  );
}
