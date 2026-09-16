import { X } from "lucide-react";
import { useMatch } from "react-router-dom";
import { getLatestIntelligence } from "../../features/conversations/conversationSelectors";
import { useConversations } from "../../features/conversations/useConversations";
import { getGuestContext } from "../../features/guest/guestSelectors";
import { useLayout } from "../../hooks/useLayout";
import { formatStayDate, nightsBetween } from "../../utils/formatDate";
import { IconButton } from "../ui/IconButton";

export default function ContextPanel() {
  const { contextOpen, closeOverlays } = useLayout();
  const { getById } = useConversations();
  const chatMatch = useMatch("/chat/:conversationId");
  const conversation = chatMatch ? getById(chatMatch.params.conversationId) : null;
  const { guest, stay } = conversation
    ? getGuestContext(conversation.guestId, conversation.stayId)
    : { guest: null, stay: null };
  const intelligence = conversation ? getLatestIntelligence(conversation) : null;
  const nights = stay ? nightsBetween(stay.checkIn, stay.checkOut) : null;
  const related = intelligence?.context?.relevantHistory ?? (guest?.notes ? [guest.notes] : []);
  const risk = intelligence?.risk ?? null;
  const riskReason = risk?.reason || risk?.reasons?.[0];

  return (
    <aside
      id="context-panel"
      className={contextOpen ? "context-panel is-open" : "context-panel"}
      aria-label="Guest and operational context"
    >
      <div className="sheet-handle" aria-hidden="true" />
      <div className="panel-header">
        <div>
          <p className="panel-kicker">Context</p>
          <h2 className="panel-title">Stay picture</h2>
        </div>
        <IconButton className="drawer-close" label="Close context panel" onClick={closeOverlays}>
          <X size={18} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
      </div>

      <div className="panel-body">
        <section className="context-section">
          <h3>Guest</h3>
          {guest ? (
            <>
              <p className="context-identity">{guest.name}</p>
              <p className="context-meta">
                {stay ? `Unit ${stay.unit}` : "Unit unassigned"} · {guest.loyaltyTier}
              </p>
            </>
          ) : (
            <p className="muted">Select a conversation to see who this investigation belongs to.</p>
          )}
        </section>

        <section className="context-section">
          <h3>Stay</h3>
          {stay ? (
            <dl className="context-dl">
              <dt>Check-in</dt>
              <dd>{formatStayDate(stay.checkIn)}</dd>
              <dt>Check-out</dt>
              <dd>{formatStayDate(stay.checkOut)}</dd>
              <dt>Length</dt>
              <dd>{nights ? `${nights} night${nights === 1 ? "" : "s"}` : "—"}</dd>
            </dl>
          ) : (
            <p className="muted">Stay dates appear when an investigation is linked to a booking.</p>
          )}
        </section>

        <section className="context-section">
          <h3>Signals</h3>
          {intelligence?.signal ? (
            <p className="context-meta">{intelligence.signal.summary}</p>
          ) : conversation ? (
            <p className="context-meta">{conversation.summary || "No signal captured yet."}</p>
          ) : (
            <p className="muted">Recent guest and operational signals will collect here.</p>
          )}
        </section>

        <section className="context-section">
          <h3>Risk</h3>
          {risk ? (
            <div className="context-risk">
              <span className="risk-chip" data-level={risk.level}>
                {risk.level} risk
              </span>
              {riskReason ? <p className="context-meta">{riskReason}</p> : null}
            </div>
          ) : (
            <p className="muted">{conversation ? "Not assessed yet." : "No active risk reading."}</p>
          )}
        </section>

        <section className="context-section">
          <h3>Related context</h3>
          {related.length ? (
            <ul className="context-list">
              {related.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">Historical stay notes will appear as EOI learns the guest.</p>
          )}
        </section>
      </div>
    </aside>
  );
}
