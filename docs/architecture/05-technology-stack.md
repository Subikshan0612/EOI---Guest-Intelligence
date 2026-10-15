# EOI Guest Intelligence — technology stack

Only technologies found in the repository manifests or source at commit `7ad1d8d6a27faba838e40f87703b8e59996bb7c6`. Version strings are the
ranges/pins written in the manifests; installed versions can be newer within a range (see each lockfile). Companion to
[`03-eoi-master-architecture.html`](03-eoi-master-architecture.html).

## Frontend — `frontend/package.json`

| Technology | Declared | Used for | Evidence |
|---|---|---|---|
| React / React DOM | `^19.2.8` | UI | `frontend/package.json:18-19`, `frontend/src/main.jsx` |
| react-router-dom | `^7.18.3` | Client routing, `AuthGate`, deep-link restore | `frontend/package.json:20`, `frontend/src/app/routes.jsx:15` |
| axios | `^1.20.0` | The only API HTTP client | `frontend/package.json:16`, `frontend/src/services/api.js:15` |
| lucide-react | `^1.41.0` | Icons | `frontend/package.json:17` |
| Vite + `@vitejs/plugin-react` | `^6.4.3` / `^4.7.0` | Dev server and production build | `frontend/package.json:25-26`, `frontend/vite.config.js` |
| `@types/react`, `@types/react-dom` | `^19` | Editor typings only (the code is **plain JavaScript**, no TypeScript) | `frontend/package.json:23-24` |
| Browser `fetch`, WebCrypto | built-in | Credential endpoints; PKCE (`crypto.subtle`) | `frontend/src/services/auth/eoiAuthApi.js:30-40`, `…/oidc/oidcFlow.js:17-24` |
| Runtime requirement | Node `24.x` (build) | Vercel build target | `frontend/package.json:6-8` |
| State management | React context + hooks (no Redux/Zustand) | `LayoutProvider`, hooks per feature | `frontend/src/app/providers/layoutContext.js` |
| Styling | Hand-written CSS with design tokens (no Tailwind/MUI) | `frontend/src/styles/*.css` | `frontend/src/main.jsx:6-13` |
| Build output / hosting config | static SPA; rewrite to `index.html` | Vercel | `frontend/vercel.json` |

## Backend — `backend/package.json`

| Technology | Declared | Used for | Evidence |
|---|---|---|---|
| Node.js | `>=20.17.0 <21` | Runtime (ESM) | `backend/package.json:5,12-14` |
| Express | `^5.2.1` | HTTP API | `backend/app.js:1-12` |
| Mongoose | `^8.24.4` | MongoDB ODM, 22 models | `backend/src/models/index.js`, `backend/src/config/database.js:27` |
| jose | `^6.2.12` | JWT sign/verify (EOI HS256 tokens; OIDC/JWKS verification) | `backend/src/auth/eoiTokens.js:2`, `backend/src/auth/oidcTokenVerifier.js:34` |
| `node:crypto` scrypt | built-in | Password hashing (no bcrypt/argon dependency) | `backend/src/auth/passwordHasher.js:1-44` |
| cors | `^2.8.6` | Exact-origin CORS | `backend/app.js:20-25` |
| dotenv | `^17.4.2` | Local environment loading | `backend/src/config/env.js` |
| multer | `^2.4.0` | In-memory multipart upload (knowledge docs, CSV) | `backend/src/routes/knowledgeDocumentRoutes.js:20-30`, `backend/src/routes/importRoutes.js` |
| csv-parse | `^7.0.2` | CSV import | `backend/src/services/import/importService.js:1` |
| pdf-parse / mammoth | `^2.4.5` / `^1.12.3` | PDF and DOCX text extraction | `backend/src/services/knowledge/documentExtractor.js:1-2` |
| resend | `^6.33.0` | Production email transport (HTTPS) | `backend/src/services/emailService.js:154-160` |
| nodemailer | `^10.0.15` | SMTP transport (dev / optional) | `backend/src/services/emailService.js:78` |
| nodemon | `^3.1.14` (dev) | Auto-restart in development | `backend/package.json:8,30` |
| openai | `^6.49.0` | **Listed but not imported** by `backend/src`; only an env guard refers to `LLM_PROVIDER=openai` (`backend/src/config/startupChecks.js:26`). See uncertainty U5. | `backend/package.json:25` |
| Hand-written (no library) | — | Rate limiter, security headers, request id, error handler, cookie parsing | `backend/src/middleware/*`, `backend/src/auth/cookies.js` |

## AI service — `ai-service/requirements.txt`

| Technology | Pinned | Used for | Evidence |
|---|---|---|---|
| Python | 3.12.x (tested on 3.12.6 per `constraints.txt`) | Runtime | `ai-service/constraints.txt:1` |
| FastAPI | `0.115.6` | HTTP API | `ai-service/app/main.py:48` |
| uvicorn[standard] | `0.34.0` | ASGI server | `ai-service/requirements.txt:2` |
| pydantic / pydantic-settings | `2.13.5` / `2.7.1` | Request/response contracts; environment config | `ai-service/app/models/*.py`, `ai-service/app/config.py:1-35` |
| httpx | `0.28.1` | HTTP client dependency | `ai-service/requirements.txt:5` |
| google-genai | `2.23.0` | Gemini generate + embed | `ai-service/app/services/gemini_analysis_client.py:34-35`, `…/gemini_embedding_client.py:25-27` |
| pytest | `8.3.4` (dev) | test modules in `ai-service/tests/` | `ai-service/requirements-dev.txt`, `ai-service/tests/` |

## Database

| Technology | Notes | Evidence |
|---|---|---|
| MongoDB | Single database via `MONGODB_URI`; Atlas in the operated deployment (not derivable from code) | `backend/src/config/database.js:27`, `backend/docs/MONGODB_ATLAS_PHASE41.md` |
| Vector storage | Arrays on `KnowledgeChunk.embedding` in MongoDB — **no vector database** | `backend/src/models/KnowledgeChunk.js:111` |
| Similarity | Cosine, pure Python | `ai-service/app/services/vector_math.py:46` |

## Authentication / security libraries and standards

OAuth 2.0 / OIDC Authorization Code + **PKCE** (RFC 7636), JWKS verification (jose), HS256 EOI access tokens, HttpOnly refresh cookie with rotation, scrypt (RFC 7914), SHA-256 token hashing, constant-time comparison (`crypto.timingSafeEqual`, `hmac.compare_digest`). Sources: section D of [`04-architecture-inventory.md`](04-architecture-inventory.md).

## External APIs / services

| Service | Role | Evidence |
|---|---|---|
| Google Identity (OIDC) | Sign-in | `frontend/src/services/auth/oidc/oidcFlow.js:26-44`, `backend/src/services/oidcExchangeService.js:42-125` |
| Gemini API (`gemini-3.1-flash-lite`, `gemini-embedding-001`) | Analysis + embeddings, called only from the Python service | `ai-service/app/provider_policy.py:31`, `ai-service/app/config.py:52` |
| Resend | Email delivery (HTTPS) | `backend/src/services/emailService.js:154-160` |

## Hosting (as operated — not encoded in the repository)

| Platform | Hosts | Repository evidence |
|---|---|---|
| Vercel | React SPA | `frontend/vercel.json`, `frontend/package.json` engines `24.x` |
| Render (web service) | Node API | `backend/package.json` start script `node server.js`; no Render file |
| Render (web service) | FastAPI AI service | `ai-service/requirements.txt`; no Render file |
| MongoDB Atlas | Database | `backend/docs/MONGODB_ATLAS_PHASE41.md` (guidance only) |

## Build, test and development tooling

| Tool | Evidence |
|---|---|
| `npm` (lockfiles in `frontend/` and `backend/`) | `frontend/package-lock.json`, `backend/package-lock.json` |
| Vite build / dev (`npm run build`, `npm run dev`) | `frontend/package.json:9-13` |
| Nodemon dev server, `npm start` | `backend/package.json:7-11` |
| 113 `.mjs` scripts in `backend/scripts/` (API/tenant-isolation, auth, email transport, deployment-readiness and evaluation suites; operator tools such as `provision-user.mjs`, `create-dev-workspace.mjs`) | `backend/scripts/` |
| `pytest` suite for the AI service (test modules in `ai-service/tests/`) | `ai-service/tests/` |
| Archify (diagram generation for this documentation) | `docs/architecture/*.finalize.json` |

## Environment variable names (names only — values are never recorded)

* **Backend**: `NODE_ENV`, `PORT`, `MONGODB_URI`, `CLIENT_URL`, `AUTH_PROVIDER`, `KOI_SESSION_SECRET`, `KOI_ACCESS_TOKEN_TTL_SECONDS`, `KOI_REFRESH_TTL_DAYS`, `KOI_COOKIE_SECURE`, `KOI_COOKIE_SAMESITE`, `KOI_SELF_REGISTRATION`, `KOI_TRUST_PROXY`, `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URI`, `OIDC_ALGORITHMS`, `OIDC_EXCHANGE_CLIENT_ID`, `OIDC_EXCHANGE_CLIENT_SECRET`, `OIDC_EXCHANGE_REDIRECT_URIS`, `KOI_EMAIL_TRANSPORT`, `MAIL_FROM`, `RESEND_API_KEY`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `AI_SERVICE_URL`, `AI_SERVICE_TOKEN`, `LLM_PROVIDER`, `KOI_RETRIEVAL_MIN_SIMILARITY`, `KOI_LEARNING_CONTEXT_ENABLED`, `KOI_RATE_LIMIT_ENABLED` (full list: `backend/docs/PRODUCTION_ENVIRONMENT_CONTRACT.md`).
* **Frontend (public, build-time)**: `VITE_API_BASE_URL`, `VITE_KOI_AUTH`, `VITE_OIDC_AUTHORITY`, `VITE_OIDC_CLIENT_ID`, `VITE_OIDC_REDIRECT_URI`, `VITE_OIDC_SCOPE`, `VITE_OIDC_TOKEN_EXCHANGE_URL`, `VITE_OIDC_PROVIDER_LABEL`, `VITE_OIDC_AUTO_REDIRECT` (dev only: `VITE_DEV_ACCESS_TOKEN`, `VITE_KOI_WORKSPACE_ID`).
* **AI service**: `AI_SERVICE_PORT`, `AI_SERVICE_TOKEN`, `LLM_PROVIDER`, `LLM_MODEL`, `GEMINI_API_KEY`, `REQUEST_TIMEOUT_MS`, `LLM_ANALYSIS_TIMEOUT_MS`, `LLM_MAX_OUTPUT_TOKENS`, `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_BATCH_SIZE`, `SIMILARITY_MAX_CANDIDATES`.
