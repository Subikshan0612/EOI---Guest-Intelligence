import { Link, useLocation, useParams } from "react-router-dom";
import ChatWorkspace from "../features/chat/ChatWorkspace";
import { useConversations } from "../features/conversations/useConversations";

export default function Chat() {
  const { conversationId } = useParams();
  const location = useLocation();
  const { getById } = useConversations();
  const conversation = conversationId ? getById(conversationId) : null;

  if (conversationId && !conversation) {
    return (
      <article className="page">
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
      </article>
    );
  }

  return (
    <ChatWorkspace
      conversationId={conversationId ?? null}
      resetKey={conversationId ?? location.state?.resetAt ?? "new"}
    />
  );
}
