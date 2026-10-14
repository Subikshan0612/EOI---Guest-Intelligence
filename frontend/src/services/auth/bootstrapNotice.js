/**
 * A minimal, framework-free notice shown while sign-in initialises (Phase 45B.2.2). The application renders only after initOidcAuth() settles
 * (it must not show an unauthenticated app first), and that may involve a redirect to the provider or a network request, so without this the
 * document would be blank in the meantime. React's first render replaces it. Fixed wording only: no address, setting or identifier.
 * The wait itself is bounded by the sign-in request deadline (oidcSession.js), so this can never stay up indefinitely.
 */
export const SIGNING_IN_TEXT = "Signing you in…";

export function showSigningIn(container, doc = globalThis.document) {
  if (!container || !doc) return;
  const screen = doc.createElement("main");
  screen.className = "auth-screen";
  const card = doc.createElement("section");
  card.className = "koi-card auth-card";
  card.setAttribute("role", "status");
  const brand = doc.createElement("p");
  brand.className = "auth-brand";
  brand.textContent = "EOI";
  const text = doc.createElement("p");
  text.className = "page-lead";
  text.textContent = SIGNING_IN_TEXT;
  card.append(brand, text);
  screen.append(card);
  container.replaceChildren(screen);
}
