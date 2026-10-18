import { useState } from "react";
import { Link } from "react-router-dom";
import { Plus, User, Users } from "lucide-react";
import GuestForm from "../features/operations/GuestForm";
import { useGuests } from "../features/operations/useGuests";
import { useWorkspaceProperties } from "../features/operations/useWorkspaceProperties";
import { formatGuestName } from "../features/operations/operationsMapping";
import RetryButton from "../components/auth/RetryButton";
import EmptyState from "../components/ui/EmptyState";
import ListSkeleton from "../components/ui/ListSkeleton";

export default function GuestsPage() {
  const [propertyFilter, setPropertyFilter] = useState("");
  const { guests, status, error, reload, createGuest } = useGuests(propertyFilter);
  const { status: propertiesStatus, properties } = useWorkspaceProperties();
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState(null);
  const propertyName = (id) => properties.find((property) => property.id === id)?.name ?? null;

  if (status === "unconfigured") {
    return (
      <article className="page">
        <section className="investigation-state">
          <p className="page-kicker">Operations</p>
          <h1 className="page-title">Guests &amp; stays</h1>
          <p className="page-lead">
            The guests of each property and their stays: who is in which room, and when they arrive and leave. The assistant uses
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
          <h1 className="page-title">Guests &amp; stays</h1>
          <p className="page-lead">
            Every guest belongs to a property, and every stay belongs to a guest of that property. These are the records EOI uses when it assesses a report about a room.
          </p>
        </div>
        {status === "ready" && guests.length === 0 ? null : (
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              setShowCreate((open) => !open);
              setCreated(null);
            }}
          >
            <Plus size={18} strokeWidth={1.75} aria-hidden="true" />
            Add guest
          </button>
        )}
      </header>

      {showCreate ? (
        <section className="koi-card">
          <h2 className="card-label">New guest</h2>
          <GuestForm
            withStay
            submitLabel="Create guest"
            defaultPropertyId={propertyFilter}
            onCancel={() => setShowCreate(false)}
            onSubmit={async (values) => {
              const guest = await createGuest(values);
              setCreated(guest);
              setShowCreate(false);
            }}
          />
        </section>
      ) : null}

      {created ? (
        <p className="op-success" role="status">
          Added {formatGuestName(created)}
          {created.stay ? ` with stay ${created.stay.reservationId || "(no booking reference)"}` : ""}
          {created.unit ? ` in room ${created.unit.unitNumber}${created.unit.created ? " (new room added to this property)" : ""}` : ""}.{" "}
          <Link to={`/operations/guests/${created.id}`} className="text-button">
            View guest
          </Link>
        </p>
      ) : null}

      <div className="op-form-row">
        <label className="op-field">
          <span className="op-field-label">Property</span>
          <select className="op-field-input" value={propertyFilter} onChange={(event) => setPropertyFilter(event.target.value)}>
            <option value="">All properties</option>
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {status === "loading" ? (
        <ListSkeleton label="Loading guests…" />
      ) : status === "error" ? (
        <section className="investigation-state" role="alert">
          <p className="page-lead">{error || "Could not load guests."}</p>
          <RetryButton onClick={reload} />
        </section>
      ) : guests.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No guests yet"
          what="Guests are the people staying at your properties. Each belongs to one property, and their stays are what EOI assesses a report against."
          action={
            propertiesStatus === "ready" && properties.length === 0 ? (
              <Link to="/operations/properties" className="primary-button">
                Add a property
              </Link>
            ) : (
              <button type="button" className="primary-button" onClick={() => setShowCreate(true)}>
                <Plus size={18} strokeWidth={1.75} aria-hidden="true" />
                Add guest
              </button>
            )
          }
        >
          {propertyFilter ? "No guests have been added to this property yet." : "No guests yet. Add a property, then add its first guest."}
        </EmptyState>
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
                <span className="status-chip">{guest.propertyId ? propertyName(guest.propertyId) || "Property" : "No property yet"}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
