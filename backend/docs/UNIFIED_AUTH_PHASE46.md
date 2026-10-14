# Unified authentication (Phase 46): email + password AND Google, one EOI session

Scope: how a person proves who they are (a password, or Google) and how that becomes ONE EOI user with ONE session. Authorization is unchanged: it is the user's workspace
**membership** plus the server-side role map (`auth/roles.js`), decided on every request from the database. Nothing a browser sends, and nothing inside a token, can name a user
id, workspace, role or permission.

## 1. Before this phase

Google was the only way in. The browser held **Google's ID token** in memory and sent it as the API bearer (about an hour, no refresh, no revocation); EOI found the user by the
token's `iss` + `sub`. That cannot be shared with password users (they have no provider token), cannot be revoked on logout, and cannot be renewed. Compatibility modes
`AUTH_PROVIDER=oidc` (provider token as bearer) and `stub` (development) are unchanged and still used by the existing test suites.

## 2. The unified design (`AUTH_PROVIDER=eoi`)

```
 email + password --verify (scrypt)-->\
                                       >--> EOI user --> EOI SESSION (access token + refresh cookie) --> every API request
 Google --code exchange + ID-token ---/       (membership -> role -> permissions, from the database)
          verification (unchanged)
```

| Piece | Design |
|---|---|
| **Access token** | JWT, **HS256**, `typ: at+jwt`, `iss: eoi`, `aud: eoi-api`, `sub` = EOI user id, `sid` = session id, `jti`, `iat`, `exp` (**10 min**). Nothing else: no email, role, permission or workspace. Held by the page **in memory only**. Signed with a key derived from `KOI_SESSION_SECRET`. |
| **Refresh credential** | An opaque random value `<session id>.<32 random bytes>` in the **HttpOnly** cookie `koi_rt` (`Path=/api/auth`, `SameSite=Lax` by default, `Secure` in production). The page cannot read it. It is **never** in `localStorage`, `sessionStorage`, React state, a URL or a response body. |
| **Server-side session** | `AuthSession`: only SHA-256 **hashes** of the current and previous refresh secret, the user id, method (`password` / `google`), absolute expiry (14 days), revocation. Its id is the token's `sid`, so revoking it makes every access token of that browser fail at the **next request** (one indexed read). |
| **Rotation + theft detection** | Each refresh issues a new access token **and a new refresh secret** (atomic; only the request presenting the current secret wins). The previous secret is accepted for **10 s** for an access token only (two tabs refreshing at once). Presented later, it revokes the whole session (`reuse_detected`). |
| **CSRF** | The cookie authenticates only `POST /refresh` and `POST /logout`. They require a custom header (`X-KOI-Request: 1`, which a cross-site page cannot add without passing CORS, which allows only `CLIENT_URL`) and, when the browser sends an `Origin`, that it equals `CLIENT_URL`. `SameSite` is a third layer. |
| **Logout** | Server revokes the session and clears the cookie; the page forgets the token at once. Google's own session is untouched, so the next Google sign-in asks for its **account chooser** (`prompt=select_account`) - EOI never silently re-signs-in. |
| **Expiry** | The page renews the access token silently (single flight, one retry of the failed request). If the session cannot be renewed it ends: **"Session expired - Your session has expired. Please sign in again to continue."** No loop, no blank page. |
| **Google bearer** | Under `eoi` a provider token is **never** accepted as an API bearer; Google's ID token is verified (issuer, audience, signature, algorithm, exp, iat, sub - the existing verifier) **only** inside the code exchange and then converted into the EOI session. PKCE, `state`, the server-held client secret and the exact redirect-URI allow-list are unchanged. |

## 3. Data model

* `User` - one record per person. `issuer` + `subject` (unique) remain the identity key: for a Google-created or operator-provisioned user they are the provider's; for an email + password account EOI itself vouches (`issuer = eoi:account`, `subject` = the user's own id). New: `name`, `emailNormalized`, `emailVerified`, `passwordHash` (**`select: false`**), `passwordChangedAt`. A unique **partial** index allows one **password** account per normalised address; a Google-created user does not occupy the address. No role or workspace on the user.
* `AuthIdentity` - an **additional** Google identity linked to an existing account (`issuer` + `subject` unique). Google-created users keep their identity on the user itself.
* `AuthSession` - the refresh session (hashes only, TTL purge a week after expiry). `AuthToken` - single-use email tokens (hash only, TTL).
* **No data migration.** Existing users are untouched; the new indexes are created by the application on first start (Mongoose `autoIndex`); the index inventory in `PRODUCTION_ENVIRONMENT_CONTRACT.md` was regenerated (84 indexes). Users created before `emailNormalized` existed are matched by their `email` attribute where an address is compared.

## 4. Passwords

scrypt (Node `crypto`, no dependency): **N = 2^16, r = 8, p = 1**, 16-byte random salt, 32-byte key, constant-time comparison, cost stored with each hash so it can be raised (`needsRehash`; rewritten on the next successful sign-in). Argon2id is not in Node 20 and a native dependency was not warranted; scrypt is OWASP-acceptable with this memory cost. Production never goes below 2^15. A password is Unicode-normalised (NFKC), 10-128 characters, not a common password or a common word with digits ("password12345", "P@ssw0rd2024!"), not a keyboard run, not containing the email's local part. The hash is never returned, logged or placed in an error. An unknown address costs the same time as a known one (dummy verification).

## 5. Email verification and password reset (Nodemailer SMTP, Phase 46.1)

* **Sign-up** creates the account **unverified** and sends a one-time link (24 h). The person **cannot sign in until it is opened.** The right password on an unverified account gets a plain "please verify your email" (they proved the password) and nothing else.
* **Forgot password** always answers the same generic sentence; a real address gets a single-use 30-minute link, an unknown one nothing. Resetting revokes **every** session of the account and also proves the address (it was delivered there). A Google-created user may add a password this way.
* Tokens: 32 random bytes, only SHA-256 stored, single use (atomic), expiring, never logged, never carry an internal id. A weak new password does **not** use the link up.
* **Email transport (Phase 46.1).** `passwordAuthService -> emailService.sendEmail -> Nodemailer SMTP transport -> SMTP server -> recipient`. Only `services/emailService.js` knows Nodemailer; configuration is `SMTP_HOST/PORT/SECURE/USER/PASSWORD` + `MAIL_FROM` (`config/emailConfig.js`, documented in `PRODUCTION_ENVIRONMENT_CONTRACT.md`). Port 587 = mandatory STARTTLS (no plaintext fallback), 465 = implicit TLS, certificates are always verified (no override exists). The messages ("Verify your EOI account", "Reset your EOI password") are built in `services/emailTemplates.js` and the link base is `CLIENT_URL` only. For development/test, `KOI_EMAIL_TRANSPORT=outbox` writes the links to the git-ignored `backend/.dev-outbox/outbox.jsonl` (`node scripts/dev-outbox.mjs`); it is refused in production and in an unknown `NODE_ENV` and is never a fallback.
* **Fail closed.** With `AUTH_PROVIDER=eoi` outside an explicit development/test environment the server refuses to start without a complete SMTP configuration and an https, non-localhost `CLIENT_URL`. With no transport (development) sign-up, forgot-password and resend answer **503** for every address (a global condition: it reveals nothing) and create nothing.
* **Delivery failure.** Sign-up whose verification email is not accepted by the transport is **rolled back** (the unverified user and its token are deleted; 503 `EMAIL_DELIVERY_FAILED`; an existing address gets the identical 503, so an outage reveals nothing). For forgot-password / resend a per-message failure deletes the new token, leaves any earlier link valid, logs only an error class, and still returns the generic "accepted" (a different answer for existing accounts would reveal them). Whether a message was *delivered to the inbox* is, as with any SMTP hand-off, not knowable: "accepted by the server" is the strongest claim.

## 6. Google and account linking (the exact behaviour)

An unknown Google identity is resolved in this order; **the email is never the identity key**:

1. A linked `AuthIdentity`, or a user whose own `issuer` + `subject` match -> that user.
2. Google says the email is verified (`email_verified`) and a **password account** already uses it:
   * its email is **verified** -> **link required**: no session, no user created. The browser gets a short-lived signed **link ticket** (proves only "this browser completed that Google sign-in"). The person must enter that account's **password once**; only then is Google linked to the **same** account (one user, never two). Wrong password, forged/expired ticket, a different ticket type: one generic refusal.
   * its email was **never verified** -> the unproven password is **removed** and the Google identity becomes the account's way in (defeats pre-registering someone else's address).
3. Google's email unverified or absent -> never matched to anything.
4. Otherwise a **new** person: with `KOI_SELF_REGISTRATION=true` a user is created and they set up their **own** workspace as its admin next; with it off nothing is created and "an administrator must grant access" is shown. Joining an existing workspace is never self-service.

## 7. Rate limiting (server-side, before any work)

Public auth endpoints are limited per client address and, once the body is parsed, per **hashed** email (default window 15 min): sign-in 8/email + 40/address, sign-up 10/address, forgot/resend 5/email + 20/address, verify/reset 30/address, refresh/logout 120/address; the Google exchange keeps its own limit. A 429 reveals nothing about the account. The store is process-local, like the other limiters: one backend instance is the supported topology (`PRODUCTION_ENVIRONMENT_CONTRACT.md`).

## 7b. Phase 46.2 acceptance notes and known limitations

* Verified end to end in a browser on a throwaway database (SMTP -> a LOCAL capture server, the real Google test profile): sign-up, verification (once), password sign-in, forgot / reset (once, old sessions revoked), password -> Google linking, Google login, logout, deep-link restore, access-token expiry with silent renewal, revoked-session "Session expired", rate-limit message, SMTP outage, 375 / 768 / 1280 px, keyboard and ARIA.
* **One fix:** a 429 or 5xx answer to the *start-up* restore refresh now shows the retryable "couldn't reach EOI" screen instead of signing the person out (a rate-limited or failing server says nothing about the session). The in-use renewal path still ends the page's session on ANY failed renewal (including a transient one); the server session stays valid and a reload restores it.
* The anonymous per-address limiter (60 requests / minute, applied before the auth-specific limits) and the reset-password limiter shares its per-address bucket with forgot-password. All limiters are process-local.
* The PKCE `state` + verifier of an in-flight Google redirect are kept in `sessionStorage` for the length of the redirect (not a session credential; removed when the callback is handled). No access token, refresh token, password or one-time token is ever stored by the page.
* Logout is EOI-only. It does not end the Google session.

## 8. Remaining production dependencies (not done by this phase)

1. **A real SMTP account** configured and exercised against a real recipient (Phase 46.1 implemented and tested the transport against a local SMTP-protocol server only). 2. **HTTPS** end to end (`KOI_COOKIE_SECURE` is mandatory in production) and a decision on frontend/API **sites**: same site -> `SameSite=Lax`; different sites -> `KOI_COOKIE_SAMESITE=none` with `CLIENT_URL` exact. 3. `KOI_SESSION_SECRET` in a secret manager. 4. A shared rate-limit store if more than one backend instance is ever run. 5. Breached-password screening and account lockout notifications are not implemented (the policy is a short deny-list plus length; the throttle is per address/email).
