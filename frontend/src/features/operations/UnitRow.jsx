import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { formatStatusLabel, formatUnitType } from "./operationsMapping";
import UnitForm from "./UnitForm";

export default function UnitRow({ unit, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  async function handleDelete() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setDeleteError(null);
    try {
      await onDelete(unit.id);
    } catch (err) {
      setDeleteError(err.message || "Could not delete this unit.");
      setConfirmingDelete(false);
    }
  }

  if (editing) {
    return (
      <li className="op-unit-row is-editing">
        <UnitForm
          initialValues={unit}
          submitLabel="Save unit"
          onCancel={() => setEditing(false)}
          onSubmit={async (updates) => {
            await onUpdate(unit.id, updates);
            setEditing(false);
          }}
        />
      </li>
    );
  }

  return (
    <li className="op-unit-row">
      <div className="op-unit-summary">
        <span className="op-unit-number">{unit.unitNumber}</span>
        <span className="muted">{formatUnitType(unit.type)}</span>
        <span className="status-chip" data-tone={unit.status}>
          {formatStatusLabel(unit.status)}
        </span>
      </div>
      <div className="op-unit-actions">
        <button
          type="button"
          className="icon-button"
          aria-label={`Edit unit ${unit.unitNumber}`}
          onClick={() => setEditing(true)}
        >
          <Pencil size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={confirmingDelete ? "icon-button is-danger" : "icon-button"}
          aria-label={
            confirmingDelete ? `Confirm delete unit ${unit.unitNumber}` : `Delete unit ${unit.unitNumber}`
          }
          onClick={handleDelete}
          onBlur={() => setConfirmingDelete(false)}
        >
          <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {deleteError ? (
        <p className="op-form-error" role="alert">
          {deleteError}
        </p>
      ) : null}
    </li>
  );
}
