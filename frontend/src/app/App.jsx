import { BrowserRouter } from "react-router-dom";
import { ConversationProvider } from "../features/conversations/ConversationProvider";
import { LayoutProvider } from "./providers/LayoutProvider";
import { AppRoutes } from "./routes";

export default function App() {
  return (
    <BrowserRouter>
      <LayoutProvider>
        <ConversationProvider>
          <AppRoutes />
        </ConversationProvider>
      </LayoutProvider>
    </BrowserRouter>
  );
}
