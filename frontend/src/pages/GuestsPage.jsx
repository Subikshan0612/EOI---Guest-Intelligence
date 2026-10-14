import { useState } from "react";
import { Link } from "react-router-dom";
import { Plus, User } from "lucide-react";
import GuestForm from "../features/operations/GuestForm";
import { useGuests } from "../features/operations/useGuests";
import { formatGuestName } from "../features/operations/operationsMapping";
import RetryButton from "../components/auth/RetryButton";

export default function GuestsPage() {
  const { guests, status, error, reload, createGuest } = useGuests();
  const [showCreate, setShowCreate] = useState(false);

  if (status === "unconfigured") {
    return (
      <article className="page">
        <section className="investigation-state">
          <p className="page-kicker">Operations</p>
          <h1 className="page-title">Guests &amp; stays</h1>
          <p className="page-lead">
            The guests in this workspace and their stays: who is in which room, and when they arrive and leave. The assistant uses
            these records when it assesses a report about a room.
          </p>
        </section>
      </article>
    );
  }

  return (
    <article className="page op-page">
      <header className="op-page-header">
        <div>
          <p className="page-kicker">Operations</p>
          <h1 className="page-title">Guests</h1>
          <p className="page-lead">
            The guests in this workspace, and the stays EOI will eventually resolve signals
            against.
          </p>
        </div>
        <button
          type="button"
          className="primary-button"
          onClick={() => setShowCreate((open) => !open)}
        >
          <Plus size={18} strokeWidth={1.75} aria-hidden="true" />
          Add guest
        </button>
      </header>

      {showCreate ? (
        <section className="koi-card">
          <h2 className="card-label">New guest</h2>
          <GuestForm
            submitLabel="Create guest"
            onCancel={() => setShowCreate(false)}
            onSubmit={async (values) => {
              await createGuest(values);
              setShowCreate(false);
            }}
          />
        </section>
      ) : null}

      {status === "loading" ? (
        <p className="muted">Loading guests…</p>
      ) : status === "error" ? (
        <section className="investigation-state" role="alert">
          <p className="page-lead">{error || "Could not load guests."}</p>
          <RetryButton onClick={reload} />
        </section>
      ) : guests.length === 0 ? (
        <section className="investigation-state">
          <p className="page-lead">No guests yet. Add the first one to get started.</p>
        </section>
      ) : (
        <ul className="op-list">
          {guests.map((guest) => (
            <li key={guest.id} className="op-list-item">
              <Link to={`/operations/guests/${guest.id}`} className="op-list-link">
                <User size={18} strokeWidth={1.75} aria-hidden="true" />
                <span className="op-list-copy">
                  <span className="op-list-title">{formatGuestName(guest)}</span>
                  <span className="muted">
                    {[guest.email, guest.phone].filter(Boolean).join(" · ") || "No contact details"}
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
