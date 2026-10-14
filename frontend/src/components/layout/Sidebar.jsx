import { Building2, LayoutDashboard, MessageSquareText, Settings, Users, X } from "lucide-react";
import { Link, NavLink } from "react-router-dom";
import { useLayout } from "../../hooks/useLayout";
import { IconButton } from "../ui/IconButton";

export default function Sidebar() {
  const { sidebarOpen, closeOverlays } = useLayout();

  return (
    <aside
      id="app-sidebar"
      className={sidebarOpen ? "app-sidebar is-open" : "app-sidebar"}
      aria-label="EOI navigation"
    >
      <div className="sidebar-brand">
        <Link to="/" className="sidebar-brand-copy" onClick={closeOverlays}>
          <p className="sidebar-brand-title">EOI</p>
          <p className="sidebar-brand-tagline">Enterprise Operational Intelligence</p>
        </Link>
        <IconButton className="sidebar-close" label="Close navigation" onClick={closeOverlays}>
          <X size={18} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
      </div>

      <div className="sidebar-footer">
        <p className="nav-label">Workspace</p>
        <NavLink to="/" end className="nav-link" onClick={closeOverlays}>
          <LayoutDashboard size={18} strokeWidth={1.75} aria-hidden="true" />
          Overview
        </NavLink>
        <NavLink to="/assistant" className="nav-link" onClick={closeOverlays}>
          <MessageSquareText size={18} strokeWidth={1.75} aria-hidden="true" />
          Assistant
        </NavLink>
        <p className="nav-label">Operations</p>
        <NavLink to="/operations/properties" className="nav-link" onClick={closeOverlays}>
          <Building2 size={18} strokeWidth={1.75} aria-hidden="true" />
          Properties
        </NavLink>
        <NavLink to="/operations/guests" className="nav-link" onClick={closeOverlays}>
          <Users size={18} strokeWidth={1.75} aria-hidden="true" />
          Guests &amp; stays
        </NavLink>
        <p className="nav-label">Account</p>
        <NavLink to="/settings" className="nav-link" onClick={closeOverlays}>
          <Settings size={18} strokeWidth={1.75} aria-hidden="true" />
          Settings
        </NavLink>
      </div>
    </aside>
  );
}
