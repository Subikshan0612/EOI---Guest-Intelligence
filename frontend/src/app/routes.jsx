import { Route, Routes } from "react-router-dom";
import AppShell from "../components/layout/AppShell";
import Chat from "../pages/Chat";
import Home from "../pages/Home";
import PromptLibraryPage from "../pages/PromptLibraryPage";
import PropertiesPage from "../pages/PropertiesPage";
import PropertyDetailPage from "../pages/PropertyDetailPage";
import Settings from "../pages/Settings";

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Home />} />
        <Route path="/chat/:conversationId?" element={<Chat />} />
        <Route path="/operations/properties" element={<PropertiesPage />} />
        <Route path="/operations/properties/:propertyId" element={<PropertyDetailPage />} />
        <Route path="/prompts" element={<PromptLibraryPage />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
