import { useState } from "react";
import { Link } from "react-router-dom";
import { Building2, Plus } from "lucide-react";
import PropertyForm from "../features/operations/PropertyForm";
import { useProperties } from "../features/operations/useProperties";
import { formatStatusLabel } from "../features/operations/operationsMapping";

export default function PropertiesPage() {
  const { properties, status, error, reload, createProperty } = useProperties();
  const [showCreate, setShowCreate] = useState(false);

  if (status === "unconfigured") {
    return (
      <article className="page">
        <section className="investigation-state">
          <p className="page-kicker">Operations</p>
          <h1 className="page-title">Properties</h1>
          <p className="page-lead">
            No development workspace is configured, so properties can’t be loaded or saved. Set{" "}
            <code>VITE_KOI_WORKSPACE_ID</code> in <code>frontend/.env</code> to a real workspace id.
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
          <h1 className="page-title">Properties</h1>
          <p className="page-lead">
            The properties in this workspace, and the units EOI will eventually resolve signals
            against.
          </p>
        </div>
        <button
          type="button"
          className="primary-button"
          onClick={() => setShowCreate((open) => !open)}
        >
          <Plus size={18} strokeWidth={1.75} aria-hidden="true" />
          Add property
        </button>
      </header>

      {showCreate ? (
        <section className="koi-card">
          <h2 className="card-label">New property</h2>
          <PropertyForm
            submitLabel="Create property"
            onCancel={() => setShowCreate(false)}
            onSubmit={async (values) => {
              await createProperty(values);
              setShowCreate(false);
            }}
          />
        </section>
      ) : null}

      {status === "loading" ? (
        <p className="muted">Loading properties…</p>
      ) : status === "error" ? (
        <section className="investigation-state" role="alert">
          <p className="page-lead">{error || "Could not load properties."}</p>
          <button type="button" className="text-button" onClick={reload}>
            Try again
          </button>
        </section>
      ) : properties.length === 0 ? (
        <section className="investigation-state">
          <p className="page-lead">No properties yet. Add the first one to get started.</p>
        </section>
      ) : (
        <ul className="op-list">
          {properties.map((property) => (
            <li key={property.id} className="op-list-item">
              <Link to={`/operations/properties/${property.id}`} className="op-list-link">
                <Building2 size={18} strokeWidth={1.75} aria-hidden="true" />
                <span className="op-list-copy">
                  <span className="op-list-title">{property.name}</span>
                  <span className="muted">
                    {property.code}
                    {property.address ? ` · ${property.address}` : ""}
                  </span>
                </span>
                <span className="status-chip" data-tone={property.status}>
                  {formatStatusLabel(property.status)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
