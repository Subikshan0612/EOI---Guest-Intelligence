/**
 * Pure building blocks of the OAuth2 / OIDC Authorization Code flow with PKCE (RFC 7636) for a PUBLIC browser client.
 * No provider name, no tenant, no secret, no DOM access and no framework: everything a provider-specific choice needs is passed in,
 * so this file is unit-testable in Node and can be swapped for a provider SDK without touching the rest of the application.
 *
 * A browser application is a PUBLIC client: it holds NO client secret (there is deliberately no variable, parameter or field for
 * one anywhere in the frontend) and proves possession of the authorization code with the PKCE verifier instead.
 */
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Random URL-safe string from the platform CSPRNG. */
export function randomString(byteLength = 32, cryptoImpl = globalThis.crypto) {
  return b64url(cryptoImpl.getRandomValues(new Uint8Array(byteLength)));
}

/** PKCE S256: `challenge = BASE64URL(SHA-256(verifier))`. */
export async function pkceChallenge(verifier, cryptoImpl = globalThis.crypto) {
  return b64url(await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

export async function createPkcePair(cryptoImpl = globalThis.crypto) {
  const verifier = randomString(48, cryptoImpl); // 64 characters, within RFC 7636's 43-128
  return { verifier, challenge: await pkceChallenge(verifier, cryptoImpl) };
}

export function buildAuthorizationUrl({ authorizationEndpoint, clientId, redirectUri, scope, state, challenge, audience, prompt }) {
  if (!authorizationEndpoint || !clientId || !redirectUri || !state || !challenge) throw new Error("Incomplete authorization request");
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope || "openid");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // OIDC Core `prompt=select_account`: lets a user who signed out (or has the wrong account) choose another account instead of being signed straight back in.
  if (prompt === "select_account") url.searchParams.set("prompt", prompt);
  if (audience) url.searchParams.set("audience", audience); // required by some providers to issue an API access token
  return url.toString();
}

/**
 * Interprets the redirect back from the provider. Returns `{ code }` for a valid response, `null` when the URL is not a callback,
 * and throws for a provider error or a state mismatch (a forged or replayed callback is never exchanged).
 */
export function parseCallback(search, expectedState) {
  const params = new URLSearchParams(search);
  if (!params.has("code") && !params.has("error")) return null;
  if (params.has("error")) throw new Error("Sign-in was not completed");
  if (!expectedState || params.get("state") !== expectedState) throw new Error("Sign-in response did not match the request");
  const code = params.get("code");
  if (!code) throw new Error("Sign-in response had no code");
  return { code };
}

const CALLBACK_PARAMS = ["code", "state", "error", "error_description", "error_uri", "session_state", "iss"];

/**
 * The post-sign-in return path (Phase 45B.2). The ONLY thing it can ever return is a same-origin, path-absolute application location
 * ("/path?query#hash") or "/". It is applied to the location the APPLICATION itself recorded when sign-in began and again when it is
 * used - never to anything a query string, a callback parameter or another site supplies. Anything that is not a plain internal path
 * (absolute or protocol-relative URL, other scheme, backslash or control character, a callback-parameter carrier, or a path that
 * normalises to another origin) becomes "/".
 */
export function sanitizeReturnPath(raw, origin) {
  const fallback = "/";
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048 || typeof origin !== "string" || !origin) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(raw)) return fallback;
  let url;
  try {
    url = new URL(raw, origin);
  } catch {
    return fallback;
  }
  if (url.origin !== origin) return fallback;
  if (CALLBACK_PARAMS.some((name) => url.searchParams.has(name))) return fallback;
  const normalised = `${url.pathname}${url.search}${url.hash}`;
  // The normalised form must still be a plain path: a "/.//host" style input collapses to "//host", which a browser reads as another origin.
  if (!normalised.startsWith("/") || normalised.startsWith("//")) return fallback;
  return normalised;
}

/**
 * Exchanges the code for a bearer token. Sends the PKCE verifier, never a secret. Returns `{ accessToken, expiresAt }`.
 *
 * Two modes:
 *  - `tokenEndpoint` (default): a PUBLIC client posts the code to the provider's token endpoint itself.
 *  - `exchangeUrl` (Phase 45B.4): for a provider that insists on a client SECRET at its token endpoint (Google, for a Web-application client),
 *    the browser must not and cannot do that. It posts `{ code, code_verifier, redirect_uri }` to the EOI backend, which holds the secret,
 *    performs the exchange and answers `{ data: { access_token, token_type, expires_in } }` after verifying the token. The browser sends and
 *    receives no secret in either mode.
 */
export async function exchangeCode({ tokenEndpoint, exchangeUrl, clientId, redirectUri, code, verifier, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const response = exchangeUrl
    ? await fetchImpl(exchangeUrl, {
        method: "POST",
        credentials: "include", // the unified EOI session sets its HttpOnly refresh cookie on this response
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirectUri }),
      })
    : await fetchImpl(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, redirect_uri: redirectUri, code, code_verifier: verifier }).toString(),
      });
  if (!response.ok) throw new Error("Sign-in could not be completed");
  const parsed = await response.json();
  const body = exchangeUrl ? parsed?.data : parsed;
  // Phase 46 (unified EOI session): the server may answer with a session, with "link_required" (a Google sign-in whose verified email belongs to an existing
  // password account: it must also prove that account's password) or with "access_restricted" (an administrator must grant access). No token comes with the last two.
  const status = exchangeUrl && typeof body?.status === "string" ? body.status : "signed_in";
  if (status === "link_required") {
    if (typeof body.link_ticket !== "string" || !body.link_ticket) throw new Error("Sign-in returned no link ticket");
    return { status, linkTicket: body.link_ticket };
  }
  if (status === "access_restricted") return { status };
  if (status !== "signed_in") throw new Error("Sign-in returned an unknown state");
  if (!body || typeof body.access_token !== "string" || !body.access_token) throw new Error("Sign-in returned no access token");
  if (body.token_type && String(body.token_type).toLowerCase() !== "bearer") throw new Error("Sign-in returned an unsupported token type");
  const lifetimeSeconds = Number.isFinite(Number(body.expires_in)) && Number(body.expires_in) > 0 ? Number(body.expires_in) : 300;
  return { status: "signed_in", accessToken: body.access_token, expiresAt: now() + lifetimeSeconds * 1000 };
}
