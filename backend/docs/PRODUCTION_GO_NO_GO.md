# Production GO / NO-GO (Phase 38)

**Decision: CONDITIONAL GO** - for a single-instance, monitored deployment, once every BLOCKING item in Sections B and C is verified by the people who own it.
The code is safe to deploy under the conditions below. **This repository does not and cannot prove that a deployment is ready**: it configures no hosting target,
no identity provider, no production database, no backups and no monitoring, and none of those was accessible. Those items are marked NOT VERIFIED and are not
PASS. The decision rules used:

* **GO** - every blocker is verified (code *and* deployment *and* operations).
* **CONDITIONAL GO** - the code is safe and verified, but external deployment/operations items are unverified. **<- this decision.**
* **NO-GO** - a broken security invariant, an unsafe-output bypass, broken tenant isolation, silent unsafe configuration, or a topology that violates the supported assumptions.
  No such condition was found: none of them is present in the code (Section A), and every unsafe configuration the code can detect refuses to start (A10).

Verification vocabulary: **CODE VERIFIED** (a test in the repository proves it), **DEPLOYMENT VERIFIED** (proved on the real target), **OPERATIONS VERIFIED**
(proved operationally). Status values: PASS, FAIL, NOT VERIFIED, NOT APPLICABLE. Owners: CODE, DEPLOYMENT, OPERATIONS. BLOCKING: whether going live without it is unsafe.

Supported topology: **one Node backend instance** (not horizontally scalable - see `DEPLOYMENT_TOPOLOGY_AND_RECOVERY_PHASE38.md`), any number of stateless AI-service
instances, one MongoDB, a static frontend. Model: `gemini-3.1-flash-lite` only; Learning OFF; no fallback model; no retry; no action execution.

## Section A - CODE READY (owner: CODE)

| ID | Item | STATUS | OWNER | BLOCKING | EVIDENCE |
|---|---|---|---|---|---|
| A1 | Tenant isolation on every tenant-owned read/write; cross-workspace access refused | PASS | CODE | YES | `validate-api.mjs`, Phase 13-19/22/23 suites, Phase 38 suite (cross-workspace rejection in the audit store) |
| A2 | Authentication and role-based authorization on every route | PASS | CODE | YES | `validate-phase19-route-inventory.mjs`, Phase 23 AZ group |
| A3 | OIDC verification: issuer, audience, signature, expiry, missing/invalid token, membership, role; unsafe OIDC config refuses to start | PASS | CODE | YES | `validate-phase23-oidc.mjs` (137 checks, local issuer/JWKS) + the nine named checks asserted by the Phase 38 suite |
| A4 | Admission pipeline fail-closed: schema, identity, claims, safety, prose, identifier, confidence cap; no partial persistence | PASS | CODE | YES | Phase 28/34C/34D/35/37 suites |
| A5 | Evidence/provenance validation intact (no weakening, no auto-repair) | PASS | CODE | YES | Phase 34C, Phase 38 reason-code tests |
| A6 | Safety independent of confidence; deterministic confidence ceiling | PASS | CODE | YES | Phase 34D/34D.1 suites |
| A7 | Governance: proposer is not reviewer; legacy records reviewable | PASS | CODE | YES | Phase 35 suite |
| A8 | Durable audit of every analysis attempt (metadata only, best-effort, workspace-scoped) | PASS | CODE | NO | Phase 35/36 suites; Phase 38 ruleCode on the audit row |
| A9 | Stable non-sensitive claim-validation reason codes, one per rule, end to end (validator -> HTTP -> audit -> event; Python `rule`) | PASS | CODE | NO | Phase 38 suite section A; `ai-service/tests/test_claim_rule_codes.py` |
| A10 | Start-up refuses unsafe configuration (Node: test provider, unrecognised provider, AI URL, timeout budget, auth, **database name**; Python: model, timeout, providers, key) | PASS | CODE | YES | Phase 36 B1-B7, Phase 38 suite section B, `test_startup_matrix.py` |
| A11 | Model pinned to `gemini-3.1-flash-lite`; no alias/preview/latest; no fallback; no retry; no tools/function calling | PASS | CODE | YES | Phase 33 static guard, Phase 34 provider-policy suite, Python startup matrix |
| A12 | Learning OFF by default and recorded in the audit row when used | PASS | CODE | YES | Phase 32/35 suites, start-up warning, rehearsal |
| A13 | Request deadline/timeout budget enforced at run time; cross-service ceiling | PASS | CODE | YES | Phase 35.1 suite |
| A14 | Idempotency: one stored analysis per (workspace, Signal, level) even across processes; process-local single-flight; production warning | PASS | CODE | YES | Phase 37 C1-C3 (two real processes), Phase 36 warning test |
| A15 | Failure behaviour: Mongo down, AI down, Gemini timeout/malformed, retrieval deadline, audit write failure, bad OIDC/provider config - fail closed, no stuck state | PASS | CODE | YES | Phase 35.1/36/37 suites; Phase 38 rehearsal table (`DEPLOYMENT_TOPOLOGY_AND_RECOVERY_PHASE38.md` section 5) |
| A16 | Structured events and logs contain no prompts, outputs, claim/evidence/Signal text, ids, tokens or keys | PASS | CODE | YES | Phase 36 A14-A16, Phase 37 observer guard, Phase 38 suite |
| A17 | No destructive operation at start-up; index creation is the only schema work and needs no migration; every collection has a classified index | PASS | CODE | YES | `scripts/phase38/index-inventory.mjs` (94 indexes, 0 unclassified), Phase 38 static checks |
| A18 | Environment contract complete (every variable the code reads is classified) | PASS | CODE | NO | `PRODUCTION_ENVIRONMENT_CONTRACT.md` + Phase 38 completeness test |
| A19 | Test/fixture lifecycle leaves no residue; baseline unchanged | PASS | CODE | NO | `authFixtures.mjs`, Phase 35/37/38 baseline checks |
| A20 | Reliability evidence on the real model | PASS (small sample) | CODE | NO | Phase 37 real sample: 12 production-path calls (4 scenarios x 3), 1 rejected at the claim stage (rule not diagnosable then), no validator bypass. Phase 38 added 2 calls: A (normal) admitted; B (life safety) rejected at the claim stage with `CLAIM_INVALID_FACT_SUPPORT` (a FACT claim resting only on the untrusted Signal text), fail-closed, nothing stored, request id correlated. Smoke evidence, not a rate |

## Section B - DEPLOYMENT READY (owner: DEPLOYMENT)

None of these can be verified from the repository. They are the exact external configuration still required.

| ID | Item | STATUS | OWNER | BLOCKING | EVIDENCE |
|---|---|---|---|---|---|
| B1 | A hosting platform is chosen and configured for the frontend, backend and AI service | NOT VERIFIED | DEPLOYMENT | YES | the repository contains no deployment manifest of any kind |
| B2 | The backend is pinned to exactly one instance; no autoscaling/rolling overlap that runs two at once for long | NOT VERIFIED | DEPLOYMENT | YES | single-instance invariant documented; code can only warn |
| B3 | Production environment variables set exactly per `PRODUCTION_ENVIRONMENT_CONTRACT.md` (NODE_ENV=production, AUTH_PROVIDER=oidc, LLM_PROVIDER=gemini on Node and on the AI service, AI_SERVICE_URL, MONGODB_URI, CLIENT_URL, ...) | NOT VERIFIED | DEPLOYMENT | YES | contract exists; no target to inspect |
| B4 | Real OIDC provider: issuer, audience, JWKS reachable from the backend, client registration, redirect URIs; a real sign-in rehearsed end to end | NOT VERIFIED | DEPLOYMENT | YES | only a local test issuer was exercised |
| B5 | Production MongoDB: authentication, TLS, network allow-list, least-privilege user, named database | NOT VERIFIED | DEPLOYMENT | YES | code refuses a missing database name and warns on missing credentials/TLS |
| B6 | AI service deployed with `GEMINI_API_KEY` (secret store), `EMBEDDING_PROVIDER=gemini`, `LLM_PROVIDER=gemini`, exact model; reachable only from the backend (it has no authentication of its own) | NOT VERIFIED | DEPLOYMENT | YES | the AI service enforces model/provider/key at start-up; it cannot enforce network exposure or an embedding provider appropriate to production |
| B7 | `CLIENT_URL` set to the real frontend origin (the default is the development origin); `KOI_TRUST_PROXY` set correctly behind the proxy | NOT VERIFIED | DEPLOYMENT | YES | contract |
| B8 | HTTPS termination in front of the backend and frontend | NOT VERIFIED | DEPLOYMENT | YES | not a repository concern |
| B9 | Frontend built with the production `VITE_*` values (no development token flow) | NOT VERIFIED | DEPLOYMENT | YES | contract section 3 |
| B10 | First users, identities and workspace memberships provisioned by a controlled procedure | NOT VERIFIED | DEPLOYMENT | YES | only development provisioning scripts exist |
| B11 | Secrets are held in a secret store, never in the repository or image | NOT VERIFIED | DEPLOYMENT | YES | the repository holds no secret (scan in the final report) |
| B12 | The smoke test (final report) re-run on the real target, including one real analysis | NOT VERIFIED | DEPLOYMENT | YES | the same steps were rehearsed on an isolated local stack (next row) |
| B13 | Production-like rehearsal on an isolated stack: start-up, auth, import, analysis, review, audit, events, tenant isolation, cleanup | PASS (local only) | DEPLOYMENT | NO | `phase37/deployment-rehearsal.mjs` (24 checks) + the Phase 38 smoke run |

## Section C - OPERATIONS READY (owner: OPERATIONS)

No item in this section is marked PASS: nothing operational is configured or accessible.

| ID | Item | STATUS | OWNER | BLOCKING | EVIDENCE |
|---|---|---|---|---|---|
| C1 | Automated MongoDB backups with a stated retention, encrypted, access-controlled | NOT VERIFIED | OPERATIONS | YES | no backup configuration exists in the repository |
| C2 | A restore has been tested on a copy and the application starts and serves from it | NOT VERIFIED | OPERATIONS | YES | code-side assumptions only (`DEPLOYMENT_TOPOLOGY_AND_RECOVERY_PHASE38.md` section 4) |
| C3 | Backend stdout is collected, retained and searchable | NOT VERIFIED | OPERATIONS | YES | the backend only writes to stdout |
| C4 | Alerts created for the events in `PRODUCTION_OBSERVABILITY.md` (at minimum: audit write failure, provider failures, rejection ratio, 401/403 bursts, restart loop, health) and thresholds tuned from real traffic | NOT VERIFIED | OPERATIONS | YES | thresholds are INITIAL / TUNING REQUIRED |
| C5 | A named owner/on-call and an escalation path | NOT VERIFIED | OPERATIONS | YES | organisational; nothing in the repository can show it |
| C6 | Gemini quota, billing and key-rotation procedure; budget alert | NOT VERIFIED | OPERATIONS | NO | external provider account; not accessible |
| C7 | A written deploy / rollback / restore runbook (restore order: MongoDB, AI service, backend) | NOT VERIFIED | OPERATIONS | YES | the failure/recovery table and checklists are documented; adoption is operational |
| C8 | A procedure for reading the audit trail (there is deliberately no HTTP route for it yet) | NOT VERIFIED | OPERATIONS | NO | `listAnalysisAdmissions` is a service function |
| C9 | Log retention sized for the rare audit-write-failure case (the log line is its only trace) | NOT VERIFIED | OPERATIONS | NO | `analysis.audit_write_failed` is logged, not stored; retention is a platform setting |

## Remaining risks that stay open under CONDITIONAL GO

1. Everything in Sections B and C (all external, all NOT VERIFIED).
2. Horizontal scaling of the backend is not supported; breaking it costs duplicate Gemini calls and multiplied rate limits, not correctness.
3. Model quality is sampled, not measured: 14 real calls in total are not a rate; thresholds are INITIAL / TUNING REQUIRED. **Observed availability risk:** the life-safety scenario was rejected at the claim stage in both samples that reported it (Phase 37 once, Phase 38 once, the latter diagnosed as `CLAIM_INVALID_FACT_SUPPORT`). This is the validator working as designed (fail closed, nothing stored, the caller gets a 502 and may retry), not a safety defect - but for the highest-urgency Signals it can mean no analysis on a given attempt, so the operators must not treat the analysis as a guaranteed answer. Prompt/model tuning is explicitly out of scope for this phase and was not attempted.
4. The real identity provider has never been exercised.
5. The AI service has no authentication of its own and no embedding-provider production gate: network isolation and `EMBEDDING_PROVIDER=gemini` are deployment duties.

## What turns CONDITIONAL GO into GO

Every BLOCKING item above verified on the real target by its owner, including a restore test (C2), alerts firing in a drill (C4), and one real analysis on the production
stack (B12).

## Phase 39 - real deployment preflight (added; Phase 38 evidence above is unchanged)

Detail and the ordered operator actions: `DEPLOYMENT_PREFLIGHT_PHASE39.md`. **No deployment target is configured in the repository and none was supplied, so no external control could be
verified.** Classes used: CODE VERIFIED, DEPLOYMENT VERIFIED, OPERATIONS VERIFIED, NOT VERIFIED, BLOCKER (a known blocking fact, as opposed to an unknown). Nothing external is DEPLOYMENT VERIFIED
or OPERATIONS VERIFIED. A BLOCKER marked "(violated)" would make the decision NO-GO; none is.

| ID | Item | Verification class | BLOCKING | Evidence |
|---|---|---|---|---|
| P39-1 | A deployment target exists and is configured | BLOCKER | YES | repository search: no deployment configuration of any kind; target verdicts all UNKNOWN |
| P39-2 | Node runs as exactly one replica, no autoscaling, no second environment on the production database | NOT VERIFIED | YES | DEPLOYMENT BLOCKER - SINGLE INSTANCE NOT VERIFIED; code only warns |
| P39-3 | The AI service is private (only Node can reach it) and not publicly routed | NOT VERIFIED | YES | it has no authentication, no CORS and 5 POST endpoints that spend Gemini quota (CODE VERIFIED facts); the control is a network rule |
| P39-4 | MongoDB is not open to the internet; authentication and TLS on | NOT VERIFIED | YES | only a local unauthenticated development instance was reachable |
| P39-5 | Environment preflight tool: judges backend, AI service, frontend and built bundle without printing a value | CODE VERIFIED | NO | `validate-phase39-preflight.mjs`: a passing synthetic production set and one failing mutation per rule |
| P39-6 | The REAL production environment passes the preflight | NOT VERIFIED | YES | no production environment was supplied; local development files fail 10 checks, as expected |
| P39-7 | Secret exposure review (repository, git history, built bundles, start-up output) | CODE VERIFIED | NO | no secret found in tracked files, in any commit, or in either built bundle; the two Gemini keys exist only in their ignored `.env` files |
| P39-8 | Node holds no Gemini or OpenAI key in production (least privilege) | NOT VERIFIED | YES | finding: a Gemini key sits in the local `backend/.env` although Node never uses one; the preflight FAILs it |
| P39-9 | Secrets are held in the platform's secret store | NOT VERIFIED | YES | no platform |
| P39-10 | Real OIDC provider: issuer, audience, JWKS, PKCE client, redirect URI, first sign-in | NOT VERIFIED | YES | REAL OIDC TARGET UNAVAILABLE; verification logic is CODE VERIFIED (Phase 23) |
| P39-11 | Production frontend OIDC variables set at build time | NOT VERIFIED | YES | local `frontend/.env` has none; the preflight FAILs their absence |
| P39-12 | Real MongoDB: expected database name, authentication, TLS, indexes, no development database | NOT VERIFIED | YES | REAL MONGODB TARGET UNAVAILABLE; start-up refuses a missing database name (CODE VERIFIED) |
| P39-13 | Provider backups exist, with retention, encryption and access control | NOT VERIFIED | YES | OPERATIONS item; no backup configuration exists in the repository |
| P39-14 | A real backup was restored into a copy and the application served from it | NOT VERIFIED | YES | strongest required evidence: BACKUP CREATED + RESTORE SUCCESSFUL |
| P39-15 | The data model survives a logical backup and restore (isolated, synthetic) | CODE VERIFIED | NO | `phase39/restore-rehearsal.mjs`: identical content, indexes rebuilt, uniqueness enforced, backend healthy on the restored copy; proves nothing about any provider |
| P39-16 | CORS allows exactly one origin, never reflects another, still requires authentication | CODE VERIFIED | NO | live probe of a real backend process with synthetic origins |
| P39-17 | `CLIENT_URL` is the real HTTPS frontend origin | NOT VERIFIED | YES | default is the development origin; the preflight FAILs it |
| P39-18 | Forwarded headers cannot spoof the rate-limit key (trust proxy off by default) | CODE VERIFIED | NO | live probe; with `KOI_TRUST_PROXY=1` and no proxy the limit WAS bypassed, so the value must be exact |
| P39-19 | `KOI_TRUST_PROXY` equals the real number of proxy hops | NOT VERIFIED | YES | needs the real proxy chain |
| P39-20 | HTTPS terminates in front of frontend and backend; http redirects; AI-service transport is private | NOT VERIFIED | YES | platform |
| P39-21 | Backend stdout is collected, retained, searchable (log shipping) | NOT VERIFIED | YES | OPERATIONS BLOCKER until configured; the events themselves are CODE VERIFIED |
| P39-22 | Alerts for the Phase 38 events exist and fired in a drill | NOT VERIFIED | YES | OPERATIONS BLOCKER until configured; thresholds are INITIAL / TUNING REQUIRED |
| P39-23 | Claim reason codes: deterministic, stable, content-free, audit/event/HTTP-safe, unsafe codes dropped, validator unchanged | CODE VERIFIED | NO | Phase 38 suite re-run in this phase (79 checks) and Python rule-code tests |
| P39-24 | Frontend production build succeeds; no secret, no development token, no debug logging, correct API origin when configured | CODE VERIFIED | NO | built twice to a scratch directory and scanned; the as-configured build bakes in the loopback origin (development only) |
| P39-25 | A production build is made with production values and passes the preflight | NOT VERIFIED | YES | needs the real values and the real host (which must also serve `index.html` for unknown paths) |
| P39-26 | Real-target smoke: two real generation calls on synthetic data | NOT VERIFIED | YES | REAL TARGET SMOKE UNAVAILABLE; 0 Gemini calls this phase; would need staging writes (see the preflight document) |
| P39-27 | Real-target failure injection (AI down, bad provider, Mongo down, bad auth, malformed output) in staging | NOT VERIFIED | YES | no staging; local Phase 35-38 evidence stands and is not a substitute |
| P39-28 | The AI service's `/docs`, `/redoc`, `/openapi.json` are not publicly reachable | NOT VERIFIED | NO | follows from P39-3 |
| P39-29 | Local development files carry the stale not-approved `LLM_MODEL`; a copied file fails closed | CODE VERIFIED | NO | the AI service refuses to start with it when its provider is `gemini`; the preflight FAILs it |
| P39-30 | Immutability: Phase 33/33-Lite, historical manifests and hashes, `.claude`, `CLAUDE.md` unchanged | CODE VERIFIED | NO | checked at the end of this phase (see the report) |

**Phase 39 decision: CONDITIONAL GO**

The code is safe and verified, and no security invariant was found violated: no secret is exposed, tenant isolation and fail-closed behaviour are intact, CORS and forwarded-header handling behave as designed.
But every deployment and operations control is NOT VERIFIED and one is a known BLOCKER (no deployment target exists). It becomes GO only when the owners of Sections B and C above and of P39-1 to P39-27
have verified their items on the real target. It becomes NO-GO if any of these is found violated on the real target: the AI service publicly reachable, the Node backend able to run as more than one
instance, a secret exposed, or an unsafe OIDC or MongoDB configuration.
