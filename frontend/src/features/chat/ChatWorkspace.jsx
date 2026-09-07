import { useEffect, useRef } from "react";
import ChatHeader from "./ChatHeader";
import IntelligenceEmptyState from "./IntelligenceEmptyState";
import MessageList from "./MessageList";
import PromptInput from "./PromptInput";
import ThinkingIndicator from "./ThinkingIndicator";
import { useChat } from "./useChat";

export default function ChatWorkspace({ conversationId = null, resetKey = "default" }) {
  const { conversation, draft, setDraft, send, retry, isProcessing, error } = useChat({
    conversationId,
    resetKey,
  });

  const listRef = useRef(null);
  const bottomRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const hasMessages = conversation.messages.length > 0;
  const showEmpty = !hasMessages && !isProcessing;

  useEffect(() => {
    stickToBottomRef.current = true;
  }, [resetKey, conversation.id]);

  useEffect(() => {
    if (!stickToBottomRef.current || !bottomRef.current) return;
    bottomRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conversation.messages, isProcessing, error]);

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
    <PromptInput
      value={draft}
      onChange={setDraft}
      onSubmit={() => handleSend(draft)}
      sending={isProcessing}
      autoFocus={showEmpty}
    />
  );

  if (showEmpty) {
    return (
      <div className="chat-workspace is-empty">
        <IntelligenceEmptyState
          composer={composer}
          onSuggestion={(text) => setDraft(text)}
        />
      </div>
    );
  }

  return (
    <div className="chat-workspace" aria-busy={isProcessing}>
      <ChatHeader title={conversation.title} />
      <MessageList
        messages={conversation.messages}
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
