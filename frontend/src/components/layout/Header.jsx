import { Menu } from "lucide-react";
import { useLocation, useMatch } from "react-router-dom";
import { useLayout } from "../../hooks/useLayout";
import { workspace } from "../../data/mockData";
import SignOutButton from "../auth/SignOutButton";
import { IconButton } from "../ui/IconButton";

const pageMeta = {
  "/": {
    kicker: "Workspace",
    title: "Overview",
  },
  "/assistant": {
    kicker: "Workspace",
    title: "Assistant",
  },
  "/operations/properties": {
    kicker: "Operations",
    title: "Properties",
  },
  "/operations/guests": {
    kicker: "Operations",
    title: "Guests & stays",
  },
  "/settings": {
    kicker: "Account",
    title: "Settings",
  },
};

export default function Header() {
  const location = useLocation();
  const { toggleSidebar, sidebarOpen } = useLayout();
  const propertyDetailMatch = useMatch("/operations/properties/:propertyId");
  const guestDetailMatch = useMatch("/operations/guests/:guestId");
  const assistantMatch = useMatch("/assistant/:conversationId");

  const meta = propertyDetailMatch
    ? { kicker: "Operations", title: "Property" }
    : guestDetailMatch
      ? { kicker: "Operations", title: "Guest" }
      : assistantMatch
        ? pageMeta["/assistant"]
        : (pageMeta[location.pathname] ?? pageMeta["/"]);

  return (
    <header className="app-header">
      <div className="header-start">
        <span className="header-brand" aria-hidden="true">
          <span className="brand-mark">EOI</span>
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
        <SignOutButton />
      </div>
    </header>
  );
}
