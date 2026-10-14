# Phase 39 - Real deployment preflight and production environment verification

Evidence vocabulary: **CODE VERIFIED** (a test or a local run in this repository proves it), **DEPLOYMENT VERIFIED** (proved on the real hosting target),
**OPERATIONS VERIFIED** (proved operationally: backups restored, alerts firing), **NOT VERIFIED** (could not be checked from here).
**Nothing in this phase is DEPLOYMENT VERIFIED or OPERATIONS VERIFIED.** No production, staging or hosting environment is configured in the repository or was
supplied, so every external control below is NOT VERIFIED. Nothing was deployed, contacted, modified, rotated or committed; no real database was written.

## 1. Deployment target discovery

**NO DEPLOYMENT TARGET CONFIGURED IN REPOSITORY.**

Searched the whole tree (excluding `node_modules`, `.venv`, `.git`): no Dockerfile or compose file, no `Procfile`, `render.yaml`, `vercel.json`, `netlify.toml`,
`fly.toml`, `railway.*`, `app.yaml`, `amplify.yml`, `nixpacks.toml`, `wrangler.toml`; no Kubernetes, Helm, Terraform or Pulumi; no process-manager, reverse-proxy or
service files; no CI/CD (`.github`, GitLab, Jenkins, Azure, Cloud Build). The only remote is a source-control remote (GitHub), which is not a deployment target.
`.claude/launch.json` is a local developer launcher (loopback ports, deterministic test providers) and is not a deployment configuration. Scripts: backend `start` is
`node server.js`; frontend `build` is `vite build` (static output); the AI service is documented only as `uvicorn app.main:app --reload --port 8000` (a development
command: no production command, worker count or bind address is documented). No document names a hosting platform.

FRONTEND TARGET: UNKNOWN
NODE TARGET: UNKNOWN
PYTHON TARGET: UNKNOWN
MONGODB TARGET: UNKNOWN (the only MongoDB reachable from this machine is a local development standalone with no authentication; it is not a production target)
OIDC TARGET: UNKNOWN (no `OIDC_*` or `VITE_OIDC_*` value is configured anywhere on this machine)

No platform was assumed. Platform-specific tooling that happens to be available to the assistant was not used.

## 2. Topology (required, none verifiable from the repository)

```
Frontend (static)  ->  ONE Node backend  ->  MongoDB
                              |
                              +-> Python AI service (private) -> Gemini
```

| # | Required property | Status | What the code proves / what the operator must show |
|---|---|---|---|
| 1 | Node has exactly one replica | NOT VERIFIED | code warns at production start-up; platform setting must be min = max = 1 |
| 2 | Node cannot autoscale | NOT VERIFIED | no autoscaling rule, no overlapping blue/green or preview instance sharing the production database |
| 3 | The AI service stays stateless | CODE VERIFIED | it has no database access and no tenant knowledge (Phase 5 design, re-asserted by tests) |
| 4 | The AI service is not publicly exposed | NOT VERIFIED | see section 9: it has NO authentication of its own |
| 5 | MongoDB is not open to the internet | NOT VERIFIED | allow-list or private network; authentication on |
| 6 | Gemini is called only from the AI service | CODE VERIFIED | Node has no Gemini client or key use (grep of `src`: only a test-isolation check names `OPENAI_API_KEY`) |
| 7 | The frontend talks only to the intended backend | NOT VERIFIED | build-time `VITE_API_BASE_URL`; the preflight tool scans the built bundle for it |
| 8 | The backend talks only to the intended AI service | NOT VERIFIED | `AI_SERVICE_URL` (a private address) |
| 9 | Browsers cannot reach the AI service | NOT VERIFIED | network isolation (no public route, no CORS headers on the AI service) |
| 10 | The AI service cannot bypass Node authorization | CODE VERIFIED if section 9 holds | Node authenticates and authorizes before it ever calls the AI service |

If the chosen platform autoscales the backend: **PRODUCTION BLOCKER - NODE HORIZONTAL SCALING MUST BE DISABLED.** Do not solve it with Redis or distributed locking.

## 3. Production environment preflight

A new operator tool judges a configuration without printing any value:

```bash
node backend/scripts/phase39/env-preflight.mjs --backend <file> --ai <file> --frontend <file> --bundle <frontend build dir>
```

It reuses the backend's own start-up checks, so "PASS" means the backend would not refuse to start, and it adds the contract rules the code cannot enforce
(approved model exactly, Gemini key only in the AI service, no development token in the build, HTTPS origins, no secret-shaped `VITE_` variable, a secret value
or connection string inside the built bundle). It prints names, `PRESENT`/`ABSENT`/`SECRET PRESENT`/`SECRET MISSING` and fixed messages only; a file you do not give is
reported `NOT PROVIDED`, never silently passed. It cannot see the platform (replicas, network, TLS, backups, logs, alerts).

Results here (CODE VERIFIED that the tool works, 50+ deterministic cases in `validate-phase39-preflight.mjs`; **no real production environment was available to judge**):

* A synthetic production-style configuration (placeholders only) passes: 27 PASS, 0 FAIL.
* This machine's local development files FAIL 10 checks, as they should, because they are development configuration and not a production environment:
  `NODE_ENV=development`; a loopback, unauthenticated `MONGODB_URI`; no authentication/OIDC configuration; `CLIENT_URL` and `VITE_API_BASE_URL` at loopback; no
  `VITE_OIDC_*`; the AI service set to the deterministic provider; and **stale model names** (`LLM_MODEL` is the not-approved value in both `.env` files).
  The AI service refuses to start with such a model when its provider is `gemini` (Phase 36 start-up matrix), so a copied development file fails closed - but do not copy it.
* **Finding - least privilege:** `backend/.env` holds a real-looking Gemini API key (different from the AI service's). Node never uses a Gemini key. In production the
  Node environment must hold no Gemini key; the preflight FAILs it.

## 4. Secret exposure review (CODE VERIFIED, local; the value was never printed)

* No `.env` file is tracked (only the three `.env.example`); all real `.env` files and `.env.*` are git-ignored.
* The two Gemini keys found on this machine each occur in exactly one on-disk file (their own ignored `.env`), in **zero commits across all of git history**, and in zero
  git-visible files. No placeholder-looking secret was found in the examples (`OPENAI_API_KEY` in the backend example is an obvious placeholder).
* The frontend source reads only public `VITE_` names; the development token is read only when `import.meta.env.DEV` is true; the OIDC client has no secret by design.
* Built bundles (as configured, and a production-style build with synthetic values): neither Gemini key, no connection string, no key-shaped string, no
  development token, no private key, no `client_secret`, no `Bearer` literal, no `console.log`. The only `localhost` strings are React/React-Router URL-parsing
  internals, and the only provider-name string is help text in the UI.
* Start-up output never echoes a value (Phase 36/38 tests); events carry no secret, id or content.
* **No secret exposure was found. Not a blocker.** Not rotated (out of scope; no exposure).

## 5. OIDC

NOT VERIFIED - REAL OIDC TARGET UNAVAILABLE. No issuer, audience, client id or redirect URI is configured on this machine. CODE VERIFIED (Phase 23, re-run in the
matrix): the verification logic and every refusal, against a local issuer. Operator must show: the discovery document and JWKS reachable over HTTPS from the backend; the
issuer string equals `OIDC_ISSUER` exactly (no trailing-slash difference); the access token's `aud` equals `OIDC_AUDIENCE`; the SPA client is a public PKCE client whose
redirect URI is the production frontend origin and whose allowed web origin is that origin only; token lifetime is short; the first user and a workspace membership are
provisioned by a controlled procedure (an unknown identity is authenticated but has no access, by design). An interactive sign-in must be done once by a person
(PARTIALLY VERIFIED at best until then).

## 6. MongoDB

NOT VERIFIED - REAL MONGODB TARGET UNAVAILABLE. The local development MongoDB (8.x, standalone, no authentication, database `koi`) was inspected read-only for metadata:
it is exactly what production must not be (no auth, no TLS, loopback). CODE VERIFIED: a production URI without a database name refuses to start; credentials/TLS absence warns;
indexes are built by the models on an empty database with no migration (restore rehearsal below). Operator must show: authentication on with a least-privilege user for one
database, TLS on, network allow-list, the intended database name, a replica set or managed deployment if point-in-time recovery is wanted, and that nothing but this
application writes to it. The application's indexes are listed in `PRODUCTION_ENVIRONMENT_CONTRACT.md` (94 indexes, 0 unclassified).

## 7. Backup and restore

* **Real backups: NOT VERIFIED.** No backup configuration exists in the repository and no provider is known. A policy in a document is not proof.
* **CODE VERIFIED (data model only):** `scripts/phase39/restore-rehearsal.mjs` creates synthetic data in a throwaway database, writes a logical dump, drops the database,
  restores into an empty one, and proves: every document identical (canonical hash per collection), every index rebuilt by the models with no migration, uniqueness
  enforced again, and a backend started on the restored database is healthy. **It does not prove any provider's backup** (`mongodump` is not installed here, no provider exists).
* Strongest required evidence (operator): BACKUP CREATED + RESTORE SUCCESSFUL on a copy, then the application started against the copy; retention stated; backups encrypted
  and access-controlled; a named owner; the restore order (MongoDB, AI service, Node).

## 8. HTTPS, CORS, trust proxy (CODE VERIFIED locally with a real backend process and synthetic origins; hosting layer NOT VERIFIED)

* CORS: the backend allows exactly one origin, `CLIENT_URL`, with credentials. A request from any other origin (or `Origin: null`) is never reflected or allowed: the response
  names only the configured origin, so a browser refuses the foreign origin. Protected APIs still require authentication whatever the origin (401). Do not broaden it.
* Trust proxy: OFF by default. With it off, rotating `X-Forwarded-For` does not change the rate-limit key (the anonymous limit tripped after the configured count even with a
  different forwarded address on every request). **With `KOI_TRUST_PROXY=1` and no proxy in front, the same rotation bypassed the limit entirely.** So `KOI_TRUST_PROXY` must equal
  the exact number of trusted proxy hops, and must stay unset if Node is reached directly. An unset value behind a proxy makes every client share the proxy's address.
* Request id: a caller-supplied value that is not a canonical uuid is replaced; none carries a secret.
* No cookies are used (the access token lives in memory only), so there is no cookie flag to verify.
* NOT VERIFIED (platform): HTTPS on the frontend and the backend, certificate validity, redirect from http, HSTS, the forwarded-header behaviour of the real proxy, and private
  transport for the AI service.

## 9. AI service network privacy

CODE VERIFIED facts that make isolation mandatory: the AI service has **no authentication, no middleware and no CORS configuration**, and exposes `POST /v1/intelligence/signal`,
`/v1/intelligence/analyze`, `/v1/embeddings`, `/v1/vector-similarity`, `/v1/knowledge-retrieval`, plus `GET /v1/health`, `/docs`, `/redoc` and `/openapi.json`. Anyone who can reach it can
spend Gemini quota with arbitrary context and bypasses Node authentication, authorization and tenant checks entirely. Isolation is therefore a network rule, not code:
**only the Node backend may open a connection to it.**

NOT VERIFIED (platform): no public route to the AI service; a private address in `AI_SERVICE_URL`; no browser-originated path; bind to a private interface; run without `--reload`;
optionally disable `/docs` at the proxy. If the platform exposes it publicly: **PRODUCTION BLOCKER - AI SERVICE NETWORK BOUNDARY.** (No code change was made: network isolation is the
preferred control, as agreed in earlier phases.)

## 10. Observability target

CODE VERIFIED: safe `[KOI EVENT]` lines on stdout (Phase 36/38). NOT VERIFIED - OPERATIONS BLOCKER: how the hosting target captures stdout, retention, access control, search, alerting
and dashboards. Required alerts (Phase 38 thresholds, INITIAL / TUNING REQUIRED; no production baseline exists): audit write failure (any), provider failures and timeouts, rejection
ratio, claim rule codes, authorization-denial bursts, governance rejections, unusual coalescing, restart loop, health. Verify by a drill: produce a harmless rejection (an unauthenticated
call) and confirm the event is searchable and an alert fires.

## 11. Single instance

NOT VERIFIED - DEPLOYMENT BLOCKER - SINGLE INSTANCE NOT VERIFIED. Operator must show on the real platform: replicas = 1, min = max = 1, no autoscaling, no second environment (staging,
preview, canary, old revision during a rolling deploy) connected to the production database, and a deploy strategy that stops the old instance before or immediately after the new one
serves (an overlap of minutes costs duplicate provider calls only; it never corrupts data).

## 12. Real-target smoke and failure injection

NOT VERIFIED - REAL TARGET SMOKE UNAVAILABLE (0 Gemini calls were made in this phase). A production smoke would need database writes (a workspace, a user, a membership, a Signal), which
are forbidden against a real database without explicit authorization. **Exact operation that would be needed**, if authorized later: in a STAGING copy (not production) create one throwaway
workspace, one user with one membership, and two synthetic Signals (one routine, one life-safety); call `POST /api/intelligence/analyze/<signalId>` once each (two real generation calls
maximum); record only metadata (model, model version if reported, latency, admission, confidence, ceiling, safety result, rule code); then delete the throwaway workspace through the
workspace-delete route. Failure injection (AI service down, bad provider config, MongoDB down, invalid token, malformed model output) belongs in that staging copy only; the local Phase 35-38 evidence
stands in the meantime and is **not** a substitute for it.

## 13. Frontend production build

CODE VERIFIED: `vite build` succeeds. Built twice into a scratch directory (the repository `dist/` was not touched): (a) exactly as configured on this machine, which bakes in the
loopback API origin and the development workspace id - correct for development, wrong for production; (b) with synthetic production-style values, which bakes in the intended HTTPS origin
and the OIDC authority/client id and nothing else. Scans of both (and of the stale ignored `dist/`) found no secret, connection string, credential-shaped string, development token or
debug logging (section 4). Operator must build with the production `VITE_*` values in the environment, run the preflight tool on the result, and configure the static host to serve
`index.html` for unknown paths (the app uses client-side routing; a deep link or refresh would otherwise 404).

## 14. Operator actions still required (in order)

1. Choose a hosting target and configure it; record it (this repository has none).
2. Pin the Node backend to exactly one instance; disable autoscaling and any second environment on the production database.
3. Put the AI service on a private network reachable only from Node; no public route; run it without `--reload`; set `AI_SERVICE_URL` to its private address.
4. Provision MongoDB with authentication, TLS and a network allow-list; set `MONGODB_URI` with a named database; confirm indexes built on first start.
5. Configure automated backups with a retention period; **take a backup and restore it into a copy; start the application against the copy.**
6. Register the SPA as a public PKCE client at the identity provider; set `OIDC_ISSUER`, `OIDC_AUDIENCE`, `VITE_OIDC_AUTHORITY`, `VITE_OIDC_CLIENT_ID`; provision the first users and memberships.
7. Put secrets in the platform's secret store: the Gemini key only in the AI service; none in Node; none in the frontend.
8. Set `NODE_ENV=production`, `LLM_PROVIDER=gemini` (Node and AI service), `LLM_MODEL=gemini-3.1-flash-lite`, `EMBEDDING_PROVIDER=gemini`, `CLIENT_URL` (https frontend origin),
   `KOI_TRUST_PROXY` (the exact hop count, or unset if direct); leave Learning, the forbidden variables and `KOI_EXPOSE_ERROR_DETAILS` unset.
9. Terminate HTTPS in front of the frontend and the backend; redirect http; serve `index.html` for unknown frontend paths.
10. Run `env-preflight.mjs` against the real files and the real build; fix every FAIL.
11. Collect backend stdout, retain it, search it, create the alerts from `PRODUCTION_OBSERVABILITY.md`, and run an alert drill.
12. Name an owner/on-call; write the deploy/rollback/restore runbook.
13. Run the staging smoke (section 12) with two real generation calls, then re-run `PRODUCTION_GO_NO_GO.md` Sections B and C.
