import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChevronLeft, Plus } from "lucide-react";
import PropertyForm from "../features/operations/PropertyForm";
import UnitForm from "../features/operations/UnitForm";
import UnitRow from "../features/operations/UnitRow";
import { usePropertyDetail } from "../features/operations/usePropertyDetail";
import { formatStatusLabel } from "../features/operations/operationsMapping";

export default function PropertyDetailPage() {
  const { propertyId } = useParams();
  const navigate = useNavigate();
  const {
    property,
    status,
    error,
    reload,
    updateProperty,
    deleteProperty,
    units,
    unitsStatus,
    unitsError,
    reloadUnits,
    createUnit,
    updateUnit,
    removeUnit,
  } = usePropertyDetail(propertyId);

  const [editing, setEditing] = useState(false);
  const [showAddUnit, setShowAddUnit] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const backLink = (
    <Link to="/operations/properties" className="text-button op-back-link">
      <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
      All properties
    </Link>
  );

  if (status === "loading") {
    return (
      <article className="page">
        {backLink}
        <p className="muted">Loading property…</p>
      </article>
    );
  }

  if (status === "missing") {
    return (
      <article className="page">
        <section className="investigation-state">
          <p className="page-kicker">Operations</p>
          <h1 className="page-title">Property not found</h1>
          <p className="page-lead">
            This property is no longer available. It may have been deleted, or the link is
            invalid.
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
          <h1 className="page-title">Couldn’t load this property</h1>
          <p className="page-lead">{error}</p>
          <button type="button" className="text-button" onClick={reload}>
            Try again
          </button>
        </section>
      </article>
    );
  }

  async function handleDeleteProperty() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setDeleteError(null);
    try {
      await deleteProperty();
      navigate("/operations/properties");
    } catch (err) {
      setDeleteError(err.message || "Could not delete this property.");
      setConfirmingDelete(false);
    }
  }

  return (
    <article className="page op-page">
      {backLink}

      <header className="op-page-header">
        <div>
          <p className="page-kicker">Operations · Property</p>
          {editing ? (
            <h1 className="page-title">Edit {property.name}</h1>
          ) : (
            <>
              <h1 className="page-title">{property.name}</h1>
              <p className="page-lead">
                {property.code}
                {property.address ? ` · ${property.address}` : ""} · {property.timezone}
              </p>
            </>
          )}
        </div>
        {!editing ? (
          <span className="status-chip" data-tone={property.status}>
            {formatStatusLabel(property.status)}
          </span>
        ) : null}
      </header>

      {editing ? (
        <section className="koi-card">
          <PropertyForm
            initialValues={property}
            submitLabel="Save property"
            showStatus
            onCancel={() => setEditing(false)}
            onSubmit={async (values) => {
              await updateProperty(values);
              setEditing(false);
            }}
          />
        </section>
      ) : (
        <div className="op-form-actions">
          <button type="button" className="text-button" onClick={() => setEditing(true)}>
            Edit property
          </button>
          <button
            type="button"
            className={confirmingDelete ? "text-button is-danger" : "text-button"}
            onClick={handleDeleteProperty}
          >
            {confirmingDelete ? "Confirm delete property" : "Delete property"}
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
          <h2 className="card-label">Units</h2>
          <button
            type="button"
            className="text-button"
            onClick={() => setShowAddUnit((open) => !open)}
          >
            <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
            Add unit
          </button>
        </header>

        {showAddUnit ? (
          <div className="koi-card">
            <UnitForm
              submitLabel="Create unit"
              onCancel={() => setShowAddUnit(false)}
              onSubmit={async (values) => {
                await createUnit(values);
                setShowAddUnit(false);
              }}
            />
          </div>
        ) : null}

        {unitsStatus === "loading" ? (
          <p className="muted">Loading units…</p>
        ) : unitsStatus === "error" ? (
          <section className="investigation-state" role="alert">
            <p className="page-lead">{unitsError || "Could not load units."}</p>
            <button type="button" className="text-button" onClick={reloadUnits}>
              Try again
            </button>
          </section>
        ) : units.length === 0 ? (
          <p className="muted">No units yet. Add the first one above.</p>
        ) : (
          <ul className="op-unit-list">
            {units.map((unit) => (
              <UnitRow key={unit.id} unit={unit} onUpdate={updateUnit} onDelete={removeUnit} />
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
