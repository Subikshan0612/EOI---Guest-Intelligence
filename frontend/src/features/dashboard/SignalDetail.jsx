import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import ActionStatusNote from "./ActionStatusNote";
import AnalysisBlock from "./AnalysisBlock";
import DecisionBlock from "./DecisionBlock";
import ObservedBlock from "./ObservedBlock";
import ProvenanceList from "./ProvenanceList";
import RecommendationBlock from "./RecommendationBlock";
import SafetyAssessment from "../intelligence/SafetyAssessment";
import SignalSeverityNote from "../intelligence/SignalSeverityNote";
import { resolveDecision } from "./dashboardMapping";
import RetryButton from "../../components/auth/RetryButton";

export default function SignalDetail({ signalId, detail, status, error, onRetry, showBack, decisions, onRetryDecisions }) {
  const back = showBack ? (
    <Link to="/intelligence" className="text-button dash-back">
      <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
      All signals
    </Link>
  ) : null;

  if (!signalId) {
    return (
      <section className="koi-card dash-detail-empty" aria-label="No Signal selected">
        <p className="card-label">Signal detail</p>
        <h2 className="dash-empty-title">Select a Signal</h2>
        <p className="muted">
          Choose a Signal from the list to see what was recorded and what its stored analysis says.
        </p>
        <ol className="dash-empty-steps">
          <li>
            <span>Observed</span> Recorded operational data
          </li>
          <li>
            <span>Intelligence</span> Stored AI interpretation
          </li>
          <li>
            <span>Recommendation</span> Guidance, not yet actioned
          </li>
          <li>
            <span>Provenance</span> Knowledge sections used
          </li>
        </ol>
      </section>
    );
  }
  if (status === "unconfigured") {
    return (
      <div className="investigation-state">
        {back}
        <p className="muted">No workspace is configured.</p>
      </div>
    );
  }
  if (status === "loading" || status === "idle") {
    return (
      <div className="dash-detail" aria-busy="true">
        {back}
        <div className="dash-skeleton dash-skeleton-tall" aria-label="Loading signal" />
        <div className="dash-skeleton dash-skeleton-tall" aria-hidden="true" />
      </div>
    );
  }
  if (status === "missing") {
    return (
      <div className="investigation-state">
        {back}
        <p className="muted">This Signal could not be found in this workspace.</p>
      </div>
    );
  }
  if (status === "error" || !detail) {
    return (
      <div className="investigation-state" role="alert">
        {back}
        <p className="muted">{error || "Could not load this signal."}</p>
        <RetryButton onClick={onRetry} />
      </div>
    );
  }

  const { signal, observed, analysis } = detail;
  return (
    <div className="dash-detail">
      {back}
      {signal.synthetic ? <span className="synthetic-tag">Synthetic test</span> : null}
      <SignalSeverityNote severity={signal.severity} />
      <ObservedBlock signal={signal} observed={observed} />
      {analysis ? (
        <>
          <SafetyAssessment safety={analysis.safety} />
          <AnalysisBlock analysis={analysis} />
          <RecommendationBlock text={analysis.recommendation} />
          <ProvenanceList provenance={analysis.provenance} />
          <DecisionBlock resolved={resolveDecision(decisions, analysis.id)} onRetry={onRetryDecisions} />
        </>
      ) : (
        <section className="koi-card dash-block" aria-labelledby="dash-not-analyzed">
          <p className="intel-section-label intel-section-label-intelligence" id="dash-not-analyzed">
            Intelligence
          </p>
          <h4 className="dash-signal-title">Not analyzed</h4>
          <p className="muted">No stored Intelligence V1 analysis is available for this Signal.</p>
        </section>
      )}
      <ActionStatusNote />
    </div>
  );
}
