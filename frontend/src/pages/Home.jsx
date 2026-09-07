import { useLocation } from "react-router-dom";
import ChatWorkspace from "../features/chat/ChatWorkspace";

export default function Home() {
  const location = useLocation();

  return <ChatWorkspace conversationId={null} resetKey={location.state?.resetAt ?? "home"} />;
}
