export default function ChatHeader({ title }) {
  if (!title) return null;

  return (
    <header className="chat-header">
      <p className="page-kicker">Investigation</p>
      <h1 className="chat-header-title" title={title}>
        {title}
      </h1>
    </header>
  );
}
