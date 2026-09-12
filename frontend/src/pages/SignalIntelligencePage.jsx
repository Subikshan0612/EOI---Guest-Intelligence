import { Link, useParams } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { useSignalDetail } from "../features/operations/useSignalDetail";
import { useSignalContext } from "../features/operations/useSignalContext";
import { useMockIntelligence } from "../features/intelligence/useMockIntelligence";
import SignalOperationalContext from "../features/operations/SignalOperationalContext";
import IntelligenceSignalSummary from "../features/intelligence/IntelligenceSignalSummary";
import IntelligenceProvenance from "../features/intelligence/IntelligenceProvenance";
import {
  ActionCard,
  DecisionCard,
  IntelligenceCard,
  OutcomeCard,
  RiskIndicator,
} from "../features/intelligence/cards";

/**
 * Signal → Operational Context → Intelligence, on one page.
 *
 * The first two sections are operational fact, read from MongoDB via the
 * Phase 3D context endpoint. The last is the existing mock intelligence
 * generator's interpretation of that same signal — clearly separated so an
 * operator never mistakes a suggestion for a database record.
 */
export default function SignalIntelligencePage() {
  const { signalId } = useParams();
  const { signal, status, error, reload } = useSignalDetail(signalId);
  const {
    context,
    status: contextStatus,
    error: contextError,
    reload: reloadContext,
  } = useSignalContext(signalId);
  const {
    intelligence,
    status: intelStatus,
    error: intelError,
    reload: reloadIntelligence,
  } = useMockIntelligence(signal);

  const backLink = (
    <Link to={`/operations/signals/${signalId}`} className="text-button op-back-link">
      <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
      Back to signal
    </Link>
  );

  if (status === "loading") {
    return (
      <article className="page">
        {backLink}
        <p className="muted">Loading signal…</p>
      </article>
    );
  }

  if (status === "missing") {
    return (
      <article className="page">
        <section className="investigation-state">
          <p className="page-kicker">Operations · Intelligence</p>
          <h1 className="page-title">Signal not found</h1>
          <p className="page-lead">
            This signal is no longer available. It may have been deleted, or the link is invalid.
          </p>
          {backLink}
        </section>
      </article>
    );
  }

  if (status === "error") {
    return (
      <article className="page">
        <section className="investigation-state" role="alert">
          <p className="page-kicker">Operations · Intelligence</p>
          <h1 className="page-title">Couldn’t load this signal</h1>
          <p className="page-lead">{error}</p>
          <button type="button" className="text-button" onClick={reload}>
            Try again
          </button>
        </section>
      </article>
    );
  }

  return (
    <article className="page op-page intel-page">
      {backLink}

      <header className="op-page-header">
        <div>
          <p className="page-kicker">Operations · Signal Intelligence</p>
          <h1 className="page-title">{signal.title}</h1>
          <p className="page-lead">
            What happened, the operational context around it, and KOI's current interpretation.
          </p>
        </div>
      </header>

      <div className="intel-flow" aria-hidden="true">
        <span>Signal</span>
        <span className="intel-flow-arrow">→</span>
        <span>Context</span>
        <span className="intel-flow-arrow">→</span>
        <span>Intelligence</span>
      </div>

      <section className="koi-card">
        <p className="intel-section-label">Fact · Signal</p>
        <IntelligenceSignalSummary signal={signal} />
      </section>

      <SignalOperationalContext
        context={context}
        status={contextStatus}
        error={contextError}
        onRetry={reloadContext}
      />

      <section className="intel-section">
        <p className="intel-section-label intel-section-label-intelligence">
          Intelligence · current interpretation, not a database fact
        </p>
        {intelStatus === "loading" ? (
          <p className="muted">Generating intelligence…</p>
        ) : intelStatus === "error" ? (
          <div className="investigation-state" role="alert">
            <p className="op-form-error">{intelError}</p>
            <button type="button" className="text-button" onClick={reloadIntelligence}>
              Try again
            </button>
          </div>
        ) : intelligence ? (
          <div className="intel-grid">
            <IntelligenceCard intelligence={intelligence.intelligence} />
            <RiskIndicator risk={intelligence.risk} />
            <DecisionCard decision={intelligence.decision} />
            <ActionCard action={intelligence.action} />
            <OutcomeCard outcome={intelligence.outcome} />
          </div>
        ) : (
          <p className="muted">No intelligence available for this signal yet.</p>
        )}
      </section>

      <IntelligenceProvenance status={intelStatus} />
    </article>
  );
}
