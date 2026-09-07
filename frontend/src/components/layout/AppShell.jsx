import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { useLayout } from "../../hooks/useLayout";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import ContextPanel from "./ContextPanel";
import Header from "./Header";
import Sidebar from "./Sidebar";

export default function AppShell() {
  const { pathname, sidebarOpen, contextOpen, closeOverlays } = useLayout();
  const isTabletOrBelow = useMediaQuery("(max-width: 1100px)");
  const isMobile = useMediaQuery("(max-width: 768px)");
  const overlayVisible = (isMobile && sidebarOpen) || (isTabletOrBelow && contextOpen);

  useEffect(() => {
    if (!overlayVisible) return undefined;

    const onKeyDown = (event) => {
      if (event.key === "Escape") closeOverlays();
    };

    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [overlayVisible, closeOverlays]);

  useEffect(() => {
    closeOverlays();
  }, [pathname, closeOverlays]);

  return (
    <>
      <a className="skip-link" href="#main-workspace">
        Skip to main workspace
      </a>
      <div className="app-shell">
        <Header />
        <Sidebar />
        <main id="main-workspace" className="main-workspace" tabIndex={-1}>
          <Outlet />
        </main>
        <ContextPanel />
      </div>
      {overlayVisible ? (
        <button
          type="button"
          className="overlay is-visible"
          aria-label="Close panel"
          onClick={closeOverlays}
        />
      ) : null}
    </>
  );
}
