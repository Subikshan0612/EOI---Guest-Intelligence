/**
 * Honest AI provenance (Phase 4). `provenance.provider`/`provenance.model`
 * and `confidence` come straight from the backend's own configuration and
 * the validated LLM response — never fabricated here. Keeps the Intelligence
 * section from ever being mistaken for a verified operational fact.
 *
 * `intelligenceId`/`generatedAt` (Phase 7F-C) reflect that this result is
 * now a durable, persisted record — not just this request/response — but
 * intentionally stay minimal, in the same dl/dt/dd shape already used here.
 */
export default function IntelligenceProvenance({ confidence, provenance, intelligenceId, generatedAt }) {
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
        {intelligenceId ? (
          <>
            <dt>Saved as</dt>
            <dd>{intelligenceId}</dd>
          </>
        ) : null}
        {generatedAt ? (
          <>
            <dt>Generated</dt>
            <dd>{new Date(generatedAt).toLocaleString()}</dd>
          </>
        ) : null}
      </dl>
      <p className="muted">
        AI-generated interpretation — verify against the operational context above before acting
        on it.
      </p>
    </section>
  );
}
