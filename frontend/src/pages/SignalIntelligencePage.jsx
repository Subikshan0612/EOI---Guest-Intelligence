import { Link, useParams } from "react-router-dom";
import { ChevronLeft, Sparkles } from "lucide-react";
import { useSignalDetail } from "../features/operations/useSignalDetail";
import { useSignalContext } from "../features/operations/useSignalContext";
import { useSignalIntelligence } from "../features/intelligence/useSignalIntelligence";
import SignalOperationalContext from "../features/operations/SignalOperationalContext";
import IntelligenceSignalSummary from "../features/intelligence/IntelligenceSignalSummary";
import IntelligenceResult from "../features/intelligence/IntelligenceResult";
import IntelligenceProvenance from "../features/intelligence/IntelligenceProvenance";

/**
 * Signal → Operational Context → AI Intelligence, on one page.
 *
 * The first two sections are operational fact, read from MongoDB via the
 * Phase 3D context endpoint. The Intelligence section is a real LLM call
 * (Phase 4) — it is never triggered automatically (no effect calls it on
 * mount or on refresh); the operator must explicitly ask KOI to analyze the
 * signal, and the result is always labeled as AI-generated interpretation,
 * never as a database record.
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
    generate: generateIntelligence,
  } = useSignalIntelligence(signalId);

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
            What happened, the operational context around it, and what EOI's AI engine makes of it.
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
          Intelligence · AI-generated interpretation, not a database fact
        </p>

        {intelStatus === "idle" ? (
          <div className="investigation-state">
            <p className="muted">Ready to analyze this signal.</p>
            <button type="button" className="primary-button" onClick={generateIntelligence}>
              <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
              Generate Intelligence
            </button>
          </div>
        ) : intelStatus === "loading" ? (
          <p className="muted">Analyzing operational context…</p>
        ) : intelStatus === "unconfigured" ? (
          <div className="investigation-state" role="alert">
            <p className="op-form-error">{intelError}</p>
            <p className="muted">
              Set <code>LLM_PROVIDER</code> and its matching API key in the backend environment to
              enable AI intelligence.
            </p>
          </div>
        ) : intelStatus === "error" ? (
          <div className="investigation-state" role="alert">
            <p className="op-form-error">{intelError}</p>
            <button type="button" className="text-button" onClick={generateIntelligence}>
              Try again
            </button>
          </div>
        ) : intelStatus === "ready" && intelligence ? (
          <>
            <div className="intel-grid">
              <IntelligenceResult result={intelligence} />
            </div>
            <IntelligenceProvenance
              confidence={intelligence.confidence}
              provenance={intelligence.provenance}
            />
            <div className="op-form-actions">
              <button type="button" className="text-button" onClick={generateIntelligence}>
                Regenerate
              </button>
            </div>
          </>
        ) : null}
      </section>
    </article>
  );
}
