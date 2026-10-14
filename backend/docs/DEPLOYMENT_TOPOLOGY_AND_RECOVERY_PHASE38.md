# Phase 38 - Deployment topology, OIDC, backup and failure/recovery

Evidence labels used throughout: **CODE VERIFIED** (a test in this repository proves it), **DEPLOYMENT VERIFIED** (proved against the actual deployment target),
**OPERATIONS VERIFIED** (proved operationally: backups, alerting, runbooks). **Nothing in this document is DEPLOYMENT or OPERATIONS VERIFIED**: there is no
deployment target in the repository and none was accessible.

## 1. Actual deployment topology

**Finding: the repository configures no deployment target at all.** Searched, whole tree, excluding `node_modules`/`.venv`/`.git`: no Dockerfile, compose file, `Procfile`,
`render.yaml`, `vercel.json`, `netlify.toml`, `fly.toml`, `app.yaml`, process-manager (`ecosystem.config.*`, `*.service`), reverse-proxy, Kubernetes/Helm/Terraform,
serverless, or CI/CD definition (`.github`, GitLab, Jenkins, Azure, Cloud Build). `backend/package.json` has only `dev` (nodemon) and `start` (`node server.js`); the frontend has
`dev`/`build`/`preview`; the AI service is documented as `uvicorn app.main:app --port 8000`. No documentation names a hosting platform. **Nothing was invented; a platform
must be chosen and configured outside this repository.**

| Question | Answer from the repository |
|---|---|
| A. Where does the React/Vite frontend run? | Not configured. It builds to static files (`vite build`) that any static host can serve; backend origin from `VITE_API_BASE_URL`. |
| B. Where does the Node/Express backend run? | Not configured. `node server.js`, port from `PORT`. |
| C. Where does the Python AI service run? | Not configured. `uvicorn app.main:app`, documented on port 8000; reached only by Node over `AI_SERVICE_URL`. |
| D. How is MongoDB reached? | One `MONGODB_URI` (database name required in production). Standalone or replica set both work; transactions are used only on a replica set. |
| E. Is the backend expected to run as exactly one instance? | **Yes** - the only supported topology (Phase 37): analysis single-flight and rate limits are process-local. |
| F. May the AI service have several instances? | Yes. It is stateless (no database, no tenant knowledge, no shared state); each instance enforces its own startup gates. Node is its only caller. |
| G. Does any platform auto-scale Node? | None is configured, so none can. **If the chosen platform autoscales or runs more than one replica of the backend, that is a production blocker** until scaling is pinned to 1. |

**SUPPORTED:** a single Node backend instance (plus any number of AI-service instances, one MongoDB, one frontend build).
**NOT SUPPORTED:** horizontal scaling of the Node backend.
**Consequence if violated:** two instances can both pass the "already analysed?" check for the same Signal and **both call Gemini** (extra provider spend; the second
call writes no accepted audit row). Data stays correct - the unique `(workspace, Signal, level)` index keeps one stored analysis (proved with two real processes, Phase 37 C2) -
and per-instance rate limits multiply. The repository cannot enforce the instance count; it **warns at production start-up** (`Analysis single-flight is PROCESS-LOCAL ...`),
and the pin to one replica must be set on the hosting platform (see the checklist in `PRODUCTION_GO_NO_GO.md`).

## 2. OIDC production readiness

**CODE VERIFIED** by `validate-phase23-oidc.mjs` (137 checks: real RS256/ES256 signatures against a local issuer and JWKS; no external provider) and re-run by
`validate-phase38-deployment-readiness.mjs`, which asserts the specific checks below pass:

| Requirement | Evidence (check ids in the Phase 23 suite) |
|---|---|
| missing issuer / missing audience configuration | CF7; production refuses to start: EV1, EV4 |
| malformed / non-https issuer | CF8, CF9; EV3 |
| wrong issuer (incl. trailing slash) | IA "wrong issuer", IA "issuer with a trailing slash" |
| wrong audience, missing audience, audience array without it | IA "wrong audience", "audience array ...", "missing audience" |
| invalid token (malformed, tampered, bad signature, alg none, algorithm confusion, unknown kid) | IA group |
| missing token | IA "missing token" (401 `MISSING_CREDENTIAL`) |
| expired token | VA4, IA "expired token" (`exp` enforced strictly) |
| valid token but no workspace membership | ID1-ID3 (authenticated, 404 on every workspace), ID11 (revoked membership) |
| valid membership, insufficient role | AZ group (viewer/operator/reviewer/admin matrix, 403) |
| provider failure fails closed | PF group (503, never 200), EV7 |
| tenant isolation | AZ cross-workspace and object-level checks |

**NOT YET VERIFIED:** the real identity provider. No production issuer, audience, JWKS or client registration was accessible, so the real discovery document, key rotation
behaviour, token lifetimes, the frontend's PKCE sign-in against it, and the first-login/provisioning flow for real users are untested. Repository tests do not prove the real
provider configuration. Identities are not auto-provisioned (an unknown identity is authenticated but has no access); an operator must provision users and memberships
(`scripts/provision-dev-identity.mjs` is a development tool; a production provisioning procedure is an **operations** deliverable).

## 3. MongoDB readiness

* **CODE VERIFIED:** the connection string must name a database in production (refuses to start otherwise); credentials/TLS absence is warned; indexes are created on first use on
  an empty database with no migration (inventory in `PRODUCTION_ENVIRONMENT_CONTRACT.md`, built on a throwaway database in the test); every tenant-owned collection has
  workspace-prefixed indexes; `Unit` and `Message` resolve scope through `Property` / `Conversation` by design; the application contains no development-only database artifact (no
  hard-coded database or collection name) and no destructive startup operation; legacy documents without the Phase 35/37/38 fields remain readable; workspace deletion removes all
  tenant-scoped data including audit rows (Phase 22/36).
* **NOT VERIFIED (deployment):** the actual production MongoDB (authentication enabled, TLS, network allow-list, replica set or standalone, sizing).

## 4. Backup / restore

The repository contains **no backup configuration and cannot prove one exists.**

* **CODE VERIFIED (code-side assumptions):** all state is durable in MongoDB (nothing important lives only in process memory except rate-limit counters, the audit-failure counter
  and the in-flight map, all rebuildable); the application never deletes data on startup; deletion is explicit (workspace delete requires `confirm: <slug>`); indexes rebuild
  automatically after a restore; a restored database needs no migration.
* **NOT VERIFIED - EXTERNAL OPERATIONAL REQUIREMENT:** automated backups; retention period; **a restore test** (an unrestored backup is not a backup); backup encryption; access
  control to backups; a named recovery owner; a written recovery procedure including the order (restore MongoDB -> start AI service -> start Node) and what to check
  (`/api/health`, a read of a known workspace). Point-in-time recovery needs a replica set (oplog) on a self-managed deployment, or a managed offering that provides it.

## 5. Failure and recovery rehearsal

All rows are CODE VERIFIED with deterministic stubs and real processes (Phase 35.1/36/37 suites, re-run in the final matrix); nothing real was broken.
"Audit/event" = the durable audit row and the `[KOI EVENT]` line. In every row: no fallback model, no retry, no stuck single-flight entry, no accepted audit row for a failed
attempt, no cross-tenant leakage (Phase 35 C15-C18, Phase 36 E4 and G6).

| Failure (input) | Expected HTTP result | Model call? | Persistence? | Audit / event | Recovery |
|---|---|---|---|---|---|
| A. MongoDB unavailable | 500 `Internal server error` (generic; no driver text) | no | none (no partial Intelligence) | request fails before an attempt exists: no row; server-side 5xx log only | next request succeeds once the database is reachable (Phase 36 D1, D2) |
| B. AI service unavailable | 502 `AI_SERVICE_UNREACHABLE` | no (nothing answered); exactly one connection attempt | none | row `decidedAt: provider`, class `provider_unavailable`; `analysis.rejected` | caller retries later; no retry/fallback (D4) |
| C. Gemini provider timeout | 504 `PROVIDER_TIMEOUT` (AI service) or `AI_SERVICE_TIMEOUT` (Node, 25 s) | one | none | row class `provider_timeout`; `analysis.rejected` | caller retries; bounded by the deadline (D5, D6) |
| D. Malformed Gemini output | 502 `MALFORMED_RESPONSE` (+ `rule`, e.g. `CLAIM_MISSING_SOURCE_REFS`), `ANALYSIS_SCHEMA_INVALID`, or `CLAIM_VALIDATION_FAILED` (+ `rule`) | one | none; no Decision/Action | row with `decidedAt`, `reasonCode`, `ruleCode`; `analysis.rejected` | caller repeats the request (D8, Phase 38 A) |
| E. Retrieval deadline exhausted | 504 (`AI_SERVICE_TIMEOUT` / `KNOWLEDGE_RETRIEVAL_BUDGET_EXHAUSTED`) | no | none | row `decidedAt: retrieval`, class `provider_timeout` | caller retries; retrieval budget 85 s of the 110 s deadline (Phase 35 A24, Phase 36 D7) |
| F. Audit write failure | normal success (201/200) | one | analysis stored | no accepted row for that attempt; `analysis.audit_write_failed`; counter | none needed; the event is the signal (Phase 36 A11, D10) |
| G. Invalid OIDC configuration | production: **process refuses to start** (exit 1); elsewhere every authenticated request 503 `AUTH_NOT_CONFIGURED` | no | none | startup message (no value) | fix configuration, restart (Phase 23 EV1-EV7; rehearsal R10) |
| H. Invalid provider configuration | **Node or AI service refuses to start** (exit 1) | no | none | startup message (no secret) | fix configuration, restart (Phase 36 B4-B7; rehearsal R9, R10) |
