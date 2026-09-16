import { useState } from "react";
import { useLearningReport } from "../features/learning/useLearningReport";
import LearningSummary from "../features/learning/LearningSummary";
import LearningCoverage from "../features/learning/LearningCoverage";
import LearningBreakdown from "../features/learning/LearningBreakdown";

/**
 * Phase 7E — consumes the Phase 7D `GET /api/learning` report and presents
 * it as three layers an operator can read straight through: what happened
 * (outcome distribution), how complete the operational loop is (chain
 * coverage), and the traceable Decision -> Action -> Outcome graph itself.
 *
 * Only `from`/`to` are exposed as filters here (Part 7) — the API also
 * supports intelligenceId/decisionId/actionId, but this page has no picker
 * for any of those yet, and a raw ObjectId text field would not be a useful
 * filter for an operator. The traceable breakdown's own expand/collapse is
 * the practical way to narrow focus to one Decision today.
 */
export default function LearningPage() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { report, status, error, reload } = useLearningReport({ from, to });

  if (status === "unconfigured") {
    return (
      <article className="page">
        <section className="investigation-state">
          <p className="page-kicker">Intelligence</p>
          <h1 className="page-title">Learning</h1>
          <p className="page-lead">
            No development workspace is configured, so the learning report can’t be loaded. Set{" "}
            <code>VITE_KOI_WORKSPACE_ID</code> in <code>frontend/.env</code> to a real workspace id.
          </p>
        </section>
      </article>
    );
  }

  return (
    <article className="page learning-page">
      <header className="op-page-header">
        <div>
          <p className="page-kicker">Intelligence</p>
          <h1 className="page-title">Learning</h1>
          <p className="page-lead">
            What happened after Signal → Context → Intelligence → Decision → Action → Outcome, for
            this workspace.
          </p>
        </div>
      </header>

      <form
        className="op-filter-bar"
        onSubmit={(event) => event.preventDefault()}
        aria-label="Filter by date recorded"
      >
        <div className="op-field op-field-narrow">
          <label className="op-field-label" htmlFor="learning-from">
            From
          </label>
          <input
            id="learning-from"
            type="date"
            className="op-field-input"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </div>
        <div className="op-field op-field-narrow">
          <label className="op-field-label" htmlFor="learning-to">
            To
          </label>
          <input
            id="learning-to"
            type="date"
            className="op-field-input"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
        {from || to ? (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setFrom("");
              setTo("");
            }}
          >
            Clear dates
          </button>
        ) : null}
      </form>
      <p className="muted learning-filter-note">
        Date filters apply to when each Outcome occurred, not when a Decision or Action was
        created.
      </p>

      {status === "loading" ? <p className="muted">Loading learning report…</p> : null}

      {status === "error" ? (
        <section className="investigation-state" role="alert">
          <p className="page-lead">{error}</p>
          <button type="button" className="text-button" onClick={reload}>
            Try again
          </button>
        </section>
      ) : null}

      {status === "ready" && report ? (
        report.counts.decisions.total === 0 &&
        report.counts.actions.total === 0 &&
        report.counts.outcomes.total === 0 ? (
          <section className="investigation-state">
            <p className="page-lead">No recorded operational outcomes yet.</p>
            <p className="muted">
              Learning becomes more informative once Decisions, Actions, and Outcomes have been
              recorded for signals in this workspace.
            </p>
          </section>
        ) : (
          <>
            <LearningSummary counts={report.counts} />
            <LearningCoverage coverage={report.coverage} counts={report.counts} />
            <LearningBreakdown
              decisions={report.decisions}
              actions={report.actions}
              outcomes={report.outcomes}
            />
          </>
        )
      ) : null}
    </article>
  );
}
