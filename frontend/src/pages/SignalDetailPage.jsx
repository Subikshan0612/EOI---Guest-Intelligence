import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChevronLeft, Sparkles } from "lucide-react";
import SignalForm from "../features/operations/SignalForm";
import SignalOperationalContext from "../features/operations/SignalOperationalContext";
import { useSignalDetail } from "../features/operations/useSignalDetail";
import { useSignalContext } from "../features/operations/useSignalContext";
import { formatStatusLabel } from "../features/operations/operationsMapping";
import { formatShortDate, formatStayDate } from "../utils/formatDate";

export default function SignalDetailPage() {
  const { signalId } = useParams();
  const navigate = useNavigate();
  const { signal, status, error, reload, refs, updateSignal, deleteSignal } =
    useSignalDetail(signalId);
  const {
    context,
    status: contextStatus,
    error: contextError,
    reload: reloadContext,
  } = useSignalContext(signalId);

  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const backLink = (
    <Link to="/operations/signals" className="text-button op-back-link">
      <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
      All signals
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
          <p className="page-kicker">Operations</p>
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
          <p className="page-kicker">Operations</p>
          <h1 className="page-title">Couldn’t load this signal</h1>
          <p className="page-lead">{error}</p>
          <button type="button" className="text-button" onClick={reload}>
            Try again
          </button>
        </section>
      </article>
    );
  }

  async function handleDeleteSignal() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setDeleteError(null);
    try {
      await deleteSignal();
      navigate("/operations/signals");
    } catch (err) {
      setDeleteError(err.message || "Could not delete this signal.");
      setConfirmingDelete(false);
    }
  }

  const hasReferences = signal.propertyId || signal.unitId || signal.guestId || signal.stayId;

  return (
    <article className="page op-page">
      {backLink}

      <header className="op-page-header">
        <div>
          <p className="page-kicker">Operations · Signal · {formatStatusLabel(signal.type)}</p>
          {editing ? (
            <h1 className="page-title">Edit signal</h1>
          ) : (
            <>
              <h1 className="page-title">{signal.title}</h1>
              <p className="page-lead">
                {signal.occurredAt
                  ? `Occurred ${formatShortDate(signal.occurredAt)}`
                  : "No occurrence time recorded"}
                {" · "}Source: {formatStatusLabel(signal.source)}
              </p>
            </>
          )}
        </div>
        {!editing ? (
          <span className="op-list-chips">
            <span className="status-chip" data-tone={signal.severity}>
              {formatStatusLabel(signal.severity)}
            </span>
            <span className="status-chip" data-tone={signal.status}>
              {formatStatusLabel(signal.status)}
            </span>
          </span>
        ) : null}
      </header>

      {editing ? (
        <section className="koi-card">
          <SignalForm
            initialValues={signal}
            submitLabel="Save signal"
            onCancel={() => setEditing(false)}
            onSubmit={async (values) => {
              await updateSignal(values);
              setEditing(false);
            }}
          />
        </section>
      ) : (
        <>
          {signal.description ? (
            <section className="koi-card">
              <h2 className="card-label">Detail</h2>
              <p>{signal.description}</p>
            </section>
          ) : null}

          <div className="op-form-actions">
            <Link to={`/operations/signals/${signalId}/intelligence`} className="primary-button">
              <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />
              Open Intelligence
            </Link>
            <button type="button" className="text-button" onClick={() => setEditing(true)}>
              Edit signal
            </button>
            <button
              type="button"
              className={confirmingDelete ? "text-button is-danger" : "text-button"}
              onClick={handleDeleteSignal}
            >
              {confirmingDelete ? "Confirm delete signal" : "Delete signal"}
            </button>
          </div>
          {deleteError ? (
            <p className="op-form-error" role="alert">
              {deleteError}
            </p>
          ) : null}

          {hasReferences ? (
            <section className="op-units-section">
              <h2 className="card-label">Context references</h2>
              <dl className="context-dl">
                {signal.guestId ? (
                  <>
                    <dt>Guest</dt>
                    <dd>
                      {refs.guest ? (
                        <Link to={`/operations/guests/${signal.guestId}`}>{refs.guest}</Link>
                      ) : (
                        "Unknown guest"
                      )}
                    </dd>
                  </>
                ) : null}
                {signal.stayId ? (
                  <>
                    <dt>Stay</dt>
                    <dd>
                      {refs.stay
                        ? `${formatStayDate(refs.stay.checkIn)} → ${formatStayDate(refs.stay.checkOut)}`
                        : "Unknown stay"}
                    </dd>
                  </>
                ) : null}
                {signal.propertyId ? (
                  <>
                    <dt>Property</dt>
                    <dd>
                      {refs.property ? (
                        <Link to={`/operations/properties/${signal.propertyId}`}>
                          {refs.property}
                        </Link>
                      ) : (
                        "Unknown property"
                      )}
                    </dd>
                  </>
                ) : null}
                {signal.unitId ? (
                  <>
                    <dt>Unit</dt>
                    <dd>{refs.unit ?? "Unknown unit"}</dd>
                  </>
                ) : null}
              </dl>
            </section>
          ) : null}

          <SignalOperationalContext
            context={context}
            status={contextStatus}
            error={contextError}
            onRetry={reloadContext}
          />
        </>
      )}
    </article>
  );
}
