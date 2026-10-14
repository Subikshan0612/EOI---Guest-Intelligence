/**
 * The workspace the app is acting in.
 *
 * Development without real sign-in: one workspace id supplied at build time through VITE_KOI_WORKSPACE_ID (a real workspace ObjectId from the local
 * MongoDB; create one with `node backend/scripts/create-dev-workspace.mjs`). When it is unset the app has no workspace ("unconfigured").
 *
 * With real sign-in (Phase 45C) the workspace is NOT a build-time constant: after sign-in the server says which workspaces the signed-in person belongs to
 * (GET /api/auth/session) and the app calls `setActiveWorkspace(id)` with one of THEIR OWN. The server still decides everything: the id is only a
 * selector that every request is validated against the caller's membership, so a wrong or foreign id gets the usual safe 404.
 *
 * `KOI_WORKSPACE_ID` and `isWorkspaceConfigured` are ES-module LIVE BINDINGS: every importer reads the current value when it uses it, so the app
 * renders only after the active workspace has been set (see hooks/useAccountSession.js) and nothing captures a stale copy.
 */
const raw = import.meta.env.VITE_KOI_WORKSPACE_ID;

/** The build-time workspace id (development), or "". Never used as the active workspace once real sign-in is in use. */
export const BUILD_WORKSPACE_ID = typeof raw === "string" ? raw.trim() : "";

export let KOI_WORKSPACE_ID = BUILD_WORKSPACE_ID;
export let isWorkspaceConfigured = KOI_WORKSPACE_ID.length > 0;

/**
 * The signed-in person's role in the active workspace, as the server reported it (GET /api/auth/session), or "" when unknown (development without sign-in).
 * It is used ONLY to decide which buttons to SHOW. It grants nothing: it is never sent to the server, and every request is authorized by the server from the
 * verified membership regardless of what this says.
 */
export let KOI_WORKSPACE_ROLE = "";

/** Sets (or, with "", clears) the workspace the app acts in. Only an id in the standard 24-hex form is accepted. `role` is display-only (see KOI_WORKSPACE_ROLE). */
export function setActiveWorkspace(id, role = "") {
  const value = typeof id === "string" && /^[0-9a-fA-F]{24}$/.test(id.trim()) ? id.trim() : "";
  KOI_WORKSPACE_ID = value;
  isWorkspaceConfigured = value.length > 0;
  KOI_WORKSPACE_ROLE = value && typeof role === "string" && /^[a-z]{3,20}$/.test(role) ? role : "";
}

/** Returns to the build-time default (development), e.g. after sign-out. */
export function resetActiveWorkspace() {
  setActiveWorkspace(BUILD_WORKSPACE_ID);
}
