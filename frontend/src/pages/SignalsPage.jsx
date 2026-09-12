import { useState } from "react";
import { Link } from "react-router-dom";
import { Activity, Plus } from "lucide-react";
import SignalForm from "../features/operations/SignalForm";
import { useSignals } from "../features/operations/useSignals";
import {
  SIGNAL_SEVERITIES,
  SIGNAL_STATUSES,
  SIGNAL_TYPES,
  formatStatusLabel,
} from "../features/operations/operationsMapping";
import { formatConversationMeta } from "../utils/formatDate";

export default function SignalsPage() {
  const { signals, status, error, filters, reload, createSignal } = useSignals();
  const [showCreate, setShowCreate] = useState(false);

  if (status === "unconfigured") {
    return (
      <article className="page">
        <section className="investigation-state">
          <p className="page-kicker">Operations</p>
          <h1 className="page-title">Signals</h1>
          <p className="page-lead">
            No development workspace is configured, so signals can’t be loaded or saved. Set{" "}
            <code>VITE_KOI_WORKSPACE_ID</code> in <code>frontend/.env</code> to a real workspace id.
          </p>
        </section>
      </article>
    );
  }

  function updateFilter(field) {
    return (event) => {
      const value = event.target.value;
      const next = { ...filters };
      if (value) next[field] = value;
      else delete next[field];
      reload(next);
    };
  }

  return (
    <article className="page op-page">
      <header className="op-page-header">
        <div>
          <p className="page-kicker">Operations</p>
          <h1 className="page-title">Signals</h1>
          <p className="page-lead">
            Operational events, requests, and issues reported across this workspace — the facts a
            future context layer will reason over.
          </p>
        </div>
        <button
          type="button"
          className="primary-button"
          onClick={() => setShowCreate((open) => !open)}
        >
          <Plus size={18} strokeWidth={1.75} aria-hidden="true" />
          Add signal
        </button>
      </header>

      {showCreate ? (
        <section className="koi-card">
          <h2 className="card-label">New signal</h2>
          <SignalForm
            submitLabel="Create signal"
            onCancel={() => setShowCreate(false)}
            onSubmit={async (values) => {
              await createSignal(values);
              setShowCreate(false);
            }}
          />
        </section>
      ) : null}

      <div className="op-filter-bar">
        <label className="op-field op-field-narrow">
          <span className="op-field-label">Type</span>
          <select className="op-field-input" value={filters.type ?? ""} onChange={updateFilter("type")}>
            <option value="">All types</option>
            {SIGNAL_TYPES.map((type) => (
              <option key={type} value={type}>
                {formatStatusLabel(type)}
              </option>
            ))}
          </select>
        </label>
        <label className="op-field op-field-narrow">
          <span className="op-field-label">Severity</span>
          <select
            className="op-field-input"
            value={filters.severity ?? ""}
            onChange={updateFilter("severity")}
          >
            <option value="">All severities</option>
            {SIGNAL_SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {formatStatusLabel(severity)}
              </option>
            ))}
          </select>
        </label>
        <label className="op-field op-field-narrow">
          <span className="op-field-label">Status</span>
          <select
            className="op-field-input"
            value={filters.status ?? ""}
            onChange={updateFilter("status")}
          >
            <option value="">All statuses</option>
            {SIGNAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {formatStatusLabel(s)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {status === "loading" ? (
        <p className="muted">Loading signals…</p>
      ) : status === "error" ? (
        <section className="investigation-state" role="alert">
          <p className="page-lead">{error || "Could not load signals."}</p>
          <button type="button" className="text-button" onClick={() => reload(filters)}>
            Try again
          </button>
        </section>
      ) : signals.length === 0 ? (
        <section className="investigation-state">
          <p className="page-lead">
            {Object.keys(filters).length
              ? "No signals match these filters."
              : "No signals yet. Add the first one to get started."}
          </p>
        </section>
      ) : (
        <ul className="op-list">
          {signals.map((signal) => (
            <li key={signal.id} className="op-list-item">
              <Link to={`/operations/signals/${signal.id}`} className="op-list-link">
                <Activity size={18} strokeWidth={1.75} aria-hidden="true" />
                <span className="op-list-copy">
                  <span className="op-list-title">{signal.title}</span>
                  <span className="muted">
                    {formatStatusLabel(signal.type)}
                    {signal.occurredAt ? ` · ${formatConversationMeta(signal.occurredAt)}` : ""}
                  </span>
                </span>
                <span className="op-list-chips">
                  <span className="status-chip" data-tone={signal.severity}>
                    {formatStatusLabel(signal.severity)}
                  </span>
                  <span className="status-chip" data-tone={signal.status}>
                    {formatStatusLabel(signal.status)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
