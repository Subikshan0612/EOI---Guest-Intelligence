import { useEffect, useRef } from "react";
import { Outlet } from "react-router-dom";
import { useLayout } from "../../hooks/useLayout";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import DevProfileNotice from "../auth/DevProfileNotice";
import SessionNotice from "../auth/SessionNotice";
import Header from "./Header";
import Sidebar from "./Sidebar";

/**
 * The page a path shows, with record ids folded away: moving between two conversations (or two guests) is the SAME page, so it neither replays the entrance nor resets
 * the scroll position; moving to another page does.
 */
const pageKey = (pathname) => pathname.replace(/\/[0-9a-f]{24}(?=\/|$)/gi, "/:id").replace(/^(\/assistant)(\/.*)?$/, "$1");

export default function AppShell() {
  const { pathname, sidebarOpen, closeOverlays } = useLayout();
  const isMobile = useMediaQuery("(max-width: 768px)");
  const overlayVisible = isMobile && sidebarOpen;
  const mainRef = useRef(null);
  const page = pageKey(pathname);

  // The main area is the scroll container: a new page opens at its top (the document itself never scrolls).
  useEffect(() => {
    mainRef.current?.scrollTo?.({ top: 0 });
  }, [page]);

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
        <main id="main-workspace" ref={mainRef} className="main-workspace" tabIndex={-1}>
          <div className="route-view" key={page}>
            <DevProfileNotice />
            <SessionNotice />
            <Outlet />
          </div>
        </main>
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
