function Card({ title, children, variant = "default" }) {
  if (!children) return null;

  return (
    <section className={variant === "compact" ? "intelligence-block" : "koi-card"}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function SignalCard({ signal, variant }) {
  if (!signal) return null;

  return (
    <Card title="Signal" variant={variant}>
      {signal.title ? <p className="context-identity">{signal.title}</p> : null}
      <p>{signal.summary}</p>
      {signal.severity ? (
        <div className="intelligence-meta-row">
          <span className="severity-chip" data-level={signal.severity}>
            Severity: {signal.severity}
          </span>
        </div>
      ) : null}
    </Card>
  );
}

export function ContextCard({ context, variant }) {
  if (!context) return null;

  const unit = context.unit || context.apartment;
  const stayStatus = context.stayStatus || context.occupancyStatus;
  if (!unit && !stayStatus) return null;

  return (
    <Card title="Context" variant={variant}>
      {unit ? <p>Unit {unit}</p> : null}
      {stayStatus ? <p className="muted">{stayStatus}</p> : null}
    </Card>
  );
}

export function IntelligenceCard({ intelligence, variant, hideSummary = false }) {
  if (!intelligence) return null;

  const extras = [intelligence.pattern, intelligence.guestImpact, intelligence.operationalImpact].filter(
    Boolean,
  );

  if (hideSummary && extras.length === 0) return null;

  return (
    <Card title="Intelligence" variant={variant}>
      {!hideSummary && intelligence.summary ? <p>{intelligence.summary}</p> : null}
      {extras.map((item) => (
        <p key={item} className="muted">
          {item}
        </p>
      ))}
    </Card>
  );
}

export function RiskIndicator({ risk, variant }) {
  if (!risk) return null;

  const reason = risk.reason || risk.reasons?.[0];
  const level = typeof risk.level === "string" ? risk.level : "unknown";

  return (
    <Card title="Risk" variant={variant}>
      <div className="intelligence-meta-row">
        <span className="risk-chip" data-level={level}>
          {level} risk
        </span>
      </div>
      {reason ? <p className="muted">{reason}</p> : null}
    </Card>
  );
}

export function DecisionCard({ decision, variant }) {
  if (!decision) return null;

  return (
    <Card title="Decision" variant={variant}>
      <p>{decision.recommendation}</p>
    </Card>
  );
}

export function ActionCard({ action, variant }) {
  if (!action) return null;

  const steps = action.recommended ?? [];
  if (!action.label && steps.length === 0) return null;

  return (
    <Card title="Action" variant={variant}>
      {action.label ? <p>{action.label}</p> : null}
      {steps.length ? (
        <ol className="stack-sm">
          {steps.map((item) => (
            <li key={item.step}>{item.step}</li>
          ))}
        </ol>
      ) : null}
    </Card>
  );
}

export function OutcomeCard({ outcome, variant }) {
  if (!outcome) return null;

  const summary = outcome.summary || (outcome.status ? `Status: ${outcome.status}` : null);
  if (!summary) return null;

  return (
    <Card title="Outcome" variant={variant}>
      <p>{summary}</p>
    </Card>
  );
}
