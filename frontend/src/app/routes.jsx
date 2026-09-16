import { Route, Routes } from "react-router-dom";
import AppShell from "../components/layout/AppShell";
import Chat from "../pages/Chat";
import GuestDetailPage from "../pages/GuestDetailPage";
import GuestsPage from "../pages/GuestsPage";
import Home from "../pages/Home";
import LearningPage from "../pages/LearningPage";
import PromptLibraryPage from "../pages/PromptLibraryPage";
import PropertiesPage from "../pages/PropertiesPage";
import PropertyDetailPage from "../pages/PropertyDetailPage";
import Settings from "../pages/Settings";
import SignalDetailPage from "../pages/SignalDetailPage";
import SignalIntelligencePage from "../pages/SignalIntelligencePage";
import SignalsPage from "../pages/SignalsPage";

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Home />} />
        <Route path="/chat/:conversationId?" element={<Chat />} />
        <Route path="/operations/properties" element={<PropertiesPage />} />
        <Route path="/operations/properties/:propertyId" element={<PropertyDetailPage />} />
        <Route path="/operations/guests" element={<GuestsPage />} />
        <Route path="/operations/guests/:guestId" element={<GuestDetailPage />} />
        <Route path="/operations/signals" element={<SignalsPage />} />
        <Route path="/operations/signals/:signalId" element={<SignalDetailPage />} />
        <Route path="/operations/signals/:signalId/intelligence" element={<SignalIntelligencePage />} />
        <Route path="/prompts" element={<PromptLibraryPage />} />
        <Route path="/learning" element={<LearningPage />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
