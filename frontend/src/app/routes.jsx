import { Navigate, Route, Routes } from "react-router-dom";
import AppShell from "../components/layout/AppShell";
import AssistantPage from "../pages/AssistantPage";
import GuestDetailPage from "../pages/GuestDetailPage";
import GuestsPage from "../pages/GuestsPage";
import Home from "../pages/Home";
import PropertiesPage from "../pages/PropertiesPage";
import PropertyDetailPage from "../pages/PropertyDetailPage";
import Settings from "../pages/Settings";

/**
 * The user-facing information architecture: Overview, Assistant, Properties, Guests & stays, Settings. The signal / analysis / learning pages are no longer part of it
 * (those records still exist and are produced by the assistant's case); an old link to one lands on the Assistant instead of a blank screen.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Home />} />
        {/* Phase 45A: the simulated chat was removed. Old links land on the landing page instead of a blank screen. */}
        <Route path="/chat/:conversationId?" element={<Navigate to="/" replace />} />
        <Route path="/assistant/:conversationId?" element={<AssistantPage />} />
        <Route path="/operations/properties" element={<PropertiesPage />} />
        <Route path="/operations/properties/:propertyId" element={<PropertyDetailPage />} />
        <Route path="/operations/guests" element={<GuestsPage />} />
        <Route path="/operations/guests/:guestId" element={<GuestDetailPage />} />
        <Route path="/operations/signals/*" element={<Navigate to="/assistant" replace />} />
        <Route path="/intelligence/*" element={<Navigate to="/assistant" replace />} />
        <Route path="/learning" element={<Navigate to="/" replace />} />
        <Route path="/prompts" element={<Navigate to="/" replace />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
