/**
 * Phase 23: frontend sign-in building blocks (PKCE Authorization Code flow) and browser token-handling rules.
 * Offline and deterministic: the flow module is pure, and the token endpoint is a mock `fetch`. No provider is contacted.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAuthorizationUrl, createPkcePair, exchangeCode, parseCallback, pkceChallenge, randomString } from "../../frontend/src/services/auth/oidc/oidcFlow.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(__dirname, "..", "..", "frontend");

let passed = 0;
let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
};
const throws = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
};

// RFC 7636 appendix B test vector
check("PK1 the S256 challenge matches the RFC 7636 test vector", (await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")) === "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
const pair = await createPkcePair();
check("PK2 a generated verifier is 43-128 URL-safe characters and its challenge is S256 of it", /^[A-Za-z0-9_-]{43,128}$/.test(pair.verifier) && pair.challenge === (await pkceChallenge(pair.verifier)) && !pair.challenge.includes("=") && pair.verifier !== pair.challenge);
check("PK3 verifiers and states are random (no repeats in 200 draws)", new Set(Array.from({ length: 200 }, () => randomString(24))).size === 200);

const url = new URL(buildAuthorizationUrl({ authorizationEndpoint: "https://idp.example.com/authorize", clientId: "spa-client", redirectUri: "https://app.example.com/", scope: "openid profile email", state: "S1", challenge: pair.challenge, audience: "eoi-api" }));
check("AU1 the authorization request is code + S256 PKCE with state and the public client id", url.searchParams.get("response_type") === "code" && url.searchParams.get("code_challenge_method") === "S256" && url.searchParams.get("code_challenge") === pair.challenge && url.searchParams.get("state") === "S1" && url.searchParams.get("client_id") === "spa-client" && url.searchParams.get("audience") === "eoi-api");
check("AU2 the authorization request carries NO secret and NO verifier", !/secret|code_verifier/i.test(url.toString()) && !url.toString().includes(pair.verifier));
check("AU3 an incomplete request is refused", (await throws(() => buildAuthorizationUrl({ authorizationEndpoint: "https://idp.example.com/authorize", clientId: "x" })))?.message === "Incomplete authorization request");

check("CB1 a valid callback with the matching state yields the code", parseCallback("?code=abc&state=S1", "S1")?.code === "abc");
check("CB2 a URL that is not a callback returns null (nothing to do)", parseCallback("?page=2", "S1") === null && parseCallback("", "S1") === null);
check("CB3 a STATE MISMATCH is refused (forged / replayed callback)", (await throws(() => parseCallback("?code=abc&state=EVIL", "S1"))) instanceof Error);
check("CB4 a callback with NO stored state is refused", (await throws(() => parseCallback("?code=abc&state=S1", undefined))) instanceof Error && (await throws(() => parseCallback("?code=abc&state=S1", null))) instanceof Error);
check("CB5 a provider error response is refused, with a generic message", (await throws(() => parseCallback("?error=access_denied&error_description=secret+detail", "S1")))?.message === "Sign-in was not completed");
check("CB6 a callback without a code is refused", (await throws(() => parseCallback("?state=S1&code=", "S1"))) instanceof Error);

let sent = null;
const okFetch = async (endpoint, init) => {
  sent = { endpoint, init, body: new URLSearchParams(init.body) };
  return { ok: true, json: async () => ({ access_token: "opaque-access-token", token_type: "Bearer", expires_in: 600 }) };
};
const tokens = await exchangeCode({ tokenEndpoint: "https://idp.example.com/token", clientId: "spa-client", redirectUri: "https://app.example.com/", code: "abc", verifier: pair.verifier, fetchImpl: okFetch, now: () => 1_000_000 });
check("EX1 the code exchange returns the access token and an expiry (now + expires_in)", tokens.accessToken === "opaque-access-token" && tokens.expiresAt === 1_000_000 + 600_000);
check("EX2 the exchange sends the PKCE verifier and NEVER a client secret", sent.body.get("code_verifier") === pair.verifier && sent.body.get("grant_type") === "authorization_code" && !sent.body.has("client_secret") && !sent.init.headers.Authorization);
check("EX3 no refresh token is requested or returned to callers", !("refreshToken" in tokens) && !sent.body.has("refresh_token"));
const failing = (body, ok = true) => async () => ({ ok, json: async () => body });
check("EX4 a failed token response is refused with a generic message", (await throws(() => exchangeCode({ tokenEndpoint: "x", clientId: "c", redirectUri: "r", code: "a", verifier: "v", fetchImpl: failing({}, false) })))?.message === "Sign-in could not be completed");
check("EX5 a response without an access token is refused", (await throws(() => exchangeCode({ tokenEndpoint: "x", clientId: "c", redirectUri: "r", code: "a", verifier: "v", fetchImpl: failing({ token_type: "Bearer" }) }))) instanceof Error);
check("EX6 a non-Bearer token type is refused", (await throws(() => exchangeCode({ tokenEndpoint: "x", clientId: "c", redirectUri: "r", code: "a", verifier: "v", fetchImpl: failing({ access_token: "t", token_type: "MAC" }) }))) instanceof Error);
check("EX7 a missing/invalid expires_in falls back to a short 5-minute lifetime", (await exchangeCode({ tokenEndpoint: "x", clientId: "c", redirectUri: "r", code: "a", verifier: "v", fetchImpl: failing({ access_token: "t" }), now: () => 0 })).expiresAt === 300_000);

// static rules over the frontend source
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(js|jsx|mjs)$/.test(name)) files.push(full);
  }
};
walk(path.join(FRONTEND, "src"));
const source = (f) => readFileSync(f, "utf8");
const secretVars = files.filter((f) => /VITE_[A-Z0-9_]*(SECRET|PRIVATE|CLIENT_SECRET|STUB)/.test(source(f)));
check("FS1 no VITE_* variable for a client secret, private key or the stub secret exists in the frontend source", secretVars.length === 0, secretVars.join(","));
const envExample = readFileSync(path.join(FRONTEND, ".env.example"), "utf8");
check("FS2 the frontend env template names no secret variable (only PUBLIC OIDC settings) and warns against one", !/^\s*#?\s*VITE_[A-Z_]*SECRET/m.test(envExample) && /NO client secret/i.test(envExample));
const storageUse = files.filter((f) => /localStorage|sessionStorage/.test(source(f)) && !/conversationStore\.js|ConversationProvider\.jsx|config[\\/]workspace\.js|accessToken\.js|oidcSession\.js/.test(f));
check("FS3 no other file uses browser storage", storageUse.length === 0, storageUse.join(","));
const oidcSession = source(path.join(FRONTEND, "src/services/auth/oidc/oidcSession.js")).replace(/\/\*[\s\S]*?\*\//g, "");
check("FS4 the OIDC session stores ONLY non-credentials in sessionStorage - the transient sign-in transaction (state, PKCE verifier, sanitised return path, timestamp), a signed-out flag and a signed-in marker - never a token", /storage\.set\(KEY, JSON\.stringify\(\{ state, verifier, returnTo: path, at: now\(\) \}\)\)/.test(oidcSession) && /storage\.set\(SIGNED_OUT_KEY, "1"\)/.test(oidcSession) && /storage\.set\(SESSION_KEY, "1"\)/.test(oidcSession) && (oidcSession.match(/storage\.set\(/g) || []).length === 3 && !/(localStorage)/.test(oidcSession) && !/setItem\([^)]*[tT]oken/.test(oidcSession));
check("FS5 the access token is held in memory only (a module variable) and the transaction is deleted after use", /let memoryToken/.test(oidcSession) && /storage\.remove\(KEY\)/.test(oidcSession) && /replaceState/.test(oidcSession));
const accessToken = source(path.join(FRONTEND, "src/services/auth/accessToken.js"));
check("FS6 the token abstraction still stores nothing in browser storage and never decodes the token", !/localStorage|sessionStorage\.setItem|document\.cookie|atob\(|jwt|decode/i.test(accessToken.replace(/\/\*[\s\S]*?\*\//g, "")));
const devAuth = source(path.join(FRONTEND, "src/config/auth.js"));
check("FS7 the development token is read ONLY in a development build (import.meta.env.DEV)", /import\.meta\.env\.DEV \? import\.meta\.env\.VITE_DEV_ACCESS_TOKEN : ""/.test(devAuth));
const api = source(path.join(FRONTEND, "src/services/api.js"));
check("FS8 the API layer sends only `Authorization: Bearer` (no role, permission, workspace or knowledge-level header)", /Authorization/.test(api) && !/["']X-(Role|Permission|Workspace|Knowledge)/i.test(api));

console.log(`\nFrontend OIDC validation: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
