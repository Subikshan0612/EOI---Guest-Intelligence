import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { formatStayDate, nightsBetween } from "../../utils/formatDate";
import { formatStatusLabel } from "./operationsMapping";
import StayForm from "./StayForm";

export default function StayRow({
  stay,
  guestName,
  propertyName,
  unitNumber,
  onUpdate,
  onDelete,
}) {
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
      await onDelete(stay.id);
    } catch (err) {
      setDeleteError(err.message || "Could not delete this stay.");
      setConfirmingDelete(false);
    }
  }

  if (editing) {
    return (
      <li className="op-stay-row is-editing">
        <StayForm
          guestName={guestName}
          initialValues={stay}
          submitLabel="Save stay"
          onCancel={() => setEditing(false)}
          onSubmit={async (updates) => {
            await onUpdate(stay.id, updates);
            setEditing(false);
          }}
        />
      </li>
    );
  }

  const nights = nightsBetween(stay.checkIn, stay.checkOut);

  return (
    <li className="op-stay-row">
      <div className="op-stay-summary">
        <div className="op-stay-place">
          {stay.propertyId ? (
            <Link to={`/operations/properties/${stay.propertyId}`} className="op-stay-property">
              {propertyName || "Unknown property"}
            </Link>
          ) : (
            <span className="op-stay-property">{propertyName || "Unknown property"}</span>
          )}
          <span className="muted">{unitNumber ? `Unit ${unitNumber}` : "Unassigned unit"}</span>
        </div>
        <div className="op-stay-dates muted">
          {stay.checkIn ? formatStayDate(stay.checkIn) : "No check-in set"}
          {stay.checkOut ? ` → ${formatStayDate(stay.checkOut)}` : ""}
          {nights ? ` · ${nights} night${nights === 1 ? "" : "s"}` : ""}
        </div>
        <span className="status-chip" data-tone={stay.status}>
          {formatStatusLabel(stay.status)}
        </span>
      </div>
      <div className="op-unit-actions">
        <button
          type="button"
          className="icon-button"
          aria-label="Edit stay"
          onClick={() => setEditing(true)}
        >
          <Pencil size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={confirmingDelete ? "icon-button is-danger" : "icon-button"}
          aria-label={confirmingDelete ? "Confirm delete stay" : "Delete stay"}
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
