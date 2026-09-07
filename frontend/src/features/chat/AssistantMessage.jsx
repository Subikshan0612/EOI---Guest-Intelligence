import {
  ActionCard,
  ContextCard,
  DecisionCard,
  IntelligenceCard,
  OutcomeCard,
  RiskIndicator,
  SignalCard,
} from "../intelligence/cards";

export default function AssistantMessage({ message }) {
  if (message.type !== "intelligence") {
    return (
      <article className="chat-message chat-message-assistant">
        <p className="chat-message-kicker">KOI</p>
        <p className="assistant-summary">{message.content}</p>
      </article>
    );
  }

  const extras =
    message.intelligence?.pattern ||
    message.intelligence?.guestImpact ||
    message.intelligence?.operationalImpact;

  return (
    <article className="chat-message chat-message-assistant">
      <p className="chat-message-kicker">KOI</p>
      {message.intelligence?.summary ? (
        <p className="assistant-summary">{message.intelligence.summary}</p>
      ) : null}
      <div className="intelligence-stack">
        <SignalCard signal={message.signal} variant="compact" />
        <ContextCard context={message.context} variant="compact" />
        {extras ? (
          <IntelligenceCard intelligence={message.intelligence} variant="compact" hideSummary />
        ) : null}
        <RiskIndicator risk={message.risk} variant="compact" />
        <DecisionCard decision={message.decision} variant="compact" />
        <ActionCard action={message.action} variant="compact" />
        <OutcomeCard outcome={message.outcome} variant="compact" />
      </div>
    </article>
  );
}
