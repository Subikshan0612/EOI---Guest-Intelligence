# EOI Guest Intelligence — architecture inventory

Companion to [`03-eoi-master-architecture.html`](03-eoi-master-architecture.html). Everything below was read from the repository source at commit
`7ad1d8d6a27faba838e40f87703b8e59996bb7c6` (branch `main`). Paths are repository-relative; `file:N-M` cites the lines that
support the statement. No environment values, secrets or tokens appear in this document; only environment-variable **names**.

Legend for "status": **live** = on the executed path; **API-only** = exists in the backend but no mounted UI calls it; **off** = disabled by default; **not wired** = code exists, nothing calls it.

---

## A. Users / clients

| Component | Technology | Responsibility | Source | Communicates with |
|---|---|---|---|---|
| Operators (browser) | Any modern browser | Hospitality / service-apartment staff. Four workspace roles: `viewer`, `operator`, `reviewer`, `admin`. | `backend/src/auth/roles.js:43-49` | React SPA over HTTPS |
| Email recipient | Mailbox | Receives verification / reset / "account exists" mail and opens the link in the SPA. | `backend/src/services/emailTemplates.js`, `backend/src/services/emailService.js:179` | SPA (`/verify-email`, `/reset-password`) |

## B. Frontend (Vercel)

| Component | Technology | Responsibility | Source | Communicates with |
|---|---|---|---|---|
| React SPA shell | React 19, Vite 6, react-router-dom 7, plain JavaScript | Bootstraps after sign-in state settles; `AuthGate` selects exactly one screen per journey state; mounts the app only when signed in **and** a workspace is chosen. Context + hooks, no state library. | `frontend/src/main.jsx:19-27`, `frontend/src/app/App.jsx:26-70`, `frontend/src/app/routes.jsx:15-33` | Auth UI, feature pages |
| Auth UI + session client | Authorization Code + PKCE (public client), `fetch` for credential endpoints | Sign in / sign up / forgot / reset / verify / link-Google / onboarding screens. Access token kept **in memory only**; refresh via HttpOnly cookie. | `frontend/src/services/auth/oidc/oidcSession.js:182`, `…/oidcFlow.js:26-44`, `frontend/src/services/auth/eoiAuthApi.js:30-40`, `frontend/src/services/auth/accessToken.js` | Google (authorize), Node `/api/auth/*` |
| Properties + Guests UI | React pages | Property → Unit management; Guest list/detail with Stay management. | `frontend/src/pages/PropertiesPage.jsx:9`, `GuestsPage.jsx:9`, `GuestDetailPage.jsx`, `frontend/src/features/operations/useGuests.js:13` | API client |
| AI Assistant UI | React page + hooks | Operator describes a situation → conversational intake → explicit "assess" request → case card (context, assessment, decision, action, outcome panels). Analysis starts only from a user action. | `frontend/src/pages/AssistantPage.jsx:22`, `frontend/src/features/assistant/useCaseGeneration.js:25`, `…/SignalCaseCard.jsx:36` | API client |
| API client | axios (the only axios instance) | Base URL from `VITE_API_BASE_URL`, 15 s timeout, Bearer interceptor, 401 → refresh once; maps errors to `ApiError`; endpoint table `koiEndpoints`. | `frontend/src/services/api.js:15-21`, `:23-70`, `:123-160` | Node `/api/*` |
| Landing / Settings | React pages | `/` shows greeting + recent conversations; `/settings` is a placeholder. | `frontend/src/pages/Home.jsx:9`, `frontend/src/pages/Settings.jsx` | — |

Not mounted (present in source, no route/import reaches them): Dashboard UI (`frontend/src/features/dashboard/*`), Learning UI (`frontend/src/features/learning/*`), `SignalForm`. `ConversationProvider` is defined but `App.jsx` does not mount it. **Status: not wired.**

## C. Backend (Render, Node.js)

Runtime: Node ≥20.17 <21, ESM, Express 5, Mongoose 8 (`backend/package.json`). Layering route → controller → service → model.

| Component | Technology | Responsibility | Source | Communicates with |
|---|---|---|---|---|
| Edge middleware | cors, in-house middleware | Exact-origin CORS (`CLIENT_URL`, credentials), `X-Request-Id`, security headers on every response (CSP `default-src 'none'`, nosniff, no-store, HSTS in production), per-IP anonymous/client limiters before any body parsing; `trust proxy` from `KOI_TRUST_PROXY`. | `backend/app.js:16-47`, `backend/src/middleware/securityHeaders.js:19-32`, `…/rateLimit.js:27`, `…/requestId.js:13` | Every route |
| Route registry | Express Router | 17 groups mounted under `/api`: health, workspaces, properties, units, guests, stays, signals, conversations, intelligence, decisions, actions, outcomes, knowledge-documents, learning, imports, dashboard, auth. | `backend/src/routes/index.js:20-38` | Controllers |
| Operational services | Mongoose services | CRUD for Property/Unit/Guest/Stay/Signal, CSV import (10 MB, memory), dashboard read model. | `backend/src/services/{property,unit,guest,stay,signal}Service.js`, `…/import/importService.js:208`, `…/dashboardService.js:195` | MongoDB (operational data) |
| Conversational intake | deterministic parser (no LLM) | One operator turn: extract location/type/severity **only from what was written**, verify against the workspace's own records, ask one clarifying question or create a Signal via `createSignal`. | `backend/src/services/signalIntakeService.js:71`, `…/signalInterpreter.js:167`, `…/signalService.js:90`, `backend/src/routes/conversationRoutes.js` | MongoDB (Signal, Conversation, Message) |
| Decision lifecycle | Mongoose services | Propose/approve/reject Decision (from an Intelligence), propose/approve/reject Action (from a Decision), record Outcome. **No execution path**: `action:execute` is held by no role. | `backend/src/services/decisionService.js:181,399`, `…/actionService.js:372,488`, `…/outcomeService.js:265`, `backend/src/auth/roles.js:26-49` | MongoDB (Decision, Action, Outcome) |
| Analysis orchestrator | Node service | `POST /api/intelligence/analyze/:signalId`: single-flight per (workspace, signal, level), durable `AnalysisAttempt` marker, response window then **202 in-progress**, idempotent (returns stored analysis, no model call). | `backend/src/services/intelligenceAnalysisService.js:152-188,252-340`, `…/analysisAttemptService.js:59`, `backend/src/controllers/intelligenceController.js:35-37` | Context, knowledge, AI client, MongoDB |
| Operational context | Node service | Builds the bounded, allow-listed context the model may see (signal, guest minus contact details, stay, property, unit, related signals, ≤3 historical analyses/decisions); no write. | `backend/src/services/operationalContextService.js:44-80` | MongoDB (read) |
| Knowledge service | multer, pdf-parse, mammoth, Node services | **Ingest**: upload (10 MB, memory only) → extract PDF/DOCX/text → chunk → embed via AI service → store. **Retrieve**: scoped MongoDB candidate query (workspace, status, visibility ceiling, property/unit scope, effective window, has embedding; ≤2000 candidates, 200/page) → AI service scoring → Node re-verifies, relevance floor, top-5. | `backend/src/routes/knowledgeDocumentRoutes.js:20-30`, `…/knowledge/documentExtractor.js:313`, `…/knowledgeEmbeddingService.js:84`, `…/knowledgeRetrievalService.js:112,235`, `:44` | MongoDB (KnowledgeChunk), AI client |
| AI service client | `fetch` | The only caller of the Python service: `/v1/embeddings`, `/v1/knowledge-retrieval`, `/v1/intelligence/analyze`. Sends `X-KOI-Service-Token` and a validated `X-KOI-Request-Id`; timeouts → 504/502 `AppError`. | `backend/src/services/ai/aiServiceClient.js:25-60,78,92,113` | FastAPI AI service |
| Admission + store | Node service | Re-validates the AI response before anything is stored: strict schema, provider/model identity vs `providerPolicy`, claim/evidence rules, server safety policy, prose consistency, foreign-identifier guard, confidence ceiling; then `createAnalysisIntelligence` and an `AnalysisAdmission` audit row. | `backend/src/services/intelligenceAnalysisService.js:36-100,309-345`, `…/ai/{analysisSchema,claimValidator,safetyPolicy,confidencePolicy,outputGuard,proseConsistency}.js`, `backend/src/config/providerPolicy.js:27`, `backend/src/services/intelligenceService.js:161` | MongoDB (Intelligence, AnalysisAdmission) |
| Session + Google login | jose, scrypt (`node:crypto`) | Email+password sign-up/in, verification, reset, refresh rotation, Google code exchange and identity resolution (see D). | `backend/src/services/passwordAuthService.js:109-216`, `…/authSessionService.js:43-128`, `…/oidcExchangeService.js:29-125`, `…/googleLoginService.js:40`, `…/accountService.js:71-129` | Google, Email service, MongoDB |
| Email service | `resend` SDK; `nodemailer` | Transactional email behind one seam; transports: injected (tests), **Resend** (HTTPS), SMTP (Nodemailer), dev outbox; `sendEmail` never throws and logs only class/status/redacted detail. | `backend/src/services/emailService.js:137-215`, `backend/src/config/emailConfig.js:36-115`, `backend/src/services/emailTemplates.js` | Resend |
| Learning context | Node service | Outcome-derived aggregate added to the AI request **only when** `KOI_LEARNING_CONTEXT_ENABLED=true`. **Status: off by default.** Admin report routes exist (`/api/learning/*`) but no UI calls them. | `backend/src/config/runtimeConfig.js:224-226`, `backend/src/services/learningContextService.js:23`, `backend/src/routes/learningRoutes.js:11` | — |

Background/async processing: there is **no queue, worker or scheduler**. The only asynchronous behaviour is an analysis attempt that continues in-process after the HTTP response window closes (tracked by `AnalysisAttempt`; marked interrupted on graceful shutdown: `backend/server.js:157-165`).

## D. Authentication

| Item | Implementation | Source |
|---|---|---|
| Provider selection | `AUTH_PROVIDER` = `eoi` (unified session) \| `oidc` \| `stub` (dev/test only); production fails closed. | `backend/src/auth/authConfig.js:60,131` |
| EOI access token | HS256 JWT (`typ at+jwt`, `aud eoi-api`), claims `sub`,`sid`,`jti` only — no role/permission/email; key derived from `KOI_SESSION_SECRET`; default TTL 600 s. | `backend/src/auth/eoiTokens.js:29-40` |
| Refresh session | Opaque `<sessionId>.<secret>` in HttpOnly cookie `koi_rt` (`Path=/api/auth`, `SameSite` configurable, `Secure` in production); server stores only SHA-256; rotation with 10 s grace, reuse revokes the session. | `backend/src/auth/cookies.js:18-58`, `backend/src/services/authSessionService.js:43-128` |
| CSRF for cookie routes | custom header `X-KOI-Request` + `Origin` must equal `CLIENT_URL` on `/refresh` and `/logout`. | `backend/src/auth/cookies.js:58` |
| Per-request check | Bearer → verifier → `User` by id (EOI token) or issuer+subject (provider token), never by email; disabled user rejected on every request; unknown identity → 403 `IDENTITY_NOT_REGISTERED`. | `backend/src/auth/authenticate.js:61-94` |
| Google (OIDC) | Browser: Authorization Code + PKCE → Google. Server: `/api/auth/oidc/token` exchanges the code using the server-held client secret and an exact redirect-URI allow-list, verifies the ID token (issuer, audience, signature, alg, exp) via JWKS, then resolves the identity: linked → user; same issuer+subject → user; password account with verified email → **link required** (needs the account password); otherwise self-registration (if enabled) or "access restricted". | `frontend/src/services/auth/oidc/oidcFlow.js:26-44,93`, `backend/src/services/oidcExchangeService.js:65-125`, `backend/src/auth/oidcTokenVerifier.js:34`, `backend/src/services/googleLoginService.js:40-100`, `backend/src/controllers/authController.js:26-35` |
| Email + password | scrypt (N=2^16, r=8, p=1, NFKC, constant-time compare, dummy verify for unknown users); one-time verify (24 h) / reset (30 min) tokens stored as SHA-256, single use; anti-enumeration answers; unverified accounts cannot sign in; a failed verification mail rolls the new account back. | `backend/src/auth/passwordHasher.js:44`, `backend/src/services/passwordAuthService.js:60-216` |

## E. Authorization / RBAC

`authenticate → identity rate limits → JSON body parser → active workspace membership → permission [→ workspace AI limit]` is the single chain used by data routes (`requireAccess`, `backend/src/auth/authorize.js:54-61`).
Roles map to permissions server-side only (`backend/src/auth/roles.js:43-49`): viewer = `intelligence:view`; operator adds `intelligence:generate`, `operations:view|manage`, `decision:propose`, `action:propose`; reviewer adds `decision:review`, `action:review`; admin adds `workspace:admin`. `action:execute` exists but no role holds it. Role also sets a **knowledge visibility ceiling** (viewer→guest, operator/reviewer→staff, admin→restricted) used by retrieval and reads (`roles.js:51-56`, `backend/src/middleware/knowledgeAccess.js:36`).

## F. Multi-tenancy / tenant isolation

`workspaceId` from the request is only a *selector*: `resolveWorkspaceActor` loads the user, workspace and membership and returns the same 404 for "not a member", "revoked" and "does not exist" (`backend/src/auth/membership.js:27-43`). Services scope every query with `findInWorkspaceOr404` and validate cross-entity references with `assertSameWorkspace` (`backend/src/services/queryHelpers.js:29-60`). `Unit` is scoped through its `Property`, `Message` through its `Conversation`. Retrieval filters (workspace, visibility, scope) are in the MongoDB query, before any scoring (`knowledgeRetrievalService.js:112`).

## G. Database (MongoDB, Mongoose)

22 models (`backend/src/models/index.js`). Connection: `MONGODB_URI`, refused outside development/test unless it names a database (`backend/server.js:19-24`, `backend/src/config/mongoSafety.js:65`, `backend/src/config/database.js:27`).

| Group (diagram node) | Models | Tenant key |
|---|---|---|
| Identity + tenancy | `User`, `AuthIdentity`, `AuthSession`, `AuthToken`, `Workspace`, `WorkspaceMembership` | membership carries `workspaceId`; the rest are global |
| Operational data | `Property`, `Unit`, `Guest`, `Stay`, `Signal`, `Conversation`, `Message`, `ImportBatch` (+ Learning reads) | `workspaceId` (Unit via Property, Message via Conversation) |
| Intelligence + audit | `Intelligence`, `AnalysisAdmission`, `AnalysisAttempt` | `workspaceId` |
| Governance records | `Decision`, `Action`, `Outcome` | `workspaceId` |
| Knowledge + vectors | `KnowledgeDocument`, `KnowledgeChunk` (`embedding` array + `embeddingModel`) | `workspaceId` |

There is **no vector database**: vectors live on `KnowledgeChunk.embedding` (`backend/src/models/KnowledgeChunk.js:111`) and cosine similarity is computed in the Python service.

## H. AI service (Render, Python)

| Component | Technology | Responsibility | Source |
|---|---|---|---|
| FastAPI app + token gate | FastAPI 0.115, uvicorn, pydantic-settings | Middleware requires `X-KOI-Service-Token` (constant-time `hmac.compare_digest`) on everything except `/v1/health`; docs/OpenAPI hidden when a token is set; startup validation fails closed. | `ai-service/app/main.py:42-74`, `ai-service/app/startup_validation.py:13`, `ai-service/app/provider_policy.py:100` |
| Analysis endpoint | FastAPI router | `POST /v1/intelligence/analyze`: drops knowledge above the caller's level, builds prompt from Node-supplied context only, dispatches on `LLM_PROVIDER` (`test` deterministic \| `gemini`). | `ai-service/app/routers/analysis.py:31-49`, `ai-service/app/services/analysis_prompt.py` |
| Gemini analysis client | `google-genai` | `client.models.generate_content` with JSON response schema; approved model only (`gemini-3.1-flash-lite`), model identity cross-checked. | `ai-service/app/services/gemini_analysis_client.py:194,227,264`, `ai-service/app/provider_policy.py:31` |
| Embeddings endpoint + client | FastAPI, `google-genai` | `POST /v1/embeddings` → `EMBEDDING_PROVIDER` (`test` \| `gemini`, model `gemini-embedding-001`). | `ai-service/app/routers/embeddings.py:29`, `…/services/embedding_service.py:18`, `…/gemini_embedding_client.py:66`, `ai-service/app/config.py:52` |
| Retrieval scoring | FastAPI, pure Python | `POST /v1/knowledge-retrieval`: embeds Node's query, cosine-scores Node-selected candidates, applies Unit > Property > Workspace boost; **no MongoDB, no tenant knowledge**; Node owns threshold, top-K and re-verification. | `ai-service/app/routers/retrieval.py:50`, `ai-service/app/services/vector_math.py:46` |

Also present but **not called by Node**: `POST /v1/intelligence/signal` (legacy) and `POST /v1/vector-similarity` (primitive) — `ai-service/app/routers/intelligence.py:34`, `…/vector_similarity.py:29`.

## I. AI / LLM pipeline (what runs when "Assess this" is pressed)

1. SPA: `useCaseGeneration` → `POST /api/intelligence/analyze/:signalId` (user action only).
2. Node: access chain (`intelligence:generate`, AI-tier limiter) → single-flight → attempt marker.
3. Node: operational context (bounded, allow-listed) → knowledge retrieval (scoped query → AI scoring → relevance floor → top-5) → optional learning context (off).
4. Node → AI service `/v1/intelligence/analyze` (service token) → prompt from supplied context only → Gemini structured JSON → response contract.
5. Node: admission checks → store `Intelligence` + admission audit → SPA reads the stored analysis; decision/action/outcome are human steps.

## J. External services

| Service | Used for | Call site |
|---|---|---|
| Google OIDC | Sign-in (authorize in browser; token endpoint + JWKS from Node) | `oidcFlow.js:26-44`, `oidcExchangeService.js:42-63` |
| Resend | Transactional email (HTTPS API) | `emailService.js:152-160` |
| Gemini API | Analysis (`gemini-3.1-flash-lite`) and embeddings (`gemini-embedding-001`) — only from the Python service | `gemini_analysis_client.py:194`, `gemini_embedding_client.py:66` |
| MongoDB (Atlas) | Persistence | `database.js:27` |
| SMTP server | Optional/dev email transport (Nodemailer) | `emailService.js:78` |

## K. Email

Sign-up → `issueAndDeliver` creates a single-use token (SHA-256 stored) and calls `sendEmail`; link = `CLIENT_URL + /verify-email?token=…` (`emailService.js:179`). Transport chosen by `KOI_EMAIL_TRANSPORT` (`smtp` \| `resend` \| `outbox`); production accepts only `smtp` or `resend` and a non-localhost `https` `CLIENT_URL` (`emailConfig.js:103`). Failure to deliver deletes the token (and a just-created unverified account) and answers 503 `EMAIL_DELIVERY_FAILED`.

## L. Deployment / infrastructure

Evidence **in the repository**: `frontend/vercel.json` (SPA rewrite to `index.html`), `frontend/package.json` `engines.node = 24.x`, `backend/package.json` `engines.node = >=20.17 <21`, `ai-service/requirements.txt`/`constraints.txt`. **Not in the repository**: any Render, Docker, IaC or CI definition; `backend/docs/DEPLOYMENT_TOPOLOGY_AND_RECOVERY_PHASE38.md` states the repo declares no deployment target. The Vercel + Render (two web services) + MongoDB Atlas topology drawn in the diagram is therefore **as operated per the project owner**, not derivable from code.

## M. Security

See the "Security mechanisms" card in the diagram and [`06-end-to-end-flows.md`](06-end-to-end-flows.md). Highlights with sources: fail-closed start-up checks (`backend/server.js:16-103`), exact-origin CORS (`app.js:20-25`), headers (`securityHeaders.js:19-32`), rate limiting with a **process-local** store (`rateLimit.js:27`, honest limit stated in its header), JSON bodies parsed only after authentication (`authorize.js:54-68`), service-to-service token (`aiServiceClient.js:41`, `ai-service/app/main.py:52`), model output never trusted (`intelligenceAnalysisService.js:36-100`), secrets only via environment variables.

## N. Data flows (summary)

Browser ↔ SPA (memory token) → axios → Express → MongoDB (workspace-scoped). Node → FastAPI (context, candidates, texts; never a workspace id) → Gemini. Node → Resend (email). Browser ↔ Google (authorize) and Node ↔ Google (token, JWKS). Detail in `06-end-to-end-flows.md`.

## O. Request flows (index)

1. Authenticated application request · 2. Google sign-in · 3. Email + password + verification · 4. AI assistant analysis · 5. Guest intelligence (data → stored intelligence) · 6. Data flow summary · 7. Deployment flow — all in [`06-end-to-end-flows.md`](06-end-to-end-flows.md).
