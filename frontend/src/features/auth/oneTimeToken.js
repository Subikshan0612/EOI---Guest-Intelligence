/**
 * The one-time token in an email link (?token=...). It is read ONCE from the address, the address is cleaned at once (so the token is not left in the address
 * bar, the history or a shared screenshot, and is not sent as a Referer), and it is then held in memory for this page only. React StrictMode runs effects twice in
 * development, so the value is remembered per kind: the second run gets the same token instead of finding an empty address.
 */
const held = { verify: null, reset: null };

export function takeOneTimeToken(kind, win = globalThis.window) {
  if (!win?.location) return held[kind] ?? ""; // no browser (a server render): nothing in the address to read
  const params = new URLSearchParams(win.location.search);
  const token = params.get("token");
  if (token) {
    held[kind] = /^[A-Za-z0-9_-]{20,128}$/.test(token) ? token : "";
    win.history.replaceState({}, "", win.location.pathname);
  }
  return held[kind] ?? "";
}

export function forgetOneTimeToken(kind) {
  held[kind] = null;
}
