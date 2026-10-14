/**
 * A LOCAL, loopback-only OpenID Connect test provider (Phase 45B.2). TEST TOOLING - it is not a real identity provider, it stands in for
 * none, and nothing it proves counts as verification of a real provider (issuer, client registration, audience, redirect URIs, logout).
 *
 * It exists so the provider-neutral sign-in code can be exercised end to end (browser redirect -> callback -> code exchange -> API request
 * -> backend JWKS verification) without choosing or contacting any external provider:
 *
 *   GET  /.well-known/openid-configuration   discovery (issuer, authorization_endpoint, token_endpoint, jwks_uri)
 *   GET  /jwks                               the public signing key (RS256)
 *   GET  /authorize                          validates the PKCE request and redirects back (behaviour set by `config.authorize`)
 *   POST /token                              verifies the PKCE verifier and returns a Bearer JWT access token
 *   GET  /__stats   POST /__config           test control (CORS-open; loopback only)
 *
 * `config.authorize`: "ok" (redirect with a code) | "error" (redirect with error=access_denied) | "noresponse" (redirect back with no
 * code and no error - a provider that loses the response) | "login-page" (answer 200 and do not redirect, like an interactive login page).
 * `config.tokenMode`: "ok" | "fail" (the token endpoint answers 400) | "hang" (accepts the request and never answers).
 * `config.googleMode` (Phase 45B.4): behave like a Google "web" client - the token endpoint requires `config.clientSecret`, answers with an opaque access token
 * and an ID token (aud = client id); `config.idTokenMode`: "ok" | "wrong-aud" | "wrong-iss" | "expired" | "bad-sig" | "no-id-token".
 * `config.discoveryMode`: "ok" | "hang" (accepts the discovery request and never answers). `stats.hung` counts requests left hanging and `stats.aborted` those the
 * client gave up on (connection closed before any answer) - proof that a client timeout really aborted the underlying request.
 */
import crypto from "node:crypto";
import http from "node:http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const sha256b64url = (value) => crypto.createHash("sha256").update(value).digest("base64url");

export async function startLocalOidcProvider({ port = 0, host = "127.0.0.1", audience = "eoi-api-test", clientId = "local-test-client" } = {}) {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const kid = `local-${crypto.randomBytes(4).toString("hex")}`;
  const publicJwk = { ...(await exportJWK(publicKey)), kid, use: "sig", alg: "RS256" };
  const config = { sub: "local-user-1", email: undefined, ttlSeconds: 3600, authorize: "ok", tokenMode: "ok", discoveryMode: "ok", extraClaims: {}, audience, googleMode: false, clientSecret: "test-client-secret-not-real", idTokenMode: "ok" };
  const stats = { authorize: 0, token: 0, discovery: 0, jwks: 0, authorizeErrors: 0, hung: 0, aborted: 0, tokenWithSecret: 0, tokenWithoutSecret: 0, lastRedirectUris: [] };
  const hang = (req, res) => { stats.hung += 1; res.on("close", () => { if (!res.writableEnded) stats.aborted += 1; }); /* never answers */ };
  const codes = new Map();
  let issuer = "";

  async function mintToken({ sub = config.sub, ttlSeconds = config.ttlSeconds, aud = config.audience, iss, email = config.email, extra = config.extraClaims, key = privateKey, kidOverride = kid, issuedAt = Math.floor(Date.now() / 1000) } = {}) {
    const claims = { ...(email ? { email } : {}), ...extra };
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: kidOverride, typ: "at+jwt" })
      .setIssuer(iss ?? issuer)
      .setAudience(aud)
      .setSubject(sub)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ttlSeconds)
      .sign(key);
  }

  const readBody = (req) => new Promise((resolve) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))); });
  const cors = (res) => { res.setHeader("access-control-allow-origin", "*"); res.setHeader("access-control-allow-headers", "content-type, accept"); res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS"); };
  const json = (res, status, body) => { cors(res); res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer || "http://127.0.0.1");
    if (req.method === "OPTIONS") { cors(res); res.statusCode = 204; return res.end(); }
    if (url.pathname === "/.well-known/openid-configuration") {
      stats.discovery += 1;
      if (config.discoveryMode === "hang") return hang(req, res);
      return json(res, 200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
    }
    if (url.pathname === "/jwks") { stats.jwks += 1; return json(res, 200, { keys: [publicJwk] }); }
    if (url.pathname === "/__stats") return json(res, 200, stats);
    if (url.pathname === "/__config" && req.method === "POST") {
      try { Object.assign(config, JSON.parse(await readBody(req))); } catch { return json(res, 400, { error: "bad config" }); }
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/authorize") {
      stats.authorize += 1;
      const q = url.searchParams;
      const redirectUri = q.get("redirect_uri") ?? "";
      stats.lastRedirectUris.push(redirectUri);
      if (q.get("response_type") !== "code" || q.get("client_id") !== clientId || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge") || !q.get("state") || !redirectUri) {
        stats.authorizeErrors += 1;
        res.statusCode = 400; return res.end("invalid authorization request");
      }
      if (config.authorize === "login-page") { res.statusCode = 200; res.setHeader("content-type", "text/html"); return res.end("<!doctype html><title>Local test provider</title><p>Local test provider login page</p>"); }
      const target = new URL(redirectUri);
      if (config.authorize === "ok") {
        const code = crypto.randomBytes(16).toString("hex");
        codes.set(code, { challenge: q.get("code_challenge"), redirectUri });
        target.searchParams.set("code", code);
        target.searchParams.set("state", q.get("state"));
      } else if (config.authorize === "error") {
        target.searchParams.set("error", "access_denied");
        target.searchParams.set("error_description", "the-provider-said-no");
        target.searchParams.set("state", q.get("state"));
      } // "noresponse": redirect back with nothing
      res.statusCode = 302; res.setHeader("location", target.toString()); return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      stats.token += 1;
      const form = new URLSearchParams(await readBody(req));
      if (config.tokenMode === "hang") return hang(req, res);
      if (config.tokenMode === "fail") return json(res, 400, { error: "invalid_grant" });
      if (form.has("client_secret")) stats.tokenWithSecret += 1; else stats.tokenWithoutSecret += 1;
      if (config.googleMode) {
        // Google-like confidential "web" client: the token endpoint REQUIRES the client secret (PKCE does not replace it), and the answer carries
        // an OPAQUE access token plus the ID token (a JWT whose audience is the client id). No refresh token is issued (no offline access).
        if (!form.get("client_secret")) return json(res, 400, { error: "invalid_request", error_description: "client_secret is missing." });
        if (form.get("client_secret") !== config.clientSecret) return json(res, 401, { error: "invalid_client", error_description: "Unauthorized" });
      } else if (form.has("client_secret")) {
        return json(res, 400, { error: "invalid_grant" });
      }
      const entry = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? ""); // single use
      if (!entry || form.get("grant_type") !== "authorization_code" || form.get("client_id") !== clientId || form.get("redirect_uri") !== entry.redirectUri || sha256b64url(form.get("code_verifier") ?? "") !== entry.challenge) {
        return json(res, 400, { error: "invalid_grant" });
      }
      if (!config.googleMode) return json(res, 200, { access_token: await mintToken(), token_type: "Bearer", expires_in: config.ttlSeconds });
      if (config.idTokenMode === "no-id-token") return json(res, 200, { access_token: "ya29.opaque-not-a-jwt", token_type: "Bearer", expires_in: 3599 });
      const google = { aud: clientId, email: config.email ?? `${config.sub}@example.invalid`, extra: { email_verified: true, name: "Test Person", picture: "https://example.invalid/p.png", hd: "example.invalid", ...config.extraClaims } };
      const idToken = await (config.idTokenMode === "wrong-aud" ? mintToken({ ...google, aud: "another-client-id" })
        : config.idTokenMode === "wrong-iss" ? mintToken({ ...google, iss: "https://accounts.attacker.example" })
        : config.idTokenMode === "expired" ? mintToken({ ...google, issuedAt: Math.floor(Date.now() / 1000) - 7200, ttlSeconds: 3600 })
        : config.idTokenMode === "bad-sig" ? mintToken({ ...google, key: (await generateKeyPair("RS256")).privateKey })
        : mintToken(google));
      return json(res, 200, { access_token: "ya29.opaque-not-a-jwt", expires_in: 3599, scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile", token_type: "Bearer", id_token: idToken });
    }
    res.statusCode = 404; return res.end();
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  issuer = `http://${host}:${server.address().port}`;
  return { issuer, port: server.address().port, clientId, audience, config, stats, mintToken, publicJwk, privateKey, kid, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Run directly for a long-lived provider (browser verification): node localOidcProvider.mjs --port 5190 [--audience x] [--client y]
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
  const provider = await startLocalOidcProvider({ port: Number(arg("port", 5190)), audience: arg("audience", "eoi-api-test"), clientId: arg("client", "local-test-client") });
  console.log(`local test OIDC provider (NOT a real provider) listening at ${provider.issuer}`);
  setInterval(() => {}, 1 << 30);
}
