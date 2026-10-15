# EOI Guest Intelligence — architecture source map and evidence matrix

Evidence for [`03-eoi-master-architecture.html`](03-eoi-master-architecture.html), prepared for technical review and interview use.
Repository commit: `7ad1d8d6a27faba838e40f87703b8e59996bb7c6` (`main`). Each component's source references are also embedded in the
diagram (the "SRC n" badges) and were machine-checked against the committed bytes at that revision by Archify's repository-evidence gate.

Files in this set: `03-eoi-master-architecture.html` (diagram) · `03-eoi-master-architecture.json` (diagram source; **git-ignored** by `.gitignore:33`, `docs/architecture/*.json`, so it exists only in the author's working copy) ·
[`04-architecture-inventory.md`](04-architecture-inventory.md) · [`05-technology-stack.md`](05-technology-stack.md) ·
[`06-end-to-end-flows.md`](06-end-to-end-flows.md) · this file · Archify receipts `03-eoi-master-architecture.*.json` (also git-ignored; not committed).

## 1. Existing architecture artifacts (kept unchanged)

| Artifact | What it shows | Assessment |
|---|---|---|
| `01-eoi-high-level-architecture.html` (Archify v3.0.1, passed all gates on 2026-10-06) | 7 components: Operators, React SPA, Google OIDC, Node/Express API, MongoDB, Python AI service, Gemini | Still *structurally* true, but predates the unified EOI session (email+password, refresh cookie), Resend/email, conversational intake, the Decision→Action→Outcome UI and any deployment view. |
| `02-eoi-detailed-architecture.html` (Archify, **finalize FAILED** on 2 route crossings; HTML still on disk) | 40 components: older frontend modules (Dashboard, Learning page, "Decisions view read-only"), Node layers, data groups, Python layers | **Outdated** in several places: shows a Dashboard UI and Learning page that are no longer mounted, a read-only Decisions view that is now a full propose/approve flow, Google-only auth, no email, no session service, no deployment. |
| Original `01/02-*.json` specs | not in the repository or the scratch area | cannot be re-run; the new diagram was authored from source instead. |

The new master diagram reuses their idea (trusted/untrusted layers, tenant authority in Node, stateless Python) and adds what is now implemented.

## 2. Component evidence matrix (34 diagram components)

| Id | Component | Technology | Purpose (diagram sublabel) | Source location (path:lines) |
|---|---|---|---|---|
| `users` | Operators | Web browser | browser · 4 workspace roles | `backend/src/auth/roles.js:43-49` roles: viewer/operator/reviewer/admin |
| `fe_shell` | React SPA shell | React 19 · Vite 6 · react-router 7 | React 19 · Vite 6 · Router 7 | `frontend/src/main.jsx:19-27` bootstrap after sign-in settles<br>`frontend/src/app/App.jsx:62-70` BrowserRouter + AuthGate<br>`frontend/src/app/routes.jsx:15-33` mounted routes |
| `fe_auth` | Auth UI + session | OIDC Authorization Code + PKCE · fetch · in-memory token | sign in · PKCE · token (mem) | `frontend/src/services/auth/oidc/oidcSession.js:182` Google redirect + code exchange<br>`frontend/src/services/auth/eoiAuthApi.js:30-40` email+password calls (fetch)<br>`frontend/src/app/App.jsx:26-60` AuthGate journey |
| `fe_ops` | Properties + Guests | React pages + hooks | units · stays · guest detail | `frontend/src/pages/PropertiesPage.jsx:9` properties<br>`frontend/src/pages/GuestsPage.jsx:9` guests<br>`frontend/src/features/operations/useGuests.js:13` guests data hook |
| `fe_assist` | AI Assistant | React page + hooks (polling controller) | report · case · decide · act | `frontend/src/pages/AssistantPage.jsx:22` assistant page<br>`frontend/src/features/assistant/useCaseGeneration.js:25` starts analysis (user action)<br>`frontend/src/features/assistant/SignalCaseCard.jsx:36` case card |
| `fe_api` | API client | axios 1.x | axios · Bearer · 401 refresh | `frontend/src/services/api.js:15-21` only axios instance<br>`frontend/src/services/api.js:123-140` request interceptor<br>`frontend/src/services/api.js:142-160` response/refresh |
| `be_edge` | Edge middleware | Express 5 · cors · in-house middleware | CORS · headers · rate limit | `backend/app.js:20-34` cors, requestId, headers, limiters<br>`backend/src/middleware/securityHeaders.js:19-32` security headers<br>`backend/src/middleware/rateLimit.js:27-40` in-memory rate limiter |
| `be_authn` | Authentication | jose (HS256 EOI token / OIDC JWKS) · Mongoose User | EOI JWT / OIDC verify · User | `backend/src/auth/authenticate.js:61-77` token -> verified identity -> User<br>`backend/src/auth/eoiTokens.js:29-40` HS256 access token<br>`backend/src/auth/oidcTokenVerifier.js:34` OIDC JWKS verifier |
| `be_rbac` | Membership + RBAC | role→permission map · Mongoose WorkspaceMembership | role -> permission (4 roles) | `backend/src/auth/membership.js:27-43` active membership -> role<br>`backend/src/auth/authorize.js:34-61` requirePermission / requireAccess<br>`backend/src/auth/roles.js:43-56` role->permission, knowledge ceiling |
| `be_tenant` | Tenant isolation | Mongoose query helpers (workspace scope) | verified workspace scopes every service query · a foreign id answers 404 | `backend/src/auth/membership.js:27-43` workspaceId is only a selector<br>`backend/src/services/queryHelpers.js:29-60` findInWorkspaceOr404 / assertSameWorkspace |
| `be_session` | Session + Google login | jose · scrypt (node:crypto) · Mongoose | scrypt · rotation · exchange | `backend/src/services/passwordAuthService.js:109-190` sign-up/in, verify, reset<br>`backend/src/services/authSessionService.js:43-100` session + refresh rotation<br>`backend/src/services/oidcExchangeService.js:65-125` Google code+PKCE exchange |
| `be_email` | Email service | resend SDK · nodemailer (dev) | Resend · SMTP dev · outbox | `backend/src/services/emailService.js:152-160` resend transport<br>`backend/src/services/emailService.js:187-215` sendEmail (never throws)<br>`backend/src/config/emailConfig.js:36-100` transport config |
| `be_gov` | Decision lifecycle | Express services · Mongoose | human review · no execution | `backend/src/services/decisionService.js:181` proposeDecision<br>`backend/src/services/actionService.js:372` proposeAction<br>`backend/src/services/outcomeService.js:265` recordOutcome |
| `be_ops` | Operational services | Express services · Mongoose · csv-parse | CRUD · CSV import · dashboard | `backend/src/routes/index.js:20-38` route registry<br>`backend/src/services/import/importService.js:208` CSV import<br>`backend/src/services/dashboardService.js:195` dashboard read model |
| `be_intake` | Conversational intake | Pure JavaScript parser (no model call) | no LLM · records Signal | `backend/src/services/signalIntakeService.js:71` one operator turn<br>`backend/src/services/signalInterpreter.js:167` no model call<br>`backend/src/services/signalService.js:90` createSignal |
| `be_orch` | Analysis orchestrator | Node service (in-process single-flight) | single-flight · attempt · 202 | `backend/src/services/intelligenceAnalysisService.js:152-188` analyzeSignal single-flight<br>`backend/src/services/intelligenceAnalysisService.js:252-300` runAnalysis pipeline<br>`backend/src/services/analysisAttemptService.js:59` durable attempt marker |
| `be_ctx` | Operational context | Node service · Mongoose reads | bounded · allowlisted ctx | `backend/src/services/operationalContextService.js:44-80` buildOperationalContext |
| `be_know` | Knowledge service | multer · pdf-parse · mammoth · Mongoose | ingest · embed · retrieve | `backend/src/services/knowledge/documentExtractor.js:313` ingest: PDF / DOCX / text<br>`backend/src/services/knowledgeEmbeddingService.js:84` embed chunks via AI service<br>`backend/src/services/knowledgeRetrievalService.js:112` retrieve: scoped KnowledgeChunk.find |
| `be_aiclient` | AI service client | Node fetch (AbortController timeouts) | HTTPS · token · timeouts | `backend/src/services/ai/aiServiceClient.js:25-60` postToAiService + token header<br>`backend/src/services/ai/aiServiceClient.js:113-124` analyze request |
| `be_valid` | Admission + store | Node validators · Mongoose | schema · claims · safety | `backend/src/services/intelligenceAnalysisService.js:36-100` validateAndVerifyAnalysis<br>`backend/src/services/ai/claimValidator.js:95` claims<br>`backend/src/services/intelligenceService.js:161` createAnalysisIntelligence |
| `db_gov` | Governance records | MongoDB · Mongoose | Decision · Action · Outcome | `backend/src/models/Decision.js:121` Decision<br>`backend/src/models/Action.js:143` Action<br>`backend/src/models/Outcome.js:87` Outcome |
| `db_ops` | Operational data | MongoDB · Mongoose | Signal · Guest · Stay · Unit | `backend/src/models/Signal.js:123` Signal<br>`backend/src/models/Guest.js:63` Guest<br>`backend/src/models/Stay.js:93` Stay |
| `db_know` | Knowledge + vectors | MongoDB · Mongoose (vectors as arrays) | Document · Chunk · embedding | `backend/src/models/KnowledgeDocument.js:206` document<br>`backend/src/models/KnowledgeChunk.js:111` embedding vector<br>`backend/src/models/KnowledgeChunk.js:134` chunk model |
| `db_intel` | Intelligence + audit | MongoDB · Mongoose | Intelligence · admission audit | `backend/src/models/Intelligence.js:294` Intelligence<br>`backend/src/models/AnalysisAdmission.js:89` admission audit<br>`backend/src/models/AnalysisAttempt.js:53` attempt marker |
| `db_identity` | Identity + tenancy | MongoDB · Mongoose | User · Workspace · Membership | `backend/src/models/User.js:40` User<br>`backend/src/models/WorkspaceMembership.js:28` membership<br>`backend/src/models/AuthSession.js:31` session |
| `ai_gate` | FastAPI + token gate | FastAPI middleware · hmac | service token · /health open | `ai-service/app/main.py:48-66` app + service-token middleware<br>`ai-service/app/main.py:69-74` routers |
| `ai_analyze` | Analysis endpoint | FastAPI router · pydantic | /v1/intelligence/analyze | `ai-service/app/routers/analysis.py:31-49` analyze route + provider switch |
| `ai_embed` | Embeddings endpoint | FastAPI router · pydantic | /v1/embeddings | `ai-service/app/routers/embeddings.py:29` embeddings route |
| `ai_retr` | Retrieval scoring | FastAPI router · pure Python cosine | cosine · scope boost · no DB | `ai-service/app/routers/retrieval.py:50` knowledge-retrieval route<br>`ai-service/app/services/vector_math.py:46` cosine similarity |
| `ai_llm` | Gemini analysis client | google-genai SDK | approved model · JSON schema | `ai-service/app/services/gemini_analysis_client.py:227` generate_gemini_analysis<br>`ai-service/app/services/gemini_analysis_client.py:194` generate_content<br>`ai-service/app/provider_policy.py:31` APPROVED_MODEL |
| `ai_embedder` | Embedding client | google-genai SDK · deterministic test provider | gemini-embedding-001 | test | `ai-service/app/services/embedding_service.py:18` provider dispatch<br>`ai-service/app/services/gemini_embedding_client.py:66` client.models.embed_content<br>`ai-service/app/config.py:52` embedding_model |
| `ext_google` | Google OIDC | Google OIDC / OAuth 2.0 | authorize · token · JWKS | `frontend/src/services/auth/oidc/oidcFlow.js:26-44` authorization URL (PKCE)<br>`backend/src/services/oidcExchangeService.js:42-63` token endpoint discovery |
| `ext_resend` | Resend | Resend HTTPS API | HTTPS email API | `backend/src/services/emailService.js:156` resend.emails.send |
| `ext_gemini` | Gemini API | Gemini API | gemini-3.1-flash-lite · embed | `ai-service/app/services/gemini_analysis_client.py:194` generate_content<br>`ai-service/app/services/gemini_embedding_client.py:66` embed_content |

Deployment boundaries (regions) in the diagram:

| Region | Wraps | Evidence in repo | Confidence |
|---|---|---|---|
| Vercel — frontend (static SPA) | the 5 `fe_*` nodes | `frontend/vercel.json:2`, `frontend/package.json:6-8` (Node 24.x) | Hosting provider is **not** encoded; SPA rewrite and Node 24 engine are consistent with Vercel |
| Render — Node API (Express 5) | the 14 `be_*` nodes | `backend/package.json:7-14` (`npm start`, Node ≥20.17 <21) | Provider **not** in repo (no `render.yaml`) |
| MongoDB Atlas — koi_staging | the 5 `db_*` nodes | `backend/docs/MONGODB_ATLAS_PHASE41.md`; URI validated in `backend/src/config/mongoSafety.js:65` | Cluster/database name come from the operated deployment, not the code |
| Render — AI service (FastAPI) | the 6 `ai_*` nodes | `ai-service/requirements.txt`, `ai-service/app/main.py:48` | Provider **not** in repo |

## 3. Connection evidence (what each arrow means)

| Arrow | Meaning | Source |
|---|---|---|
| users → fe_shell | The browser loads the SPA; SPA hosting is a Vercel rewrite to `index.html` | `frontend/vercel.json:2`, `frontend/src/main.jsx:19-27` |
| fe_shell → fe_ops / fe_assist / fe_auth | Route table and `AuthGate` mount these screens | `frontend/src/app/routes.jsx:15-33`, `frontend/src/app/App.jsx:26-60` |
| fe_ops / fe_assist → fe_api | Hooks import the API module (`koiApi`) | `frontend/src/features/operations/useGuests.js:3`, `frontend/src/features/assistant/useCaseGeneration.js:25` |
| fe_api → be_edge | `VITE_API_BASE_URL` base, Bearer interceptor; Express applies CORS/limits first | `frontend/src/services/api.js:15-21,123-140`, `backend/app.js:20-34` |
| be_edge → be_authn → be_rbac → be_tenant | The standard access chain, in this order | `backend/src/auth/authorize.js:54-61`, `backend/src/auth/membership.js:27-43`, `backend/src/services/queryHelpers.js:44` |
| be_tenant → services (gov, ops, intake, orch, know) | Controllers pass the verified `req.actor.workspaceId` to services | `backend/src/controllers/guestController.js:6`, `backend/src/controllers/conversationController.js:12` |
| fe_auth → be_session | Credential endpoints via `fetch`; Google code goes to `/api/auth/oidc/token` (same node: exchange + session) | `frontend/src/services/auth/eoiAuthApi.js:30-40`, `backend/src/routes/authRoutes.js:39-52` |
| fe_auth → ext_google | Browser redirects to Google's authorization endpoint with PKCE | `frontend/src/services/auth/oidc/oidcFlow.js:26-44` |
| be_session → ext_google | Server-side token endpoint call and JWKS verification | `backend/src/services/oidcExchangeService.js:42-63,65-125`, `backend/src/auth/oidcTokenVerifier.js:34` |
| be_session → be_email | Sign-up / reset call `sendEmail` through `issueAndDeliver` | `backend/src/services/passwordAuthService.js:62-90` |
| be_email → ext_resend | Resend SDK `emails.send` (HTTPS) when `KOI_EMAIL_TRANSPORT=resend` | `backend/src/services/emailService.js:152-160` |
| be_orch → be_ctx → be_know | `runAnalysis` builds context then retrieves knowledge using the context | `backend/src/services/intelligenceAnalysisService.js:268-272` |
| be_know → be_aiclient | Retrieval and embedding both call the AI client | `backend/src/services/knowledgeRetrievalService.js:3`, `backend/src/services/knowledgeEmbeddingService.js:3` |
| be_aiclient → be_valid | The raw analysis returned by the client is validated, then stored | `backend/src/services/intelligenceAnalysisService.js:283-287,309` |
| be_aiclient → ai_gate | POST with `X-KOI-Service-Token`; Python enforces it | `backend/src/services/ai/aiServiceClient.js:25-60`, `ai-service/app/main.py:52-66` |
| ai_gate → ai_analyze / ai_embed / ai_retr | The three routers Node uses are included on the app | `ai-service/app/main.py:69-74` |
| ai_analyze → ai_llm | Router dispatches to the Gemini analysis client when `LLM_PROVIDER=gemini` | `ai-service/app/routers/analysis.py:47` |
| ai_embed / ai_retr → ai_embedder | Both call the shared embedding dispatch | `ai-service/app/routers/embeddings.py:24`, `ai-service/app/routers/retrieval.py:36` |
| ai_llm / ai_embedder → ext_gemini | `generate_content` and `embed_content` calls | `ai-service/app/services/gemini_analysis_client.py:194`, `ai-service/app/services/gemini_embedding_client.py:66` |
| be_gov → db_gov | Decision/Action/Outcome services read and write their models | `backend/src/services/decisionService.js:2`, `backend/src/models/Decision.js:121` |
| be_ops / be_intake → db_ops | CRUD and intake write Property/Unit/Guest/Stay/Signal/Conversation/Message | `backend/src/services/guestService.js:1`, `backend/src/services/signalIntakeService.js:1-5` |
| be_ctx → db_ops (read) | Context assembly reads the Signal and its related records | `backend/src/services/operationalContextService.js:50`, `backend/src/services/analysisContextService.js:1` |
| be_know → db_know | Chunks and embeddings are stored/queried in `KnowledgeChunk` | `backend/src/services/knowledgeRetrievalService.js:112`, `backend/src/models/KnowledgeChunk.js:111` |
| be_valid → db_intel | `createAnalysisIntelligence` stores the validated analysis; admission audit row | `backend/src/services/intelligenceService.js:161`, `backend/src/services/intelligenceAnalysisService.js:309-345` |
| be_session → db_identity | Users, sessions and one-time tokens are persisted | `backend/src/services/authSessionService.js:5`, `backend/src/services/passwordAuthService.js:62-70` |

## 4. Validation performed

| # | Check | Result |
|---|---|---|
| 1 | Every component cites 1–3 source ranges; Archify's repository-evidence gate verified each path and line range against the committed bytes at the pinned revision | pass (34/34 components) |
| 2 | Archify gates `validate`, `deliver`, strict `check`, real-browser `browser-check` (1440×900, 1600×1000, 1920×1080, 2048×1320, light and dark, horizontal overflow, text readability, viewer chrome) | pass, quality profile `standard` (see note) |
| 3 | Arrows reviewed against the call sites listed in section 3 | each arrow has at least one supporting source range; no arrow was drawn from a configuration value alone |
| 4 | Markdown citations (`path:lines`) in documents 04–07 checked against `git show HEAD:<path>` line counts | pass (script run on all four documents) |
| 5 | No secrets: documents and diagram contain environment-variable **names** only; scanned for key-shaped strings (`re_…`, `AIza…`, `GOCSPX`, PEM headers, `mongodb+srv://`, JWTs) | pass |
| 6 | No application file was modified; only `docs/architecture/` was written | pass (`git status`) |

Note on quality profile: the stricter `showcase` profile rejects this diagram on *desktop text size* (a 34-component diagram needs a canvas ≈1,800 px wide; the smallest label projects to exactly the 6.0 px pass floor at a 1440 px viewport and ≈6.7 px at 1600 px and wider, per the `browser-check` receipt). Archify permits `standard` for dense diagrams. Zoom, PATH and LENS controls are available in the viewer; the page scrolls vertically (`readable-vertical-scroll`).
No visual-quality claim beyond this was verified by a human: captures were inspected by the author of this document only.

## 5. Architecture uncertainty and items that could not be verified

| Id | Item | Why uncertain | What would settle it |
|---|---|---|---|
| U1 | Hosting topology (Vercel, two Render web services, MongoDB Atlas `koi_staging`) | Not declared in code; `backend/docs/DEPLOYMENT_TOPOLOGY_AND_RECOVERY_PHASE38.md` says the repository declares no deployment target | Vercel/Render/Atlas dashboards, or an IaC file |
| U2 | Which provider values are active in the deployment (`AUTH_PROVIDER`, `LLM_PROVIDER`, `EMBEDDING_PROVIDER`, `KOI_EMAIL_TRANSPORT`) | Read from environment at runtime; defaults are `test` for both Python providers | Deployment environment (names only are documented here) |
| U3 | Resend domain verification / actual delivery | Needs a Resend account and DNS; this analysis made **no** real send | A test sign-up and the Resend dashboard |
| U4 | Rate limiting is process-local (in-memory store) | Fine for one instance; multiple instances would multiply limits (stated in `backend/src/middleware/rateLimit.js:1-20`) | Instance count on the host |
| U5 | `openai` npm dependency | Listed in `backend/package.json:25`, never imported under `backend/src`; only referenced in an env guard (`startupChecks.js:26`) | Remove or document it |
| U6 | Dashboard UI, Learning UI, `SignalForm`, `ConversationProvider` | Present in `frontend/src` but not reachable from `App.jsx`/`routes.jsx` | Decide to mount or delete |
| U7 | `/api/knowledge-documents`, `/api/imports`, `/api/learning`, `/api/dashboard` | Implemented and authorized but no frontend caller; operated via API/scripts | Operator runbooks |
| U8 | AI-service routes `/v1/intelligence/signal`, `/v1/vector-similarity` | Exist; Node never calls them | Confirm they can be retired |
| U9 | AI service reachability | On a free host the AI service is publicly reachable and protected only by `X-KOI-Service-Token` (`ai-service/app/main.py:52-66`); its README/inventory say it should be private where the platform allows | Platform networking settings |
| U10 | Google OAuth client configuration (redirect URIs, consent screen) | Lives in Google Cloud; code only holds an exact allow-list (`OIDC_EXCHANGE_REDIRECT_URIS`) | Google Cloud console |

Documentation drift noticed (informational; no repository file was changed): `CLAUDE.md` still says generated intelligence is ephemeral
and that `llmProvider.js` retains `openai`/`test` branches. In the current source Intelligence **is persisted** (`backend/src/services/intelligenceService.js:161`),
and `backend/src/services/ai/llmProvider.js` no longer exists. `CLAUDE.md` also lists Phase 5 as in progress and does not mention the unified session, Resend or the assistant.

## 6. Regenerating the diagram

The diagram is generated from `03-eoi-master-architecture.json` (Archify architecture schema v1; git-ignored, so keep a copy or recreate it from the component and arrow tables in sections 2–3). From the repository root, with Archify v3.0.1 installed:

```bash
node <archify>/bin/archify.mjs finalize architecture docs/architecture/03-eoi-master-architecture.json docs/architecture/03-eoi-master-architecture.html --repo-root . --quality standard --json
```

`--repo-root` makes Archify re-verify every cited line range against the pinned revision in `meta.repository.revision`; when the code changes, update that revision and the ranges. Archify reported that version 3.1.0 is available (installed: 3.0.1); it was not updated.
