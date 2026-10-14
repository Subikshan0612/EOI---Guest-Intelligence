import SignalRow from "./SignalRow";
import RetryButton from "../../components/auth/RetryButton";

export default function SignalList({
  signals,
  pagination,
  status,
  error,
  filtered,
  selectedId,
  page,
  onPage,
  onRetry,
  decisions,
}) {
  if (status === "unconfigured") {
    return (
      <div className="investigation-state">
        <p className="muted">No workspace is configured. Set VITE_KOI_WORKSPACE_ID to view signals.</p>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="investigation-state" role="alert">
        <p className="muted">{error}</p>
        <RetryButton onClick={onRetry} />
      </div>
    );
  }
  if (status === "loading" && signals.length === 0) {
    return (
      <ul className="op-list" aria-busy="true" aria-label="Loading signals">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="dash-skeleton" aria-hidden="true" />
        ))}
      </ul>
    );
  }
  if (signals.length === 0) {
    return (
      <div className="investigation-state">
        <p className="muted">
          {filtered
            ? "There are no Signals matching the current filters."
            : "There are no Signals in this workspace yet."}
        </p>
      </div>
    );
  }
  const pages = pagination?.pages ?? 1;
  const total = pagination?.total ?? signals.length;
  return (
    <div className="dash-list-wrap" aria-busy={status === "loading"}>
      <ul className="op-list">
        {signals.map((signal) => (
          <SignalRow key={signal.id} signal={signal} selected={signal.id === selectedId} decisions={decisions} />
        ))}
      </ul>
      {pages > 1 ? (
        <nav className="dash-pager" aria-label="Signal pages">
          <button type="button" className="text-button" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            Previous
          </button>
          <span className="muted dash-note">
            Page {page} of {pages} · {total} signals
          </span>
          <button
            type="button"
            className="text-button"
            disabled={page >= pages}
            onClick={() => onPage(page + 1)}
          >
            Next
          </button>
        </nav>
      ) : (
        <p className="muted dash-note">
          {total} signal{total === 1 ? "" : "s"}
        </p>
      )}
    </div>
  );
}
