# Google as the OIDC provider (Phase 45B.4)

> **Configuration update (environment cleanup).** There is now ONE runtime environment file per service. The separate `backend/.env.google` and `frontend/.env.google` described below no longer exist: the Google settings (client id and secret, issuer, redirect URIs) live in `backend/.env`, and the public `VITE_OIDC_*` values live in `frontend/.env`. `npm run dev:google` in both folders still starts the stack on ports 5001 / 5175, reading those files. Wherever this document says `.env.google`, read `.env`.

> **Phase 46 update:** with `AUTH_PROVIDER=eoi` (and `VITE_KOI_AUTH=eoi` in the frontend profile) Google is one of two ways in (the other is email + password) and both end in the SAME EOI session
> (short-lived access token + HttpOnly refresh cookie). The Google steps below (PKCE, server-side code exchange, ID-token verification) are unchanged; what changes is that Google's ID token is no
> longer the API bearer - it is verified once in the exchange and converted. See `UNIFIED_AUTH_PHASE46.md` (including how a Google sign-in is linked to an existing password account).


Google is integrated through the EXISTING provider-neutral architecture (Authorization Code + PKCE in the SPA, JWT verification in Node, then
`issuer + subject -> User -> WorkspaceMembership -> role -> permissions`). Nothing in the authorization model changed.

## What Google actually does (verified against the real Google, no credentials)

* Discovery: issuer is exactly `https://accounts.google.com`; ID tokens are RS256; PKCE `S256` is supported; there is **no** end-session endpoint.
* The token endpoint accepts only `client_secret_post` / `client_secret_basic`. For this **Web application** client it answers
  `client_secret is missing` to a PKCE-only exchange. **A browser cannot complete Google's code exchange**, and the secret must never reach a browser.
* The OAuth *access token* Google returns is opaque (not a JWT the backend can verify). The **ID token** is a JWT whose `aud` is the OAuth client id.

## Token architecture

```
Browser (public SPA)                    EOI backend (holds the secret)                 Google
  authorize (code + S256 PKCE, state) ------------------------------------------------> sign-in
  <------------------------------ redirect back to http://localhost:5175/?code=&state=
  POST /api/auth/oidc/token {code, code_verifier, redirect_uri}
        ----------------------->   redirect_uri must be on the EXACT allow-list (else refused, Google not contacted)
                                   POST token endpoint (from discovery) with client_id + CLIENT SECRET + code + verifier -------->
                                   <---------------------- { id_token, opaque access_token, ... }
                                   verify id_token: issuer, audience (= client id), signature (Google JWKS), RS256, exp, iat, sub
                                   discard everything except the verified ID token
  <-----------------------------   { access_token: <verified ID token>, token_type: Bearer, expires_in }
  Authorization: Bearer <ID token>  (memory only)  ->  every API request is verified AGAIN by the same verifier
```

* **What the browser sends to EOI:** the Google **ID token** as `Authorization: Bearer`. Its `iss` (`https://accounts.google.com`) and `sub` are the identity.
* **How Node verifies it:** `auth/oidcTokenVerifier.js` (unchanged): `OIDC_ISSUER` exact match, `OIDC_AUDIENCE` must contain the OAuth client id, signature against the
  JWKS discovered from the issuer, algorithm allow-list (RS256/ES256), `exp` enforced, `iat` and `sub` required. No claim other than `iss`, `sub`, `exp` and (display only) `email` is read.
* **Identity:** `issuer + subject` only. Email is never a key. `role`, `groups`, `hd`, `workspaceId` ... in a token are ignored.
* **No ambiguity:** only tokens issued by `https://accounts.google.com` **for this client id** pass. A Google ID token for any other client fails the audience check.
* Refresh tokens are not requested; an expired session is recovered by signing in again (Google's own session usually makes that one click).

## Configuration

Backend (`backend/.env.google`, git-ignored, **contains the secret**; start with `npm run dev:google` in `backend/`):

| Variable | Value |
|---|---|
| `AUTH_PROVIDER` | `oidc` |
| `OIDC_ISSUER` | `https://accounts.google.com` |
| `OIDC_AUDIENCE` | the OAuth client id |
| `OIDC_EXCHANGE_CLIENT_ID` | the OAuth client id (must be listed in `OIDC_AUDIENCE`) |
| `OIDC_EXCHANGE_CLIENT_SECRET` | the client secret (**server only**; a secret store in production) |
| `OIDC_EXCHANGE_REDIRECT_URIS` | `http://localhost:5175/` (https in production) |
| `CLIENT_URL` / `PORT` | `http://localhost:5175` / `5001` (so it runs beside the normal backend on 5000) |

Frontend (`frontend/.env.google`, git-ignored, **public values only**; start with `npm run dev:google` in `frontend/`, then open http://localhost:5175):
`VITE_API_BASE_URL`, `VITE_OIDC_AUTHORITY`, `VITE_OIDC_CLIENT_ID`, `VITE_OIDC_REDIRECT_URI`, `VITE_OIDC_SCOPE=openid profile email`, `VITE_OIDC_TOKEN_EXCHANGE_URL`,
`VITE_OIDC_PROVIDER_LABEL=Google`, `VITE_OIDC_AUTO_REDIRECT=false`. There is no variable for a secret, by design.

The normal `backend/.env`, its database and `npm run dev` are untouched: the Google profile is an opt-in launcher. The two profiles never share a port:

| Profile | Frontend | Backend | Sign-in |
|---|---|---|---|
| Normal development (`npm run dev`, the app's start configuration) | 5174 | 5000 | **not configured** - no Sign in / Sign out exists here (a development-only notice says so) |
| Google (`npm run dev:google` in both) | 5175 | 5001 | Continue with Google |

`npm run dev:google` in `backend/` first checks that `frontend/.env.google` agrees with `backend/.env.google` (same issuer / client id / redirect URI / CORS origin, and a frontend API
base that points at THIS backend's port) and refuses to start with a list of problems if not.

## Account creation and access (Phase 45C)

EOI has no passwords of its own. "Create account" and "Sign in" both go through Google; what EOI adds is **authorization**, which stays on the server and separate from identity.

```
Google account (created and managed by Google)
  -> Google authentication  -> verified ID token (issuer, audience, signature, exp/iat)
  -> EOI identity (issuer + subject)           [identity only - email is an attribute, never the key]
  -> GET /api/auth/session  (read-only; creates nothing)
       member            -> workspace membership(s) -> role -> permissions -> the app
       needs_setup       -> (KOI_SELF_REGISTRATION=true) the short onboarding: name your workspace
       access_restricted -> (default) "your organization requires an administrator to grant you access"
       disabled          -> "Account unavailable"
```

**New person, self-service ON** (`KOI_SELF_REGISTRATION=true`): Google sign-in -> "Welcome to EOI" -> they name a workspace -> `POST /api/auth/register` creates their EOI User, ONE new workspace
and an `admin` membership **in that new workspace only**. They never receive access to any workspace that already exists, and the browser sends only the workspace name - identity, role
and workspace are decided by the server. **Existing person** (added by an administrator): straight in with the role they were given. **Self-service OFF** (the default): a new person is told
an administrator must grant access, and nothing is created.

`scripts/provision-user.mjs` is an **operator / deployment / testing tool** (e.g. adding a colleague to an existing workspace with a chosen role). It is **not required** for normal users and
is **not part of** the normal sign-up journey.

## Sign-in screens (Phase 45D)

One entry point, no second sign-up screen: EOI has no passwords, so "create an account" is simply the first Google sign-in followed by the short workspace setup.

* Signed out: "Welcome to EOI" with **Continue with Google** and the hint "New to EOI? Continue with Google and we'll help you set up your workspace."
  While the browser is being sent to Google the button is disabled and "Taking you to Google..." is shown; while the page is coming back and the code is exchanged, "Signing you in..." is shown.
* After sign-in a short "Loading your account..." screen runs the account step above. A **new** person sees "Welcome to EOI - Workspace name"; an **existing** one goes straight to the application
  (the page they asked for is restored). Plain wording only - no codes, identifiers or provider terms - and **Sign out** is always available.
* A session that ends while the app is open replaces the app with "Session expired - Your session has expired. Please sign in again to continue." and **Sign in again**; signing in returns to the same page.
* Fixed friendly states: cancelled at Google ("Sign-in was cancelled. You can try again whenever you're ready."), could not complete ("We couldn't complete sign-in. Please try again."), no connection
  ("We couldn't reach EOI. Check your connection and try again."), and an unavailable account ("Your EOI account is currently unavailable. Please contact your administrator.").
* A **reload** of a tab that was signed in restores the session (one redirect to Google, silent while Google still has its session) and returns to the same page; a **new tab** (fresh visit) and a tab
  that signed out show the welcome / signed-out screen. This uses a non-credential `sessionStorage` marker (`koi.oidc.session`, value `1`) that is consumed whenever a sign-in starts, so a failing restore cannot repeat on its own.
* Sign-in after sign-out asks Google for its account chooser (`prompt=select_account`), so another account can be used.

## Sign out

Application-side only: the in-memory token is cleared and the app returns to the signed-out screen; a reload stays signed out. Google's own session is **not** ended
(Google exposes no end-session endpoint), so signing in again is usually immediate.

## Not verified here

A real person signing in with their own Google account in a browser. Everything up to Google's sign-in page and the server-side exchange against Google's real token endpoint
was exercised (see `scripts/validate-phase45b4-google-oidc.mjs`, section F); the consent screen, account selection and the first real ID token were not.
If the OAuth consent screen is in "Testing" mode, the signing-in account must be listed as a test user in the Google Cloud console.
