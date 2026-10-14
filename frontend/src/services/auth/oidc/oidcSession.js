import { setAccessTokenSource, clearAccessToken, setTokenRefresher } from "../accessToken";
import { AUTH_REASON, beginSigningIn, blockApp, configureAuthLifecycle, markReady } from "../authSession";
import { buildAuthorizationUrl, createPkcePair, exchangeCode, parseCallback, randomString, sanitizeReturnPath } from "./oidcFlow";

/**
 * Browser sign-in for a real OIDC provider (Authorization Code + PKCE). This is the ONLY provider-facing file of the frontend; the
 * rest of the application still asks `getAccessToken()` and knows nothing about it.
 *
 * Configuration (all PUBLIC values; there is no client secret and no variable for one, by design):
 *   VITE_OIDC_AUTHORITY   the issuer URL (its /.well-known/openid-configuration is discovered)
 *   VITE_OIDC_CLIENT_ID   the public client id registered for this SPA
 *   VITE_OIDC_REDIRECT_URI  optional, default: this origin
 *   VITE_OIDC_SCOPE       optional, default "openid profile email"
 *   VITE_OIDC_AUDIENCE    optional, for providers that need an audience to issue an API access token
 *
 * TOKEN HANDLING: the access token lives in MEMORY ONLY (the accessToken module) and is never written to localStorage,
 * sessionStorage or a cookie; a reload signs in again (the provider's own session makes that silent). No refresh token is requested
 * or kept - an expired session is recovered by an explicit "sign in again" (Phase 45B.2); whether to ask the provider for refresh
 * tokens is an external/provider decision. sessionStorage holds only NON-CREDENTIALS:
 *   - the short-lived, single-use sign-in transaction (`state`, PKCE verifier, the application path to return to, a timestamp),
 *     deleted as soon as the callback is handled;
 *   - a "signed out" flag, so a reload after Logout does not silently sign the user straight back in.
 *
 * LIFECYCLE (Phase 45B.2):
 *   - a callback that fails (provider error, state mismatch, failed exchange) ends in an explicit "Sign-in was not completed" screen. It
 *     NEVER starts another sign-in on its own, so a provider that keeps answering with an error cannot cause a redirect loop;
 *   - coming back from the provider WITHOUT a response (a transaction is still pending, no code/error in the URL) is treated the same way;
 *   - the only automatic redirect left is the very first load of the app with no session, once per page load;
 *   - the return path is recorded by the application when sign-in begins (never taken from a query parameter), restricted to a
 *     same-origin internal path (sanitizeReturnPath) and applied with history.replaceState after the callback;
 *   - Logout is application-side: it forgets the in-memory token and ends authenticated requests. It does NOT end the provider's
 *     own session. A provider that advertises `end_session_endpoint` in its discovery document could be used generically for that
 *     (RP-initiated logout, with a registered post-logout redirect URI), but which providers/URIs are allowed is provider
 *     configuration that does not exist yet, so nothing here calls it.
 */
const KEY = "koi.oidc.transaction";
const TRANSIENT_REFRESH = new Error("Refresh temporarily unavailable");
const SIGNED_OUT_KEY = "koi.oidc.signedOut";
// Non-credential marker: "this TAB was signed in and has not signed out". It lets a RELOAD restore the session (one redirect to the provider, silent while the
// provider's own session exists) while a fresh visit (new tab) still shows the welcome screen. It is consumed whenever a sign-in starts and set only after a
// sign-in succeeds, so a failing restore can never repeat on its own. It holds no token, id or claim.
const SESSION_KEY = "koi.oidc.session";
const TRANSACTION_MAX_AGE_MS = 10 * 60 * 1000;
const EXPIRY_MARGIN_MS = 5000;
// Every request of the sign-in flow (discovery, token exchange) is bounded: a provider that accepts the connection and never answers must not
// leave the user waiting forever. Interactive sign-in: long enough for a slow network, short enough that "unavailable" is shown promptly.
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** A failure of the CONNECTION (no network, the server did not answer in time), as opposed to an answer saying no. Only the error's kind is read, never shown. */
const isConnectionFailure = (error) => error?.name === "TypeError" || error?.name === "AbortError" || error?.message === "Sign-in request timed out";

/** @param {{ settings: {authority:string, clientId:string, redirectUri:string, scope:string, audience:string, tokenExchangeUrl?:string, autoRedirect?:boolean}, production?: boolean, win?: any, fetchImpl?: Function, cryptoImpl?: any, now?: () => number, timeoutMs?: number }} options */
export function createOidcSession({ settings, production = false, win = globalThis.window, fetchImpl = (...args) => globalThis.fetch(...args), cryptoImpl = globalThis.crypto, now = () => Date.now(), timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
  // Google (the OIDC provider) may or may not be configured; with the unified EOI session (settings.eoiAuth, Phase 46) email + password sign-in exists too.
  const googleConfigured = Boolean(settings.authority && settings.clientId);
  const eoi = Boolean(settings.eoiAuth);
  const configured = googleConfigured || eoi;
  let memoryToken = null;
  let memoryExpiry = 0;
  let linkTicket = null; // memory only: a Google sign-in is waiting for the account's password (Phase 46 linking)

  const storage = {
    get(key) {
      try {
        return win.sessionStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        win.sessionStorage.setItem(key, value);
      } catch {
        /* storage unavailable: the flow still works, it just cannot remember */
      }
    },
    remove(key) {
      try {
        win.sessionStorage.removeItem(key);
      } catch {
        /* nothing to remove */
      }
    },
  };

  let failure = "failed"; // why the last callback did not complete: 'failed' | 'cancelled' | 'network' (a closed set; selects fixed wording only)

  const tokenSource = () => (memoryToken && now() < memoryExpiry - EXPIRY_MARGIN_MS ? memoryToken : null);
  const redirectUri = () => settings.redirectUri || `${win.location.origin}/`;
  const currentPath = () => sanitizeReturnPath(`${win.location.pathname}${win.location.search}${win.location.hash}`, win.location.origin);

  /**
   * Runs one provider request with a deadline. On expiry the underlying request is ABORTED and the operation rejects (its message is never
   * shown: callers map any failure to a fixed screen). There is no retry here - the user decides whether to try again.
   */
  async function bounded(run) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Sign-in request timed out"));
      }, timeoutMs);
    });
    try {
      return await Promise.race([run(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  const discover = () =>
    bounded(async (signal) => {
      const response = await fetchImpl(`${settings.authority}/.well-known/openid-configuration`, { headers: { Accept: "application/json" }, signal });
      if (!response.ok) throw new Error("Sign-in provider is unavailable");
      const document = await response.json();
      if (document.issuer !== settings.authority && document.issuer !== `${settings.authority}/`) throw new Error("Sign-in provider mismatch");
      return document;
    });

  function readTransaction() {
    const raw = storage.get(KEY);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value.state !== "string" || typeof value.verifier !== "string") return null;
      if (typeof value.at === "number" && now() - value.at > TRANSACTION_MAX_AGE_MS) return null; // abandoned long ago: ignore it
      return value;
    } catch {
      return null;
    }
  }

  /** Takes over a server-issued EOI session: the short-lived access token goes to memory ONLY (the refresh token is an HttpOnly cookie the page cannot read). */
  function adoptSession({ accessToken, expiresInSeconds }) {
    memoryToken = accessToken;
    memoryExpiry = now() + expiresInSeconds * 1000;
    linkTicket = null;
    storage.remove(SIGNED_OUT_KEY); // signed in again: a reload must restore this session, not show "signed out"
    setAccessTokenSource(tokenSource); // a new credential: also clears an earlier "rejected" state
    setTokenRefresher(eoi ? refreshForRequest : null);
  }

  const authUrl = (route) => `${settings.apiBase.replace(/\/+$/, "")}/auth/${route}`;
  const jsonHeaders = { "Content-Type": "application/json", Accept: "application/json", "X-KOI-Request": "1" };

  /**
   * Renews the access token from the refresh cookie (the ONLY way a session continues after the short access token ends). Single-flight: concurrent callers
   * share one request, so two parts of the page cannot rotate the cookie twice. Resolves 'ok' | 'denied' (no session: sign in again) | 'network'. Never retries.
   */
  let refreshing = null;
  function refreshSession() {
    if (!eoi) return Promise.resolve("denied");
    refreshing ??= (async () => {
      try {
        const body = await bounded(async (signal) => {
          // keepalive: the server rotates the refresh cookie the moment it accepts this request, and the browser only stores the NEW cookie when it receives the response. If the page
          // is unloaded while the request is in flight (a reload, a fast navigation, a closing tab) a normal fetch is cancelled and the response - with the rotated cookie - is
          // lost: the browser keeps the old cookie, and its next refresh after the short grace window is (correctly) treated as theft and revokes the session. A keepalive request
          // outlives the page, so the rotated cookie is always delivered. The server's rotation, grace window and reuse detection are unchanged.
          const response = await fetchImpl(authUrl("refresh"), { method: "POST", credentials: "include", headers: jsonHeaders, signal, keepalive: true });
          if (response.status === 401 || response.status === 403) return null;
          // A rate-limited (429) or failing (5xx) server says nothing about the session itself: report it as unreachable (a retryable screen), not as "signed out".
          if (response.status === 429 || response.status >= 500) throw TRANSIENT_REFRESH;
          if (!response.ok) throw new Error("Refresh failed");
          return (await response.json())?.data;
        });
        if (!body || typeof body.access_token !== "string" || !body.access_token) return "denied";
        adoptSession({ accessToken: body.access_token, expiresInSeconds: Number(body.expires_in) > 0 ? Number(body.expires_in) : 300 });
        return "ok";
      } catch (error) {
        return error === TRANSIENT_REFRESH || isConnectionFailure(error) ? "network" : "denied";
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }
  const refreshForRequest = async () => ((await refreshSession()) === "ok" ? memoryToken : null);

  /** Redirects the browser to the provider. `returnTo` defaults to where the user is now; it is validated before it is stored. */
  async function startSignIn({ returnTo, prompt } = {}) {
    if (!googleConfigured) throw new Error("Google sign-in is not configured");
    storage.remove(SIGNED_OUT_KEY);
    storage.remove(SESSION_KEY);
    const { authorization_endpoint: authorizationEndpoint } = await discover();
    const { verifier, challenge } = await createPkcePair(cryptoImpl);
    const state = randomString(24, cryptoImpl);
    const path = sanitizeReturnPath(returnTo ?? currentPath(), win.location.origin);
    storage.set(KEY, JSON.stringify({ state, verifier, returnTo: path, at: now() }));
    win.location.assign(buildAuthorizationUrl({ authorizationEndpoint, clientId: settings.clientId, redirectUri: redirectUri(), scope: settings.scope, state, challenge, audience: settings.audience, prompt }));
    await new Promise(() => {}); // the page is navigating away: never render an unauthenticated app in the meantime
  }

  /** A user-triggered sign-in (the "Sign in again" / "Sign in" buttons). A failure to START is shown, never retried by itself. */
  async function signIn(options) {
    beginSigningIn(); // the button shows it is working; cleared by the page navigating away or by the failure screen below
    try {
      await startSignIn(options);
    } catch (error) {
      blockApp(isConnectionFailure(error) ? AUTH_REASON.NETWORK_FAILED : AUTH_REASON.SIGN_IN_UNAVAILABLE);
    }
  }

  /**
   * Handles the provider's redirect. Resolves true when a token was obtained and false when the callback failed in ANY way;
   * the failure detail is deliberately discarded (nothing about it is ever shown). The callback parameters are always removed
   * from the address bar, and the transaction is single-use.
   */
  async function completeSignIn() {
    const transaction = readTransaction();
    let succeeded = false;
    failure = "failed";
    try {
      // The provider reports a person who cancelled or declined as `access_denied`: a normal outcome, worded as such (the value itself is never shown).
      if (new URLSearchParams(win.location.search).get("error") === "access_denied") failure = "cancelled";
      const callback = parseCallback(win.location.search, transaction?.state);
      // With a server-side exchange (providers that require a client secret) the provider's token endpoint is not used by the browser at all.
      const tokenEndpoint = settings.tokenExchangeUrl ? undefined : (await discover()).token_endpoint;
      const exchanged = await bounded((signal) =>
        exchangeCode({ tokenEndpoint, exchangeUrl: settings.tokenExchangeUrl || undefined, clientId: settings.clientId, redirectUri: redirectUri(), code: callback.code, verifier: transaction.verifier, fetchImpl: (url, init) => fetchImpl(url, { ...init, signal }), now }),
      );
      if (exchanged.status === "link_required") {
        linkTicket = exchanged.linkTicket; // memory only; the screen asks for the account's password next
        failure = "link";
      } else if (exchanged.status === "access_restricted") {
        failure = "restricted";
      } else {
        memoryToken = exchanged.accessToken;
        memoryExpiry = exchanged.expiresAt;
        setAccessTokenSource(tokenSource); // also clears any earlier "rejected" state: this is a new credential
        setTokenRefresher(eoi ? refreshForRequest : null);
        succeeded = true;
      }
    } catch (error) {
      memoryToken = null;
      memoryExpiry = 0;
      if (failure !== "cancelled" && failure !== "link" && failure !== "restricted" && isConnectionFailure(error)) failure = "network";
    } finally {
      storage.remove(KEY);
      // The code and state never stay in the address bar or the history. The address goes back to the page the person was on (the path the APPLICATION
      // recorded, sanitised), succeeded or not, so "Try again" after a failure returns to the same page.
      win.history.replaceState({}, "", sanitizeReturnPath(transaction?.returnTo, win.location.origin));
    }
    return succeeded;
  }

  /**
   * Called once before the app renders. Registers the memory-only token source. Outcomes:
   *   not configured, development/test build   nothing (development keeps its explicit dev token)
   *   not configured, production build         the app is replaced by "Authentication is not configured" - it never looks signed-in
   *   callback in the URL                      signed in (and back to the requested page), or "Sign-in was not completed"
   *   back from the provider with no response  "Sign-in was not completed"
   *   signed out earlier in this tab           the signed-out screen
   *   otherwise                                one redirect to the provider
   */
  async function initOidcAuth() {
    if (!configured) {
      configureAuthLifecycle({ tokenRequired: false, signInAvailable: false });
      if (production) blockApp(AUTH_REASON.NOT_CONFIGURED);
      return;
    }
    configureAuthLifecycle({ tokenRequired: true, signInAvailable: true });
    setAccessTokenSource(tokenSource);
    setTokenRefresher(eoi ? refreshForRequest : null);

    const params = new URLSearchParams(win.location.search);
    if (params.has("code") || params.has("error")) {
      if (await completeSignIn()) {
        storage.set(SESSION_KEY, "1");
        markReady();
      } else {
        blockApp(
          failure === "link" ? AUTH_REASON.LINK_REQUIRED
            : failure === "restricted" ? AUTH_REASON.ACCESS_RESTRICTED
              : failure === "cancelled" ? AUTH_REASON.CANCELLED
                : failure === "network" ? AUTH_REASON.NETWORK_FAILED
                  : AUTH_REASON.CALLBACK_FAILED,
        );
      }
      return;
    }
    if (readTransaction()) {
      storage.remove(KEY);
      blockApp(AUTH_REASON.CALLBACK_FAILED);
      return;
    }
    if (storage.get(SIGNED_OUT_KEY)) {
      blockApp(AUTH_REASON.SIGNED_OUT);
      return;
    }
    // The unified EOI session: the refresh COOKIE (HttpOnly, set by the server) is the session. A reload, a new tab, or coming back later restores it silently;
    // no cookie (or a revoked one) means nobody is signed in and the sign-in page is shown. No redirect to Google is ever started automatically in this mode.
    if (eoi) {
      const restored = await refreshSession();
      if (restored === "ok") markReady();
      else blockApp(restored === "network" ? AUTH_REASON.NETWORK_FAILED : AUTH_REASON.WELCOME);
      return;
    }
    // A fresh visit with no session: either one redirect to the provider (default) or the welcome screen with the sign-in button. A RELOAD of a tab that was
    // signed in is not a fresh visit: it restores the session with the one redirect (silent when the provider still has its session).
    if (settings.autoRedirect === false && !storage.get(SESSION_KEY)) {
      blockApp(AUTH_REASON.WELCOME);
      return;
    }
    try {
      await startSignIn();
    } catch {
      blockApp(AUTH_REASON.SIGN_IN_UNAVAILABLE);
    }
  }

  /**
   * Asks the server to revoke the session behind the refresh cookie. Resolves true ONLY when the server answered 2xx (the session is revoked and the cookie cleared);
   * a network failure, a timeout, a 4xx or a 5xx is false. Nothing about why is kept or shown.
   */
  async function revokeOnServer() {
    try {
      return await bounded(async (signal) => (await fetchImpl(authUrl("logout"), { method: "POST", credentials: "include", headers: jsonHeaders, signal })).ok === true);
    } catch {
      return false;
    }
  }

  /**
   * Sign-out. The page stops using the session AT ONCE (the in-memory access token is forgotten, authenticated requests fail locally). In the unified EOI session the
   * server must also revoke the session behind the HttpOnly refresh cookie, and the person is told "you have signed out" ONLY after the server confirmed that. If it could
   * not be confirmed (no connection, timeout, server error) the person is told so and can try again; the signed-out marker is NOT set, so a reload honestly restores the
   * session that the server still considers valid. EOI sign-out never ends the Google session.
   */
  let signingOut = null;
  function signOut() {
    signingOut ??= (async () => {
      memoryToken = null;
      memoryExpiry = 0;
      linkTicket = null;
      clearAccessToken(); // nothing is offered to the API layer again until a new sign-in
      setTokenRefresher(null);
      storage.remove(KEY);
      storage.remove(SESSION_KEY);
      if (eoi) blockApp(AUTH_REASON.SIGNING_OUT);
      // Without the unified session there is no server session to revoke, so this stays synchronous (the short-circuit never awaits).
      if (!eoi || (await revokeOnServer())) {
        storage.set(SIGNED_OUT_KEY, "1");
        blockApp(AUTH_REASON.SIGNED_OUT);
      } else {
        storage.remove(SIGNED_OUT_KEY);
        blockApp(AUTH_REASON.SIGN_OUT_FAILED);
      }
    })().finally(() => {
      signingOut = null;
    });
    return signingOut;
  }

  /** The sign-in page (not an error screen) is wanted: used by "Sign in again" and "Try again" in the unified-session mode. */
  function showSignIn() {
    storage.remove(KEY);
    memoryToken = null;
    memoryExpiry = 0;
    linkTicket = null;
    blockApp(AUTH_REASON.WELCOME);
  }

  return {
    configured, googleConfigured, startSignIn, signIn, completeSignIn, initOidcAuth, signOut, showSignIn, adoptSession, refreshSession,
    getMemoryToken: () => memoryToken, getLinkTicket: () => linkTicket, clearLinkTicket: () => { linkTicket = null; },
  };
}

// Each setting is read through a STATIC `import.meta.env.NAME` reference. Do not alias or spread `import.meta.env`: a bundler can then no longer
// replace names one by one and emits the WHOLE environment object into the production bundle - including any VITE_DEV_ACCESS_TOKEN present at
// build time (the development token must never ship; see config/auth.js).
export const oidcSettings = {
  authority: (import.meta.env.VITE_OIDC_AUTHORITY || "").trim().replace(/\/+$/, ""),
  clientId: (import.meta.env.VITE_OIDC_CLIENT_ID || "").trim(),
  redirectUri: (import.meta.env.VITE_OIDC_REDIRECT_URI || "").trim(),
  scope: (import.meta.env.VITE_OIDC_SCOPE || "openid profile email").trim(),
  audience: (import.meta.env.VITE_OIDC_AUDIENCE || "").trim(),
  // Phase 45B.4 (both PUBLIC, non-secret): the EOI backend endpoint that performs the code exchange for a provider requiring a client secret, and the
  // provider's display name for the sign-in button ("Sign in with Google"). Neither is a credential; there is no variable for a secret.
  tokenExchangeUrl: (import.meta.env.VITE_OIDC_TOKEN_EXCHANGE_URL || "").trim(),
  providerLabel: (import.meta.env.VITE_OIDC_PROVIDER_LABEL || "").trim().slice(0, 40),
  // Phase 45B.4: "false" shows a signed-out screen with a "Sign in" button on a fresh visit instead of redirecting to the provider at once. Default: redirect.
  autoRedirect: (import.meta.env.VITE_OIDC_AUTO_REDIRECT || "true").trim().toLowerCase() !== "false",
  // Phase 46 (PUBLIC switches, not credentials): the unified EOI session (email + password and Google behind ONE session) and the API origin its endpoints live on.
  eoiAuth: (import.meta.env.VITE_KOI_AUTH || "").trim().toLowerCase() === "eoi",
  apiBase: (import.meta.env.VITE_API_BASE_URL || "").trim(),
};
export const isOidcConfigured = Boolean(oidcSettings.authority && oidcSettings.clientId);
/** The unified EOI session is in use (email + password and/or Google sign in to the SAME session). */
export const isEoiAuth = oidcSettings.eoiAuth;
/** Some real sign-in is in use (Google, the unified session, or both): the application is gated and Sign out exists. */
export const isAuthEnabled = isOidcConfigured || isEoiAuth;

const session = createOidcSession({ settings: oidcSettings, production: Boolean(import.meta.env.PROD) });

export const initOidcAuth = () => session.initOidcAuth();
export const startSignIn = (options) => session.startSignIn(options);
export const signIn = (options) => session.signIn(options);
export const signOut = () => session.signOut();
export const showSignIn = () => session.showSignIn();
/** A sign-in that completed on this page (email + password, or the Google link step): keep the session in memory and open the application. */
export const adoptSession = (grant) => {
  session.adoptSession(grant);
  markReady();
};
export const getLinkTicket = () => session.getLinkTicket();
export const clearLinkTicket = () => session.clearLinkTicket();
export const isGoogleConfigured = isOidcConfigured;
