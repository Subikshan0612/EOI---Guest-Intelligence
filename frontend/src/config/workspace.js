/**
 * Development-only tenant context.
 *
 * KOI has no authentication yet, so the frontend must tell the API which
 * workspace it is acting in. That id is supplied at build time through
 * VITE_KOI_WORKSPACE_ID and read in exactly one place — here.
 *
 * When it is unset the app runs in LOCAL mode: conversations live only in the
 * browser (localStorage) and nothing is sent to the backend. This keeps a
 * fresh `npm run dev` working without a running backend, exactly like Phase 1.
 * When it is set the app runs in BACKEND mode and the REST API is the source
 * of truth for conversations and messages.
 *
 * The id must be a real workspace ObjectId from your local MongoDB. Create one
 * with `node backend/scripts/create-dev-workspace.mjs` (see frontend/.env.example).
 */
const raw = import.meta.env.VITE_KOI_WORKSPACE_ID;

export const KOI_WORKSPACE_ID = typeof raw === "string" ? raw.trim() : "";

export const isWorkspaceConfigured = KOI_WORKSPACE_ID.length > 0;
