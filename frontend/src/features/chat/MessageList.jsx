import AssistantMessage from "./AssistantMessage";
import UserMessage from "./UserMessage";

export default function MessageList({ messages, children, listRef, bottomRef, onScroll }) {
  return (
    <div
      className="message-list"
      ref={listRef}
      onScroll={onScroll}
      role="log"
      aria-live="polite"
      aria-relevant="additions"
    >
      {messages.map((message) =>
        message.role === "user" ? (
          <UserMessage key={message.id} message={message} />
        ) : (
          <AssistantMessage key={message.id} message={message} />
        ),
      )}
      {children}
      <div ref={bottomRef} />
    </div>
  );
}
