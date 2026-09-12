import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChevronLeft, Plus } from "lucide-react";
import GuestForm from "../features/operations/GuestForm";
import StayForm from "../features/operations/StayForm";
import StayRow from "../features/operations/StayRow";
import { useGuestDetail } from "../features/operations/useGuestDetail";
import { formatGuestName, mapPropertyFromApi, mapUnitFromApi } from "../features/operations/operationsMapping";
import { KOI_WORKSPACE_ID, isWorkspaceConfigured } from "../config/workspace";
import * as koiApi from "../services/api";

/**
 * Resolves property/unit names for display in the stay list. Kept local to
 * this page (not the shared operations state) — it's a read-only lookup for
 * presentation, not something other pages need.
 */
function usePropertyUnitLookup() {
  const [propertiesById, setPropertiesById] = useState({});
  const [unitsById, setUnitsById] = useState({});

  useEffect(() => {
    if (!isWorkspaceConfigured) return;
    koiApi.listProperties(KOI_WORKSPACE_ID, { limit: 100 }).then(({ items }) => {
      const byId = {};
      items.map(mapPropertyFromApi).forEach((property) => {
        byId[property.id] = property.name;
      });
      setPropertiesById(byId);
    });
    koiApi.listUnits(KOI_WORKSPACE_ID, { limit: 100 }).then(({ items }) => {
      const byId = {};
      items.map(mapUnitFromApi).forEach((unit) => {
        byId[unit.id] = unit.unitNumber;
      });
      setUnitsById(byId);
    });
  }, []);

  return { propertiesById, unitsById };
}

export default function GuestDetailPage() {
  const { guestId } = useParams();
  const navigate = useNavigate();
  const {
    guest,
    status,
    error,
    reload,
    updateGuest,
    deleteGuest,
    stays,
    staysStatus,
    staysError,
    reloadStays,
    createStay,
    updateStay,
    removeStay,
  } = useGuestDetail(guestId);
  const { propertiesById, unitsById } = usePropertyUnitLookup();

  const [editing, setEditing] = useState(false);
  const [showAddStay, setShowAddStay] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const backLink = (
    <Link to="/operations/guests" className="text-button op-back-link">
      <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
      All guests
    </Link>
  );

  if (status === "loading") {
    return (
      <article className="page">
        {backLink}
        <p className="muted">Loading guest…</p>
      </article>
    );
  }

  if (status === "missing") {
    return (
      <article className="page">
        <section className="investigation-state">
          <p className="page-kicker">Operations</p>
          <h1 className="page-title">Guest not found</h1>
          <p className="page-lead">
            This guest is no longer available. It may have been deleted, or the link is invalid.
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
          <h1 className="page-title">Couldn’t load this guest</h1>
          <p className="page-lead">{error}</p>
          <button type="button" className="text-button" onClick={reload}>
            Try again
          </button>
        </section>
      </article>
    );
  }

  const guestName = formatGuestName(guest);

  async function handleDeleteGuest() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setDeleteError(null);
    try {
      await deleteGuest();
      navigate("/operations/guests");
    } catch (err) {
      setDeleteError(err.message || "Could not delete this guest.");
      setConfirmingDelete(false);
    }
  }

  return (
    <article className="page op-page">
      {backLink}

      <header className="op-page-header">
        <div>
          <p className="page-kicker">Operations · Guest</p>
          {editing ? (
            <h1 className="page-title">Edit {guestName}</h1>
          ) : (
            <>
              <h1 className="page-title">{guestName}</h1>
              <p className="page-lead">
                {[guest.email, guest.phone].filter(Boolean).join(" · ") || "No contact details on file"}
              </p>
            </>
          )}
        </div>
      </header>

      {editing ? (
        <section className="koi-card">
          <GuestForm
            initialValues={guest}
            submitLabel="Save guest"
            onCancel={() => setEditing(false)}
            onSubmit={async (values) => {
              await updateGuest(values);
              setEditing(false);
            }}
          />
        </section>
      ) : (
        <div className="op-form-actions">
          <button type="button" className="text-button" onClick={() => setEditing(true)}>
            Edit guest
          </button>
          <button
            type="button"
            className={confirmingDelete ? "text-button is-danger" : "text-button"}
            onClick={handleDeleteGuest}
          >
            {confirmingDelete ? "Confirm delete guest" : "Delete guest"}
          </button>
        </div>
      )}
      {deleteError ? (
        <p className="op-form-error" role="alert">
          {deleteError}
        </p>
      ) : null}

      <section className="op-units-section">
        <header className="op-page-header">
          <h2 className="card-label">Stay history</h2>
          <button
            type="button"
            className="text-button"
            onClick={() => setShowAddStay((open) => !open)}
          >
            <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
            Add stay
          </button>
        </header>

        {showAddStay ? (
          <div className="koi-card">
            <StayForm
              guestName={guestName}
              submitLabel="Create stay"
              onCancel={() => setShowAddStay(false)}
              onSubmit={async (values) => {
                await createStay(values);
                setShowAddStay(false);
              }}
            />
          </div>
        ) : null}

        {staysStatus === "loading" ? (
          <p className="muted">Loading stays…</p>
        ) : staysStatus === "error" ? (
          <section className="investigation-state" role="alert">
            <p className="page-lead">{staysError || "Could not load stays."}</p>
            <button type="button" className="text-button" onClick={reloadStays}>
              Try again
            </button>
          </section>
        ) : stays.length === 0 ? (
          <p className="muted">No stays recorded yet. Add the first one above.</p>
        ) : (
          <ul className="op-stay-list">
            {stays.map((stay) => (
              <StayRow
                key={stay.id}
                stay={stay}
                guestName={guestName}
                propertyName={propertiesById[stay.propertyId]}
                unitNumber={stay.unitId ? unitsById[stay.unitId] : null}
                onUpdate={updateStay}
                onDelete={removeStay}
              />
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
