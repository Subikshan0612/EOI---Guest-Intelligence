import { useCallback, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { LayoutContext } from "./layoutContext";

export function LayoutProvider({ children }) {
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);

  const closeOverlays = useCallback(() => {
    setSidebarOpen(false);
    setContextOpen(false);
  }, []);

  const value = useMemo(
    () => ({
      pathname: location.pathname,
      sidebarOpen,
      contextOpen,
      setSidebarOpen,
      setContextOpen,
      toggleSidebar: () => setSidebarOpen((open) => !open),
      toggleContext: () => setContextOpen((open) => !open),
      closeOverlays,
    }),
    [location.pathname, sidebarOpen, contextOpen, closeOverlays],
  );

  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}
