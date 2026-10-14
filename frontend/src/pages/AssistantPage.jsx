import { useEffect, useRef } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import RetryButton from "../components/auth/RetryButton";
import Composer from "../features/assistant/Composer";
import SignalCaseCard from "../features/assistant/SignalCaseCard";
import { INTAKE_OUTCOME } from "../features/assistant/assistantMapping";
import { useAssistantConversation } from "../features/assistant/useAssistantConversation";
import { useCaseGeneration } from "../features/assistant/useCaseGeneration";
import { useRecentConversations } from "../features/assistant/useRecentConversations";

/**
 * Assistant (Phase 52): the operator's way into EOI - an operational decision-support workspace, NOT a general chatbot and not a source of truth.
 *
 *   a question about a real situation -> recorded by the server (the same record the structured form makes) -> property / room / guest / stay context ->
 *   operating guidance -> AI assessment (validated, safety-checked on the server) -> a person's decision -> action -> outcome
 *
 * Sending a message records the report on the server (or asks ONE clarifying question) and then asks for the assessment - one explicit request, made from the submit handler
 * below and never on load: opening or refreshing a conversation only READS what the server stored. The conversation is an interaction layer; every fact on the page comes from the
 * workspace's own records and the stored assessment, and a refresh reloads all of it from the backend.
 */
export default function AssistantPage() {
  const { conversationId: routeId } = useParams();
  const navigate = useNavigate();
  const { messages, status, sending, sendError, send, reload } = useAssistantConversation(routeId);
  const generation = useCaseGeneration();
  const recent = useRecentConversations();
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length]);

  const onSend = async (content) => {
    const turn = await send(content);
    if (turn) {
      recent.refresh();
      if (!routeId) navigate(`/assistant/${turn.conversation.id}`, { replace: true }); // the first turn created the conversation: its address
      // The report was recorded: ask for its assessment (the person's own send is the request; the server returns a stored one without a model call).
      const recorded = turn.messages.find((message) => message.outcome === INTAKE_OUTCOME.SIGNAL_CREATED && message.signalId);
      if (recorded) generation.generate(recorded.signalId);
    }
    return turn;
  };

  return (
    <article className="page op-page asst-page">
      <header className="op-page-header">
        <div>
          <p className="page-kicker">Workspace · Assistant</p>
          <h1 className="page-title">Assistant</h1>
          <p className="page-lead">
            Ask about what is happening at your properties - a fault in a room, a guest request, a problem before a check-out. EOI assesses it against this workspace&apos;s property, guest and stay
            records and your operating guidance, and recommends what to do. You decide; EOI never carries anything out.
          </p>
        </div>
      </header>

      <div className="asst-layout">
        <section className="asst-main" aria-label="Conversation">
          {status === "unconfigured" ? (
            <p className="muted" role="status">No workspace is selected, so there is nothing to ask about.</p>
          ) : status === "loading" ? (
            <p className="muted" role="status">Loading the conversation…</p>
          ) : status === "missing" ? (
            <div className="investigation-state">
              <p className="op-form-error">This conversation is no longer available.</p>
              <Link to="/assistant" className="text-button">Start a new conversation</Link>
            </div>
          ) : status === "error" ? (
            <div className="investigation-state" role="alert">
              <p className="op-form-error">The conversation could not be loaded.</p>
              <RetryButton onClick={reload} />
            </div>
          ) : (
            <>
              <ol className="asst-thread" role="log" aria-label="Conversation messages" aria-live="polite">
                {messages.length === 0 ? (
                  <li className="asst-empty muted">
                    Nothing asked yet. Say where it happened and what happened - for example the room, and what the guest reported.
                  </li>
                ) : null}
                {messages.map((message) => (
                  <li key={message.id} className="asst-message" data-role={message.role}>
                    <p className="asst-speaker">{message.role === "assistant" ? "EOI" : "You"}</p>
                    <p className="asst-text">{message.content}</p>
                    {message.outcome === INTAKE_OUTCOME.SIGNAL_CREATED && message.signalId ? (
                      <SignalCaseCard
                        signalId={message.signalId}
                        severityStated={message.severityStated}
                        generation={generation.forSignal(message.signalId)}
                        onGenerate={generation.generate}
                        onObserve={generation.observe}
                        onRefresh={generation.refresh}
                        onRelease={generation.release}
                      />
                    ) : null}
                  </li>
                ))}
                <li ref={endRef} aria-hidden="true" className="asst-end" />
              </ol>
              <Composer onSend={onSend} busy={sending} error={sendError} disabled={status === "unconfigured"} />
            </>
          )}
        </section>

        <aside className="asst-side" aria-label="Recent conversations">
          <div className="asst-side-head">
            <h2 className="card-label">Conversations</h2>
            <Link to="/assistant" className="text-button asst-new">
              <Plus size={14} strokeWidth={2} aria-hidden="true" />
              New
            </Link>
          </div>
          {recent.status === "error" ? <p className="muted asst-note">Recent conversations couldn&apos;t be loaded.</p> : null}
          {recent.status === "ready" && recent.items.length === 0 ? <p className="muted asst-note">None yet.</p> : null}
          <ul className="asst-recent">
            {recent.items.map((item) => (
              <li key={item.id}>
                <NavLink to={`/assistant/${item.id}`} className="asst-recent-link">{item.title}</NavLink>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </article>
  );
}
