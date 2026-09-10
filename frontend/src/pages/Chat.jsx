import { useLocation, useParams } from "react-router-dom";
import ChatWorkspace from "../features/chat/ChatWorkspace";

export default function Chat() {
  const { conversationId } = useParams();
  const location = useLocation();

  return (
    <ChatWorkspace
      conversationId={conversationId ?? null}
      resetKey={conversationId ?? location.state?.resetAt ?? "new"}
    />
  );
}
