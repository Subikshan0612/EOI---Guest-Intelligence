import { Building2, CalendarRange, DoorOpen, User } from "lucide-react";

/**
 * A stay's label (see contextSelection.stayLabel) is "<#reference | Stay> · <Unit N>? · <dates>? · <status>?", built from the stay's own record. It is only SPLIT here so the booking
 * reference, the room, the dates and the status can each be read at a glance; no word is added, removed or reworded.
 */
function readStay(label) {
  const parts = String(label ?? "")
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean);
  const reference = parts.shift() ?? "";
  const room = parts[0] && /^Unit\s/i.test(parts[0]) ? parts.shift().replace(/^Unit\s+/i, "") : "";
  const dates = parts.find((part) => /\d/.test(part)) ?? "";
  const status = parts.find((part) => part !== dates) ?? "";
  return { reference, room, dates, status };
}

/**
 * Read-only summary of the operational context an investigation was started with (see useInvestigationContext). It is shown above the conversation so the same
 * Property, Guest and Stay stay visible for as long as the investigation is reviewed - presented as the operational record the assessment rests on: the property first,
 * then the guest, the stay (booking reference, dates, status) and the room.
 */
export default function InvestigationContext({ context }) {
  if (!context) return null;
  const stay = context.stay ? readStay(context.stay) : null;
  return (
    <section className="koi-card asst-context asst-context-summary" aria-label="Investigation context">
      <h2 className="card-label">Investigation context</h2>
      <dl className="asst-record">
        <div className="asst-record-cell asst-record-property">
          <dt>
            <Building2 size={14} strokeWidth={1.75} aria-hidden="true" />
            Property
          </dt>
          <dd className="asst-record-primary">{context.property}</dd>
        </div>
        {context.guest ? (
          <div className="asst-record-cell">
            <dt>
              <User size={14} strokeWidth={1.75} aria-hidden="true" />
              Guest
            </dt>
            <dd>{context.guest}</dd>
          </div>
        ) : null}
        {stay ? (
          <div className="asst-record-cell">
            <dt>
              <CalendarRange size={14} strokeWidth={1.75} aria-hidden="true" />
              Stay
            </dt>
            <dd>
              <span>{stay.reference}</span>
              {stay.dates ? <span className="asst-record-sub">{stay.dates}</span> : null}
              {stay.status ? <span className="status-chip asst-record-chip">{stay.status}</span> : null}
            </dd>
          </div>
        ) : null}
        {stay && stay.room ? (
          <div className="asst-record-cell">
            <dt>
              <DoorOpen size={14} strokeWidth={1.75} aria-hidden="true" />
              Room
            </dt>
            <dd>{stay.room}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
