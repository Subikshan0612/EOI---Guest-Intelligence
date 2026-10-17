import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App.jsx";
import { showSigningIn } from "./services/auth/bootstrapNotice";
import { initOidcAuth, isAuthEnabled } from "./services/auth/oidc/oidcSession";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/layout.css";
import "./styles/chat.css";
import "./styles/operations.css";
import "./styles/dashboard.css";
import "./styles/auth.css";
import "./styles/assistant.css";
import "./styles/polish.css";

// Real sign-in (OIDC, Authorization Code + PKCE) when VITE_OIDC_* is configured. Not configured: development keeps its dev token; a production
// build shows "Authentication is not configured" instead of an unauthenticated app. The app renders once sign-in has settled; until then (a
// redirect, or a bounded provider request) a plain "Signing you in…" notice stands in for a blank page.
if (isAuthEnabled) showSigningIn(document.getElementById("root"));
initOidcAuth()
  .catch(() => {})
  .finally(() => {
    createRoot(document.getElementById("root")).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
