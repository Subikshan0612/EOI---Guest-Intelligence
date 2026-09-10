import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import ChatHeader from "./ChatHeader";
import IntelligenceEmptyState from "./IntelligenceEmptyState";
import MessageList from "./MessageList";
import PromptInput from "./PromptInput";
import ThinkingIndicator from "./ThinkingIndicator";
import { useChat } from "./useChat";

function prefersReducedMotion() {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function ChatWorkspace({ conversationId = null, resetKey = "default" }) {
  const { conversation, draft, setDraft, send, retry, isProcessing, error, status, retryLoad } =
    useChat({
      conversationId,
      resetKey,
    });

  const listRef = useRef(null);
  const bottomRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const messages = conversation.messages ?? [];
  const hasMessages = messages.length > 0;
  const showEmpty = !hasMessages && !isProcessing && status === "ready";

  useEffect(() => {
    stickToBottomRef.current = true;
  }, [resetKey, conversation.id]);

  useEffect(() => {
    if (!stickToBottomRef.current || !bottomRef.current) return;
    bottomRef.current.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "end",
    });
  }, [messages, isProcessing, error]);

  function handleScroll() {
    const node = listRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    stickToBottomRef.current = distance < 96;
  }

  function handleSend(content) {
    stickToBottomRef.current = true;
    send(content);
  }

  const composer = (
    <>
      <PromptInput
        value={draft}
        onChange={setDraft}
        onSubmit={() => handleSend(draft)}
        sending={isProcessing}
        autoFocus={showEmpty}
      />
      {showEmpty && error ? (
        <p className="chat-error chat-error-inline" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );

  if (status === "loading") {
    return (
      <div className="chat-workspace is-empty">
        <section className="investigation-state" role="status">
          <p className="page-kicker">Investigation</p>
          <p className="page-lead">Loading conversation…</p>
        </section>
      </div>
    );
  }

  if (status === "missing") {
    return (
      <div className="chat-workspace is-empty">
        <section className="investigation-state">
          <p className="page-kicker">Investigation</p>
          <h1 className="page-title">Conversation not found</h1>
          <p className="page-lead">
            This investigation is no longer available. It may have been deleted, or the link is
            invalid.
          </p>
          <Link className="text-button" to="/chat">
            Start a new intelligence session
          </Link>
        </section>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="chat-workspace is-empty">
        <section className="investigation-state" role="alert">
          <p className="page-kicker">Investigation</p>
          <h1 className="page-title">Couldn’t load this conversation</h1>
          <p className="page-lead">
            KOI could not reach the backend. Check your connection and try again.
          </p>
          <button type="button" className="text-button" onClick={retryLoad}>
            Try again
          </button>
        </section>
      </div>
    );
  }

  if (showEmpty) {
    return (
      <div className="chat-workspace is-empty">
        <IntelligenceEmptyState composer={composer} onSuggestion={(text) => setDraft(text)} />
      </div>
    );
  }

  return (
    <div className="chat-workspace" aria-busy={isProcessing}>
      <ChatHeader title={conversation.title} />
      <MessageList
        messages={messages}
        listRef={listRef}
        bottomRef={bottomRef}
        onScroll={handleScroll}
      >
        {isProcessing ? <ThinkingIndicator /> : null}
        {error ? (
          <div className="chat-error" role="alert">
            <p>{error}</p>
            <button type="button" className="text-button" onClick={retry}>
              Try again
            </button>
          </div>
        ) : null}
      </MessageList>
      <div className="chat-composer-dock">{composer}</div>
    </div>
  );
}
