# Authentication - Phase 23: real OIDC behind the token-verifier seam

Validated offline by `scripts/validate-phase23-oidc.mjs` (131 checks, local test issuer and test-only keys) and
`scripts/validate-frontend-oidc.mjs` (27 checks). Authorization (Phases 9-22) is unchanged.

## 1. The seam that was audited (and left intact)

```
Authorization: Bearer <token>
  -> authenticate            parseBearer -> getTokenVerifier()(token) -> normalizeVerifiedIdentity
  -> User.findOne({ issuer, subject })       403 IDENTITY_NOT_REGISTERED / 403 USER_DISABLED
  -> req.actor { userId, issuer, subject, email, workspaceId: null, role: null }
  -> requireWorkspaceMembership   (active workspace + ACTIVE membership; role comes from the membership row)
  -> requirePermission            (server-side role map)  -> controller
```
The verifier contract (`tokenContract.js`) is `async (token) => { issuer, subject, email?, expiresAt }`. EOI keeps ONLY those four
fields; token claims can never define a role, permission, workspace or knowledge level. Phase 23 replaces what sits BEHIND
`getTokenVerifier()`; `authenticate`, membership, permissions and every controller are untouched (one added line in `server.js`,
the provider selection in `tokenVerifier.js`).

## 2. Providers (explicit, fail closed)

`AUTH_PROVIDER=oidc | stub` (`auth/authConfig.js`). The legacy `AUTH_TOKEN_VERIFIER=stub` still selects the stub, in development/test only.

| Environment | Behavior |
|---|---|
| `NODE_ENV=production` | requires a VALID OIDC configuration, else the server **refuses to start** (exit 1). The stub is refused. |
| `NODE_ENV=development` / `test` | OIDC or the stub, as configured; the stub needs no external provider |
| unset / unknown `NODE_ENV` | the stub is refused; OIDC works; with nothing configured every authenticated request is 503 |

OIDC settings: `OIDC_ISSUER` (exact `iss`; https, or http for loopback in dev/test), `OIDC_AUDIENCE` (comma list), optional
`OIDC_JWKS_URI` (else discovered; the discovery document's `issuer` must equal `OIDC_ISSUER`), `OIDC_ALGORITHMS` (asymmetric only,
default `RS256,ES256`; HS* and `none` are refused at startup), `OIDC_CLOCK_TOLERANCE_SECONDS` (0-300, default 60, for `nbf`/`iat`),
`OIDC_REQUIRED_TYP`, `OIDC_JWKS_COOLDOWN_MS` (30 s), `OIDC_JWKS_CACHE_MAX_AGE_MS` (10 min), `OIDC_HTTP_TIMEOUT_MS` (5 s).
No provider, tenant, domain or client id is in the source code.

## 3. Verification (library: `jose`; nothing cryptographic is hand-written)

signature (JWKS public keys), algorithm allow-list, `iss` exact match, `aud` contains a configured audience, `exp` (strict; EOI re-checks it
after verification), `nbf` (with tolerance), `iat` REQUIRED and not in the future beyond the tolerance, `sub` required, `typ` if configured.
Keys: cached; an UNKNOWN `kid` triggers a re-fetch at most once per cooldown (an attacker cannot make the server hammer the provider);
rotation is picked up automatically; a retired key stops verifying after the cache refresh.

## 4. Claims policy

| Claim | Used? |
|---|---|
| `iss` + `sub` | **the identity** (the only key a User is found by) |
| `aud`, `exp`, `nbf`, `iat` | validated only |
| `email` | an attribute passed along, never a key; **not persisted at login** (a token cannot rewrite a User) |
| `name`, `preferred_username`, `email_verified` | never read |
| `groups`, `roles`, `scope`, tenant/workspace ids | never read. Provider groups are NOT mapped to EOI roles; the membership + role map stay the only authority. A group-to-role mapping is a possible future, separate phase. |

## 5. User lifecycle

* **First login of an unknown identity:** authenticated but not provisioned -> `403 IDENTITY_NOT_REGISTERED`. No User, no membership is created
  (auto-provisioning is not compatible with a product where roles/workspaces are assigned deliberately, and would let authentication imply authorization).
* **Provisioning** is an operator act: `node scripts/provision-user.mjs --subject <sub> [--issuer <iss>] [--email ..] [--workspace <id|slug> --role <role>]`
  (idempotent; a role is never assumed; changing a role needs `--update-role`).
* **Existing user:** found by `(issuer, subject)` (unique index); repeated logins resolve the same User, never duplicates. Same `sub` under another issuer is a different User.
* **Disabled user:** `403 USER_DISABLED` even with a valid token. Revoked membership / foreign workspace: the usual 404.

## 6. Status codes

401 no/malformed/invalid/expired token (`INVALID_TOKEN`, `TOKEN_EXPIRED`, `MISSING_CREDENTIAL`; the client never learns which check failed) - 403 unregistered/disabled user or missing
permission - 404 hidden workspace/object - **503 `AUTH_PROVIDER_UNAVAILABLE`** when verification could not be completed (JWKS/discovery unreachable or invalid): fail closed.

## 7. Frontend (public client; Authorization Code + PKCE)

Isolated in `frontend/src/services/auth/oidc/` (pure `oidcFlow.js`, provider-facing `oidcSession.js`); the rest of the app still calls `getAccessToken()`.
Activated only when `VITE_OIDC_AUTHORITY` and `VITE_OIDC_CLIENT_ID` (public values) are set; otherwise development keeps its explicit dev token (development builds only).
There is NO client secret and no variable for one. The access token is held in **memory only** (a reload signs in again through the provider's own session);
only the transient, single-use sign-in transaction (`state` + PKCE verifier, not a credential) is placed in sessionStorage and deleted at the callback. No refresh token is requested.
No in-app login UI exists: credentials are entered only at the provider.

## 8. Remaining before production

* A real-provider integration test (issuer/audience/`typ` of the chosen provider; whether it issues JWT access tokens for the API audience).
* Provisioning workflow for real users at scale (the CLI is the minimum; there is no self-service or SCIM).
* Token revocation is not checked (no introspection): rely on short access-token lifetimes.
* Sign-out/session-expiry UX in the SPA; a shared rate-limit store; a group-to-role mapping decision (optional).
