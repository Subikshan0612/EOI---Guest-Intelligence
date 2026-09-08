import { BookOpen, Plus, Settings, X } from "lucide-react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { groupConversationsByRecency } from "../../features/conversations/conversationSelectors";
import ConversationItem from "../../features/conversations/ConversationItem";
import { useConversations } from "../../features/conversations/useConversations";
import { useLayout } from "../../hooks/useLayout";
import { IconButton } from "../ui/IconButton";

export default function Sidebar() {
  const navigate = useNavigate();
  const { sidebarOpen, closeOverlays } = useLayout();
  const { conversations } = useConversations();
  const groups = groupConversationsByRecency(conversations);

  function startNewIntelligence(event) {
    event.preventDefault();
    closeOverlays();
    navigate("/chat", { state: { resetAt: Date.now() } });
  }

  return (
    <aside
      id="app-sidebar"
      className={sidebarOpen ? "app-sidebar is-open" : "app-sidebar"}
      aria-label="KOI navigation"
    >
      <div className="sidebar-brand">
        <Link to="/" className="sidebar-brand-copy" onClick={closeOverlays}>
          <p className="sidebar-brand-title">KOI</p>
          <p className="sidebar-brand-tagline">Kolam Operational Intelligence</p>
        </Link>
        <IconButton className="sidebar-close" label="Close navigation" onClick={closeOverlays}>
          <X size={18} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
      </div>

      <div className="sidebar-actions">
        <NavLink
          to="/chat"
          end
          className="primary-button new-intelligence-button"
          onClick={startNewIntelligence}
        >
          <Plus size={18} strokeWidth={1.75} aria-hidden="true" />
          New Intelligence
        </NavLink>
      </div>

      <nav className="sidebar-nav" aria-label="Conversations">
        <p className="nav-label">Conversations</p>
        {groups.length ? (
          groups.map((group) => (
            <div key={group.label} className="conversation-group">
              <p className="nav-label">{group.label}</p>
              {group.conversations.map((conversation) => (
                <ConversationItem
                  key={conversation.id}
                  conversation={conversation}
                  onNavigate={closeOverlays}
                />
              ))}
            </div>
          ))
        ) : (
          <div className="sidebar-empty" role="status">
            <p>No intelligence sessions yet.</p>
            <p>Start a new investigation to begin.</p>
          </div>
        )}
      </nav>

      <div className="sidebar-footer">
        <p className="nav-label">Intelligence</p>
        <NavLink to="/prompts" className="nav-link" onClick={closeOverlays}>
          <BookOpen size={18} strokeWidth={1.75} aria-hidden="true" />
          Prompt Library
        </NavLink>
        <p className="nav-label">Workspace</p>
        <NavLink to="/settings" className="nav-link" onClick={closeOverlays}>
          <Settings size={18} strokeWidth={1.75} aria-hidden="true" />
          Settings
        </NavLink>
      </div>
    </aside>
  );
}
