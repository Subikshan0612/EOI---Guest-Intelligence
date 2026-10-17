/**
 * Read-only summary of the operational context an investigation was started with (see useInvestigationContext). It is shown above the conversation so the same
 * Property, Guest and Stay stay visible for as long as the investigation is reviewed.
 */
export default function InvestigationContext({ context }) {
  if (!context) return null;
  return (
    <section className="koi-card asst-context asst-context-summary" aria-label="Investigation context">
      <h2 className="card-label">Investigation context</h2>
      <dl className="asst-context-list">
        <div>
          <dt className="op-field-label">Property</dt>
          <dd>{context.property}</dd>
        </div>
        {context.guest ? (
          <div>
            <dt className="op-field-label">Guest</dt>
            <dd>{context.guest}</dd>
          </div>
        ) : null}
        {context.stay ? (
          <div>
            <dt className="op-field-label">Stay</dt>
            <dd>{context.stay}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
