# Production environment contract (Phase 38)

What a production deployment of EOI/KOI must configure, classified, with **no values** (no secret appears in this document or in the repository).
Derived from what the code actually reads: `backend/src`, `backend/server.js`, `backend/app.js`, `ai-service/app/config.py`, `frontend/src`.
`validate-phase38-deployment-readiness.mjs` fails if the code reads a variable this contract does not name.

**Classes.** `REQUIRED` - must be set for production. `OPTIONAL` - may be set. `SAFE DEFAULT` - the built-in default is production-safe; set only to tune.
`FORBIDDEN IN PRODUCTION` - must be unset (the code refuses it, ignores it with a warning, or it is development/evaluation tooling).
"Enforced" says what the code does about a bad value (fail closed at startup unless stated).

## 1. Backend (Node / Express) - one instance only

| Setting | Class | Enforced by the code |
|---|---|---|
| `NODE_ENV` | REQUIRED = `production` | unset/unknown is treated like production for dev features, never as development; stub auth, dev knowledge level and error details are refused |
| `PORT` | SAFE DEFAULT (5000) | - |
| `CLIENT_URL` | REQUIRED (the real frontend origin) | the default is the local dev origin (`http://localhost:5173`): CORS would allow the wrong origin if left unset (a deployment checklist item, and a preflight FAIL). **Release hardening: it must be an EXACT ORIGIN** (`scheme://host[:port]`: no trailing slash, path, query, fragment, credentials, upper-case host or default port, no surrounding whitespace). The API returns the value as `Access-Control-Allow-Origin`, and a browser's `Origin` never has a trailing slash, so `https://app.example.com/` used to pass start-up and then fail every browser request. Production and an unset/unknown `NODE_ENV` now REFUSE TO START on an inexact value (development/test: a warning); the preflight FAILs it. HTTPS and non-localhost remain separate requirements (e-mail links) |
| `MONGODB_URI` | REQUIRED | missing -> refuses to start; **no database name -> refuses to start** (would silently use the `test` database); no credentials / no TLS -> startup warning (a private network may provide them) |
| `AUTH_PROVIDER` | REQUIRED = `eoi` (unified email + password and Google sessions, Phase 46) or `oidc` (compatibility: the provider token is the bearer) | production without a valid configuration, or with `stub`, refuses to start |
| `OIDC_ISSUER` | REQUIRED | https only, no query/fragment; mismatch with a token's `iss` is rejected |
| `OIDC_AUDIENCE` | REQUIRED | one value or comma list; a token must name one |
| `OIDC_JWKS_URI` | OPTIONAL | default: discovered from the issuer (discovery document must name the same issuer) |
| `OIDC_ALGORITHMS` | SAFE DEFAULT (`RS256,ES256`) | HS*, `none` and unknown algorithms refuse to start |
| `OIDC_CLOCK_TOLERANCE_SECONDS` | SAFE DEFAULT (60) | range-checked (0-300); `exp` is enforced strictly regardless |
| `OIDC_REQUIRED_TYP` | OPTIONAL | if set, the token header `typ` must equal it |
| `OIDC_JWKS_COOLDOWN_MS`, `OIDC_JWKS_CACHE_MAX_AGE_MS`, `OIDC_HTTP_TIMEOUT_MS` | SAFE DEFAULT | range-checked |
| `OIDC_EXCHANGE_CLIENT_ID`, `OIDC_EXCHANGE_CLIENT_SECRET`, `OIDC_EXCHANGE_REDIRECT_URIS` | OPTIONAL (all three or none) | Phase 45B.4: the server-side authorization-code exchange for a provider that requires a client secret at its token endpoint (Google 'Web application' client). `OIDC_EXCHANGE_CLIENT_ID` must be one of `OIDC_AUDIENCE`; the secret is **server side only** (a secret store in production; never a `VITE_*` variable, never logged); the redirect URIs are exact. Partly configured -> production refuses to start. Unset -> the endpoint answers 503 and the public-client flow is unchanged |
| `KOI_SELF_REGISTRATION` | OPTIONAL (default off) | Phase 45C: `true` lets a verified identity with no EOI account set up its OWN account (a new workspace named by the person + an admin membership in that workspace only). It never grants access to an existing workspace. Off = an administrator must grant access to any workspace. A deployment decision: enabling it lets any person who can authenticate create a tenant (and use its model budget), so enable it only where that is intended |
| `KOI_SESSION_SECRET` | REQUIRED with `AUTH_PROVIDER=eoi` (>= 32 characters, high entropy) | Phase 46: signs EOI access tokens (HS256) and Google link tickets with two separate derived keys. Never logged, returned or placed in a `VITE_*` variable. Rotating it signs everyone out (refresh sessions are server-side and survive, so people recover silently). A secret-manager value, not a file in the repository. |
| `KOI_ACCESS_TOKEN_TTL_SECONDS`, `KOI_REFRESH_TTL_DAYS` | SAFE DEFAULT (600 s; 14 days) | Phase 46: the access token's lifetime (60-3600 s) and the absolute lifetime of a refresh session (1-90 days); range-checked |
| `KOI_COOKIE_SAMESITE`, `KOI_COOKIE_SECURE` | SAFE DEFAULT (`lax`; secure in production) | Phase 46: attributes of the HttpOnly refresh cookie `koi_rt` (Path `/api/auth`). Production refuses `KOI_COOKIE_SECURE=false`; `KOI_COOKIE_SAMESITE=none` (frontend and API on different SITES) requires secure cookies. **Deployment checklist: serve both over HTTPS; with different sites use `none` + `CLIENT_URL` exact.** |
| `KOI_PASSWORD_SCRYPT_LOG_N` | SAFE DEFAULT (16 = N 2^16, 64 MiB per hash) | Phase 46: the scrypt cost. Honoured below 15 in development/test only (fast test suites); production never goes below 15 |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` | REQUIRED with `AUTH_PROVIDER=eoi` in production (the server REFUSES TO START without a complete, valid set) | Phase 46.1: email verification and password-reset mail is sent by **Nodemailer over SMTP** (`services/emailService.js` is the only module that knows it). `SMTP_PORT` default 587: 587 = STARTTLS (the upgrade is mandatory, never a silent plaintext fallback); 465 = implicit TLS (also set `SMTP_SECURE=true`). **Server certificates are always verified: there is no setting that disables it.** `SMTP_USER`/`SMTP_PASSWORD` both or neither. `SMTP_PASSWORD` is a **secret**: a secret-manager value, server side only, never a `VITE_*` variable, never logged or returned. `MAIL_FROM` is `address@host` or `Name <address@host>`. `CLIENT_URL` is the base of every email link: in production it must be the public **https** frontend URL (a non-https or localhost value refuses to start). Without a transport (development) sign-up, forgot-password and resend answer 503 and nothing is created |
| `RESEND_API_KEY` | REQUIRED with `KOI_EMAIL_TRANSPORT=resend` (the alternative to SMTP; the server REFUSES TO START with `AUTH_PROVIDER=eoi` in production unless SMTP **or** Resend is completely configured) | Email over Resend's HTTPS API (port 443), for hosts that block outbound SMTP such as Render Free. A **secret**: a secret-manager value, server side only, never a `VITE_*` variable, never logged or returned (a failed send logs only an allow-listed class, the HTTP status and a redacted short detail with no address, URL or key). Must start with `re_`. `MAIL_FROM` (above) must be an address on a domain verified in Resend. The `SMTP_*` variables are not read in this mode and are not needed. |
| `SMTP_SECURE`, `KOI_EMAIL_TRANSPORT` | SAFE DEFAULT (`SMTP_SECURE` true on port 465, else false; transport `smtp` when `SMTP_HOST` is set; `resend` only when `KOI_EMAIL_TRANSPORT=resend`) | Phase 46.1: explicit TLS mode and transport selection. `KOI_EMAIL_TRANSPORT` accepts `smtp`, `resend` or `outbox` only |
| `SMTP_REQUIRE_TLS`, `KOI_EMAIL_OUTBOX_FILE` | DEVELOPMENT/TEST ONLY | Phase 46.1: `SMTP_REQUIRE_TLS=false` allows a plaintext connection to a LOCAL capture server; `KOI_EMAIL_TRANSPORT=outbox` (with `KOI_EMAIL_OUTBOX_FILE`) writes one-time links to a git-ignored file instead of sending. Both are **refused in production and in an unset/unknown `NODE_ENV`** (the outbox is never a fallback for a missing SMTP configuration) |
| `KOI_AUTH_RATE_WINDOW_MS`, `KOI_AUTH_SIGNIN_EMAIL_MAX`, `KOI_AUTH_SIGNIN_IP_MAX`, `KOI_AUTH_SIGNUP_IP_MAX`, `KOI_AUTH_RESET_EMAIL_MAX`, `KOI_AUTH_RESET_IP_MAX`, `KOI_AUTH_VERIFY_IP_MAX`, `KOI_AUTH_REFRESH_IP_MAX` | SAFE DEFAULT (15 min window; 8 / 40 / 10 / 5 / 20 / 30 / 120) | Phase 46: limits on the public authentication endpoints, per client address and per hashed email. Process-local like the other limiters (one backend instance); switched off only by `KOI_RATE_LIMIT_ENABLED=false` |
| `AUTH_TOKEN_VERIFIER`, `AUTH_STUB_SECRET` | FORBIDDEN IN PRODUCTION | the stub verifier is refused outside an explicit development/test `NODE_ENV` |
| `KNOWLEDGE_DEV_AUTHORIZED_LEVEL` | FORBIDDEN IN PRODUCTION | ignored with a warning outside development/test; the level comes only from the membership role |
| `LLM_PROVIDER` | REQUIRED = `gemini` | `test`/`test-python` in production, or any non-empty unrecognised value (a typo), refuses to start; unset is a warning (analysis answers 503) |
| `KOI_NO_DOTENV_REASON`, `KOI_REQUIRE_LOOPBACK_DB`, `KOI_ALLOW_REMOTE_DB` | TEST HARNESS / LOCAL SCRIPTS ONLY - never set in a deployment | database safety (`src/config/mongoSafety.js`): `KOI_NO_DOTENV_REASON=validation` marks a validation process, which may open **loopback MongoDB only** (every host `localhost`, `127.0.0.1` or `::1`; also under `NODE_ENV=test`); `KOI_REQUIRE_LOOPBACK_DB` is set by dev / seed / provision scripts, which refuse a remote database unless run with `--allow-remote-db` (`KOI_ALLOW_REMOTE_DB=1`) on purpose |
| `KOI_NO_DOTENV` | TEST HARNESS ONLY - never set in a deployment | set automatically by validation suites (`scripts/validate-*.mjs`, `scripts/phaseNN/*`) so they and the servers they spawn never read the real `backend/.env` / `ai-service/.env`; the real server ignores nothing |
| `AI_SERVICE_TOKEN` | RECOMMENDED SECRET at runtime, **REQUIRED by the release preflight** for the Vercel -> Render -> private AI service topology (backend and AI service must hold the same value of at least 24 characters; absent = network isolation only: the runtime keeps a startup warning, the preflight FAILs) | Phase 51: sent by the backend as `X-KOI-Service-Token`; the AI service (same variable name) refuses every endpoint except `/v1/health` without it and stops publishing `/docs`, `/redoc` and `/openapi.json`. Never a `VITE_` value, never in the frontend build |
| `AI_SERVICE_URL` | REQUIRED (the AI service, private network) | gemini route: required, valid `http(s)` URL, no embedded credentials, else refuses to start |
| `OPENAI_API_KEY` | NOT USED on the gemini route - leave unset | only the optional OpenAI path reads it; analysis never uses it |
| Gemini model | not a Node setting | exact `gemini-3.1-flash-lite` is a **code constant**; there is no environment override |
| `KOI_ANALYSIS_RESPONSE_WINDOW_MS` | OPTIONAL (default: the shorter of 25000 and the request deadline) | Workstream 5A: how long ONE HTTP request waits for an analysis before it answers 202 "in progress" (the analysis attempt itself continues). Anchored to the browser's fixed 30 s wait, not to any Node setting; leave unset in production. 50-110000 |
| `KOI_AI_TIMEOUT_MS` | SAFE DEFAULT (20000) | the per-call timeout of retrieval / embedding calls to the AI service (Workstream 5C: it no longer sets the analysis wait); the retrieval budget (request deadline minus the analysis wait) must fit one such call, else refuses to start |
| `KOI_AI_ANALYSIS_TIMEOUT_MS` | OPTIONAL (default 65000 = the 60 s analysis ceiling + 5 s) | Workstream 5C: how long Node waits for the AI service's ANALYSIS call. Must **exceed 60000 ms** on the gemini route (the analysis ceiling; startup check) and fit inside the request deadline together with one retrieval call; independent of `KOI_AI_TIMEOUT_MS`. Leave unset in production. 50-120000 |
| `KOI_SOCKET_TIMEOUT_MS` | SAFE DEFAULT (120000) | the request deadline is this minus a margin (110 s by default); an analysis that cannot fit refuses to start |
| `KOI_REQUEST_TIMEOUT_MS`, `KOI_HEADERS_TIMEOUT_MS`, `KOI_KEEPALIVE_TIMEOUT_MS`, `KOI_TIMEOUT_CHECK_INTERVAL_MS` | SAFE DEFAULT | range-checked |
| `KOI_LEARNING_CONTEXT_ENABLED` | SAFE DEFAULT (off) - **must stay unset/false** | enabling is a startup warning and is recorded per attempt (`learningUsed`); enabling needs a separate approval |
| `KOI_RETRIEVAL_MIN_SIMILARITY` | SAFE DEFAULT (0.25) | below the default -> startup warning; `-1` (disabled) is a test-harness value: FORBIDDEN IN PRODUCTION |
| `KOI_ACTION_REVIEW_REQUIRES_SECOND_PERSON` | SAFE DEFAULT (unset = the proposer may confirm their own Action proposal while no role can execute one) | Phase 49: `true` requires a different user to review an Action proposal (never a request field; it can only make the rule stricter) |
| `KOI_RATE_LIMIT_ENABLED` | SAFE DEFAULT (true) | `false` in production -> startup warning |
| `KOI_RATE_LIMIT_WINDOW_MS`, `_ANON_MAX`, `_IP_MAX`, `_USER_MAX`, `_WRITE_MAX`, `_AI_MAX`, `_AI_WORKSPACE_MAX`, `_IMPORT_MAX`, `_MAX_KEYS` | SAFE DEFAULT / OPTIONAL tuning | **process-local**: per-instance counters (one more reason for one instance) |
| `KOI_TRUST_PROXY` | OPTIONAL | a hop count only behind a trusted proxy; otherwise `X-Forwarded-For` is ignored. **Release hardening:** unset, or a whole number 1-10; production and an unset/unknown `NODE_ENV` refuse to start on any other value (it used to be ignored silently, leaving every user on one rate-limit key); the preflight FAILs it. The exact hop count is only knowable on the real platform |
| `KOI_JSON_BODY_LIMIT_BYTES`, `KOI_IMPORT_MAX_ROWS`, `_COLUMNS`, `_FIELD_LENGTH`, `_RECORD_BYTES` | SAFE DEFAULT | range-checked |
| `KOI_EXPOSE_ERROR_DETAILS` | FORBIDDEN IN PRODUCTION | honoured only with an explicit development/test `NODE_ENV` |

## 2. AI service (Python / FastAPI) - may be restarted freely; Node is the only caller

| Setting | Class | Enforced by the code |
|---|---|---|
| `LLM_PROVIDER` | REQUIRED = `gemini` | exactly `test` or `gemini`, else refuses to start |
| `LLM_MODEL` | REQUIRED = exactly `gemini-3.1-flash-lite` (the default) | any other value (preview, alias, `latest`, other casing/whitespace) refuses to start; re-checked before every call |
| `GEMINI_API_KEY` | REQUIRED (secret; never in the repository) | blank with a Gemini provider -> refuses to start; the value is never printed |
| `REQUEST_TIMEOUT_MS` | REQUIRED <= 20000 (default 20000) | integer 1..20000, else refuses to start. Workstream 5C: it now bounds only the embedding and legacy generate calls (the analysis deadline is its own setting below) |
| `LLM_ANALYSIS_TIMEOUT_MS` | SAFE DEFAULT (see the 5C report; set explicitly only to change it) | Workstream 5C: the Gemini ANALYSIS deadline. Integer 1..60000 with a Gemini provider, else refuses to start; re-checked before every analysis call. Node's wait for it (`KOI_AI_ANALYSIS_TIMEOUT_MS`) always exceeds the 60 s ceiling, and the browser-facing response window (about 25 s) is independent of it |
| `LLM_MAX_OUTPUT_TOKENS` | SAFE DEFAULT (4096) | integer 1..8192 with a Gemini provider |
| `EMBEDDING_PROVIDER` | REQUIRED = `gemini` **for production knowledge retrieval** | `test` embeddings are hash-based and carry no meaning: FORBIDDEN IN PRODUCTION for a deployment that uses business knowledge. **Not enforced** (the AI service has no notion of production): a deployment checklist item. Each retrieval page makes one Gemini embedding call |
| `EMBEDDING_MODEL` | SAFE DEFAULT (`gemini-embedding-001`) | stored chunk vectors are only compared with the same model; changing it needs re-embedding |
| `EMBEDDING_BATCH_SIZE` | SAFE DEFAULT (20) | - |
| `SIMILARITY_MAX_CANDIDATES` | SAFE DEFAULT (200) | must equal the backend's retrieval page size (200); Python rejects a larger request |
| `AI_SERVICE_PORT` | OPTIONAL, **not used by the code** | the listening port is chosen on the `uvicorn` command line |
| `PHASE33_LOG_USAGE`, `P34C1_OBSERVER_LOG`, `P34C1_PORT` | FORBIDDEN IN PRODUCTION | evaluation tooling only |

## 3. Frontend (Vite build-time)

| Setting | Class | Note |
|---|---|---|
| `VITE_API_BASE_URL` | REQUIRED | the backend origin |
| `VITE_OIDC_AUTHORITY`, `VITE_OIDC_CLIENT_ID`, `VITE_OIDC_REDIRECT_URI`, `VITE_OIDC_AUDIENCE`, `VITE_OIDC_SCOPE` | REQUIRED for sign-in | Authorization Code + PKCE; unset -> no sign-in (development keeps its dev token). Not exercised against a real provider |
| `VITE_OIDC_TOKEN_EXCHANGE_URL`, `VITE_OIDC_PROVIDER_LABEL`, `VITE_OIDC_AUTO_REDIRECT` | OPTIONAL | Phase 45B.4, both PUBLIC: the backend endpoint that exchanges the authorization code for a provider requiring a client secret, and the provider's display name for the button ("Sign in with Google"). Neither is a credential; `VITE_OIDC_AUTO_REDIRECT=false` shows a 'Sign in' screen on a fresh visit instead of redirecting at once (default: redirect) |
| `VITE_KOI_WORKSPACE_ID` | DEVELOPMENT ONLY - leave unset in a production build with real sign-in (Phase 45C onward) | one workspace id baked into the build for development without sign-in. With real sign-in the active workspace is the signed-in person's own, reported by the server after sign-in; an id baked in here would be public and is not needed. Unset **and** no sign-in configured selects LOCAL mode (browser storage), which is not a production mode |
| `VITE_KOI_AUTH` | OPTIONAL (`eoi` enables the unified email + password and Google screens, Phase 46) | a public display switch only; the server decides everything |
| `VITE_DEV_ACCESS_TOKEN` | FORBIDDEN IN PRODUCTION | read only in a development build; empty in a production build |

## 4. MongoDB

* **Connection:** one `MONGODB_URI` naming the database; a dedicated least-privilege user (readWrite on that database only); TLS (`mongodb+srv://` or `tls=true`).
* **Topology:** the code works on a standalone server (the development setup) and on a replica set. Workspace deletion runs in one transaction **only on a replica set**; on a standalone server it is ordered, idempotent and resumable but not atomic (`WORKSPACE_LIFECYCLE_POLICY_PHASE22.md`).
* **Startup writes:** none. The application creates indexes (below) on first use; it runs no destructive migration (`dropDatabase`, `dropCollection`, `syncIndexes`, `deleteMany` are absent from startup code - tested).

### Index inventory (derived from the real models on a fresh isolated database; `scripts/phase38/index-inventory.mjs`)

| Model | Index (keys) | Unique / partial | Purpose | Tenant scoping | Deployment status |
|---|---|---|---|---|---|
| Workspace | `slug:1` | unique | one workspace per slug (stable, human-facing identifier) | tenant root | on first start |
| Workspace | `status:1` | - | filter by status | tenant root | on first start |
| Property | `workspaceId:1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| Property | `workspaceId:1, code:1` | unique | one property per code within a workspace | workspace-prefixed | on first start |
| Unit | `propertyId:1` | - | lookup by reference (propertyId) | parent-scoped (propertyId -> its workspace) | on first start |
| Unit | `propertyId:1, unitNumber:1` | unique | one unit number per property | parent-scoped (propertyId -> its workspace) | on first start |
| Guest | `workspaceId:1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| Guest | `workspaceId:1, externalId:1` | unique + partial | one guest per external (PMS) id within a workspace (partial: only when an external id exists) | workspace-prefixed | on first start |
| Guest | `workspaceId:1, email:1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| Guest | `workspaceId:1, lastName:1, firstName:1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| Stay | `workspaceId:1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| Stay | `guestId:1` | - | lookup by reference (guestId) | secondary key (the service layer always adds the workspace filter) | on first start |
| Stay | `propertyId:1` | - | lookup by reference (propertyId) | secondary key (the service layer always adds the workspace filter) | on first start |
| Stay | `unitId:1` | - | lookup by reference (unitId) | secondary key (the service layer always adds the workspace filter) | on first start |
| Stay | `workspaceId:1, reservationId:1` | unique + partial | one stay per reservation id within a workspace (partial) | workspace-prefixed | on first start |
| Stay | `workspaceId:1, checkIn:1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| Stay | `workspaceId:1, checkOut:1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| Stay | `workspaceId:1, status:1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| Signal | `propertyId:1` | - | lookup by reference (propertyId) | secondary key (the service layer always adds the workspace filter) | on first start |
| Signal | `unitId:1` | - | lookup by reference (unitId) | secondary key (the service layer always adds the workspace filter) | on first start |
| Signal | `guestId:1` | - | lookup by reference (guestId) | secondary key (the service layer always adds the workspace filter) | on first start |
| Signal | `stayId:1` | - | lookup by reference (stayId) | secondary key (the service layer always adds the workspace filter) | on first start |
| Signal | `workspaceId:1, createdAt:-1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| Signal | `workspaceId:1, severity:1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| Signal | `workspaceId:1, status:1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| Signal | `workspaceId:1, occurredAt:-1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| Conversation | `guestId:1` | - | lookup by reference (guestId) | secondary key (the service layer always adds the workspace filter) | on first start |
| Conversation | `stayId:1` | - | lookup by reference (stayId) | secondary key (the service layer always adds the workspace filter) | on first start |
| Conversation | `workspaceId:1, updatedAt:-1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| Conversation | `workspaceId:1, createdAt:-1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| Message | `conversationId:1, createdAt:1` | - | messages of a conversation, oldest first | parent-scoped (conversationId -> its workspace) | on first start |
| Action | `intelligenceId:1` | - | lookup by reference (intelligenceId) | secondary key (the service layer always adds the workspace filter) | on first start |
| Action | `decisionId:1` | - | lookup by reference (decisionId) | secondary key (the service layer always adds the workspace filter) | on first start |
| Action | `assignedTo:1` | - | filter by assignedTo | secondary key (the service layer always adds the workspace filter) | on first start |
| Action | `workspaceId:1, status:1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| Action | `workspaceId:1, decisionId:1, actionVersion:1` | unique + partial | at most one Action V1 per workspace + Decision (partial: V1 only) | workspace-prefixed | on first start |
| Intelligence | `conversationId:1` | - | lookup by reference (conversationId) | secondary key (the service layer always adds the workspace filter) | on first start |
| Intelligence | `propertyId:1` | - | lookup by reference (propertyId) | secondary key (the service layer always adds the workspace filter) | on first start |
| Intelligence | `guestId:1` | - | lookup by reference (guestId) | secondary key (the service layer always adds the workspace filter) | on first start |
| Intelligence | `stayId:1` | - | lookup by reference (stayId) | secondary key (the service layer always adds the workspace filter) | on first start |
| Intelligence | `workspaceId:1, createdAt:-1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| Intelligence | `signalIds:1` | - | filter by signalIds | secondary key (the service layer always adds the workspace filter) | on first start |
| Intelligence | `workspaceId:1, signalIds:1, analysisLevel:1` | unique + partial | IDEMPOTENCY of analysis: at most one V1 analysis per workspace + Signal + level (partial: V1 only) - the multi-instance correctness backstop | workspace-prefixed | on first start |
| Decision | `workspaceId:1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| Decision | `intelligenceId:1` | - | lookup by reference (intelligenceId) | secondary key (the service layer always adds the workspace filter) | on first start |
| Decision | `workspaceId:1, signalId:1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| Decision | `workspaceId:1, status:1, priority:1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| Decision | `workspaceId:1, intelligenceId:1, decisionVersion:1` | unique + partial | at most one Decision V1 per workspace + Intelligence (partial: V1 only) | workspace-prefixed | on first start |
| Outcome | `intelligenceId:1` | - | lookup by reference (intelligenceId) | secondary key (the service layer always adds the workspace filter) | on first start |
| Outcome | `actionId:1` | - | lookup by reference (actionId) | secondary key (the service layer always adds the workspace filter) | on first start |
| Outcome | `status:1` | - | filter by status | secondary key (the service layer always adds the workspace filter) | on first start |
| Outcome | `workspaceId:1, occurredAt:-1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| Outcome | `workspaceId:1, actionId:1, outcomeVersion:1` | unique + partial | at most one Outcome V1 per workspace + Action (partial: V1 only) | workspace-prefixed | on first start |
| KnowledgeDocument | `workspaceId:1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| KnowledgeDocument | `propertyId:1` | - | lookup by reference (propertyId) | secondary key (the service layer always adds the workspace filter) | on first start |
| KnowledgeDocument | `unitId:1` | - | lookup by reference (unitId) | secondary key (the service layer always adds the workspace filter) | on first start |
| KnowledgeDocument | `workspaceId:1, propertyId:1, status:1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| KnowledgeDocument | `workspaceId:1, createdAt:-1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| KnowledgeDocument | `workspaceId:1, propertyId:1, unitId:1, contentHash:1` | unique + partial | no duplicate knowledge document content within a scope (partial) | workspace-prefixed | on first start |
| KnowledgeChunk | `documentId:1` | - | lookup by reference (documentId) | secondary key (the service layer always adds the workspace filter) | on first start |
| KnowledgeChunk | `workspaceId:1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| KnowledgeChunk | `propertyId:1` | - | lookup by reference (propertyId) | secondary key (the service layer always adds the workspace filter) | on first start |
| KnowledgeChunk | `unitId:1` | - | lookup by reference (unitId) | secondary key (the service layer always adds the workspace filter) | on first start |
| KnowledgeChunk | `documentId:1, version:1, chunkIndex:1` | unique | one chunk per document version + position | secondary key (the service layer always adds the workspace filter) | on first start |
| KnowledgeChunk | `workspaceId:1, propertyId:1, status:1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| ImportBatch | `workspaceId:1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| ImportBatch | `propertyId:1` | - | lookup by reference (propertyId) | secondary key (the service layer always adds the workspace filter) | on first start |
| ImportBatch | `workspaceId:1, createdAt:-1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| ImportBatch | `workspaceId:1, propertyId:1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| User | `issuer:1, subject:1` | unique | one User per identity-provider issuer + subject (an identity is never matched by e-mail) | global identity / authentication (never tenant data) | on first start |
| User | `emailNormalized:1` | unique + partial | one PASSWORD account per normalised email address (partial: only users that have a password hash); a provider-created user does not occupy the address | global identity / authentication (never tenant data) | on first start |
| WorkspaceMembership | `workspaceId:1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| WorkspaceMembership | `userId:1, workspaceId:1` | unique | one membership per user + workspace | secondary key (the service layer always adds the workspace filter) | on first start |
| AnalysisAdmission | `workspaceId:1, createdAt:-1` | - | audit listing by workspace (newest first) / by Signal | workspace-prefixed | on first start |
| AnalysisAdmission | `workspaceId:1, signalId:1, createdAt:-1` | - | audit listing by workspace (newest first) / by Signal | workspace-prefixed | on first start |
| AnalysisAdmission | `workspaceId:1, attemptId:1` | unique | one audit row per analysis attempt within a workspace | workspace-prefixed | on first start |
| AnalysisAdmission | `workspaceId:1, requestId:1` | partial | find the audit row from the X-Request-Id a client reported (partial: rows that have one) | workspace-prefixed | on first start |
| AnalysisAttempt | `workspaceId:1, signalId:1, analysisLevel:1` | unique + partial | at most ONE in-flight analysis attempt per workspace + Signal + level (partial: status in_progress) - the cross-process single-flight | workspace-prefixed | on first start |
| AnalysisAttempt | `workspaceId:1, signalId:1, analysisLevel:1, startedAt:-1` | - | workspace-scoped list / filter / sort | workspace-prefixed | on first start |
| AnalysisAttempt | `workspaceId:1, attemptId:1` | unique | one attempt marker per attempt id within a workspace | workspace-prefixed | on first start |
| AuthIdentity | `userId:1` | - | lookup by reference (userId) | global identity / authentication (never tenant data) | on first start |
| AuthIdentity | `issuer:1, subject:1` | unique | one EOI link per external-provider identity (a Google account belongs to at most one EOI user) | global identity / authentication (never tenant data) | on first start |
| AuthSession | `userId:1` | - | lookup by reference (userId) | global identity / authentication (never tenant data) | on first start |
| AuthSession | `purgeAt:1` | - | automatic removal of expired authentication records (TTL index) | global identity / authentication (never tenant data) | on first start |
| AuthToken | `userId:1` | - | lookup by reference (userId) | global identity / authentication (never tenant data) | on first start |
| AuthToken | `tokenHash:1` | unique | single-use email tokens (verification, reset) are looked up by the SHA-256 of the token; the token itself is never stored | global identity / authentication (never tenant data) | on first start |
| AuthToken | `expiresAt:1` | - | automatic removal of expired authentication records (TTL index) | global identity / authentication (never tenant data) | on first start |

94 indexes (18 primary keys), unclassified: 0

"Deployment status: on first start" means Mongoose builds the index when the application first uses the model against that database (no manual step, no data migration; the
only index added since Phase 34 is `AnalysisAdmission`, a new small collection). On a very large existing collection a *new* index build is the only potentially slow step; none
of the indexes above is new for an existing collection except the two additive `AnalysisAdmission` lookups on a collection that is empty at first deployment.
