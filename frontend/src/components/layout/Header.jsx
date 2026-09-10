import { Menu, PanelRight } from "lucide-react";
import { useLocation, useMatch } from "react-router-dom";
import { useConversations } from "../../features/conversations/useConversations";
import { useLayout } from "../../hooks/useLayout";
import { workspace } from "../../data/mockData";
import { IconButton } from "../ui/IconButton";

const pageMeta = {
  "/": {
    kicker: "Workspace",
    title: "Intelligence",
  },
  "/chat": {
    kicker: "Workspace",
    title: "New investigation",
  },
  "/prompts": {
    kicker: "Intelligence",
    title: "Prompt library",
  },
  "/settings": {
    kicker: "Workspace",
    title: "Settings",
  },
};

export default function Header() {
  const location = useLocation();
  const { toggleSidebar, toggleContext, contextOpen, sidebarOpen } = useLayout();
  const { getById, listStatus } = useConversations();
  const chatMatch = useMatch("/chat/:conversationId");
  const conversationId = chatMatch?.params.conversationId;
  const conversation = conversationId ? getById(conversationId) : null;

  const meta = conversation
    ? { kicker: "Investigation", title: conversation.title }
    : conversationId
      ? {
          kicker: "Investigation",
          title: listStatus === "loading" ? "Loading…" : "Conversation not found",
        }
      : (pageMeta[location.pathname] ?? pageMeta["/"]);

  return (
    <header className="app-header">
      <div className="header-start">
        <span className="header-brand" aria-hidden="true">
          <span className="brand-mark">KOI</span>
        </span>
        <IconButton
          className="menu-toggle"
          label={sidebarOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={sidebarOpen}
          aria-controls="app-sidebar"
          onClick={toggleSidebar}
        >
          <Menu size={20} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
        <div className="header-copy">
          <p className="header-kicker">{meta.kicker}</p>
          <p className="header-title" title={meta.title}>
            {meta.title}
          </p>
        </div>
      </div>
      <div className="header-end">
        <IconButton
          className="context-toggle"
          label={contextOpen ? "Hide stay context" : "Show stay context"}
          aria-expanded={contextOpen}
          aria-controls="context-panel"
          onClick={toggleContext}
        >
          <PanelRight size={20} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
        <span className="workspace-chip" title={workspace.name}>
          <span className="workspace-dot" aria-hidden="true" />
          <span>{workspace.name}</span>
        </span>
        <span
          className="profile-avatar"
          role="img"
          aria-label={`${workspace.profileLabel} profile`}
        >
          {workspace.initials}
        </span>
      </div>
    </header>
  );
}
