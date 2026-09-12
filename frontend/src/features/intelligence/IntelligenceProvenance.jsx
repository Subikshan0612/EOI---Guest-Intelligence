/**
 * Honest AI provenance (Phase 4). `provenance.provider`/`provenance.model`
 * and `confidence` come straight from the backend's own configuration and
 * the validated LLM response — never fabricated here. Keeps the Intelligence
 * section from ever being mistaken for a verified operational fact.
 */
export default function IntelligenceProvenance({ confidence, provenance }) {
  if (!provenance) return null;

  return (
    <section className="koi-card intel-provenance">
      <h3 className="card-label">Provenance</h3>
      <dl className="context-dl">
        <dt>Provider</dt>
        <dd>{provenance.provider}</dd>
        <dt>Model</dt>
        <dd>{provenance.model}</dd>
        <dt>Confidence</dt>
        <dd>{typeof confidence === "number" ? `${Math.round(confidence * 100)}%` : "—"}</dd>
      </dl>
      <p className="muted">
        AI-generated interpretation — verify against the operational context above before acting
        on it.
      </p>
    </section>
  );
}
