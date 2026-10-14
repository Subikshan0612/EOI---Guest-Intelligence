/**
 * Development-only access token.
 *
 * EOI has no real sign-in yet. To read the authenticated Decision endpoints in
 * local development, a token that was ISSUED BY THE BACKEND'S DEVELOPMENT
 * TOOLING can be supplied through VITE_DEV_ACCESS_TOKEN (frontend/.env, never
 * committed):
 *
 *   cd backend && node scripts/issue-dev-token.mjs --subject <dev-subject>
 *
 * The value is ONLY the token. The signing secret (AUTH_STUB_SECRET) lives in
 * the backend's environment and must never be put in a VITE_* variable, in
 * frontend source, or in browser storage. The token identifies a real backend
 * User (issuer + subject) - the backend still decides that user's workspace
 * membership, role and knowledge level, and refuses everything if there is none.
 *
 * It is read ONLY in a development build (`import.meta.env.DEV`). In a
 * production build this constant is the empty string, so a token can never be
 * shipped in production code by accident.
 */
const raw = import.meta.env.DEV ? import.meta.env.VITE_DEV_ACCESS_TOKEN : "";

export const DEV_ACCESS_TOKEN = typeof raw === "string" ? raw.trim() : "";
