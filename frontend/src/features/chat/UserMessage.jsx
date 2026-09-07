export default function UserMessage({ message }) {
  return (
    <article className="chat-message chat-message-user">
      <p className="chat-message-kicker">Operator</p>
      <div className="user-message-surface">
        <p>{message.content}</p>
      </div>
    </article>
  );
}
