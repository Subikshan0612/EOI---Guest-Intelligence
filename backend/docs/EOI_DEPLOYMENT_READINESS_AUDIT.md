# EOI — Production Deployment Readiness Audit

Date: 2026-10-14. Target topology under audit: **Vercel (frontend) → Render (Node backend) → Render private service (Python AI service) → MongoDB Atlas, and Gemini behind the AI service**, with SMTP and Google OAuth.

**Nothing was deployed, created, committed, pushed or changed to write this audit.** The only repository change is this file. No production code, test, prompt, configuration, `.claude/`, `CLAUDE.md` or `.env` file was modified. No Gemini call and no write to any external system was made.

## 1. Verdict

| | |
|---|---|
| **Staging** | **NOT READY — blocked** by the items in section 6. None of them is a large engineering task; the application code itself is in good condition (section 3). The blockers are: the release is not committed, one critical dependency advisory, a Python dependency mismatch, three configuration traps, and every external system not existing yet. |
| **Production** | **NOT READY — blocked.** Everything in the staging list, plus backups with a proven restore, alerting, a rollback runbook, a cookie/domain decision, SPA security headers, SMTP delivery proof and the policy decisions in section 7. |

The earlier decision (Phases 38/39) was **CONDITIONAL GO** for "a single-instance, monitored deployment once the external items are verified". That statement still holds for the *code*, but this audit finds that the *repository state* no longer supports it: the code that was verified is not the code that git contains.

## 2. Classification vocabulary and method

- **VERIFIED** — demonstrated in this audit from the repository, the local environment, a test run, or a read-only query of an external account.
- **UNVERIFIED** — not demonstrated: it needs a system that does not exist yet, an owner's action, or a test on the real target. Not a claim that it is broken.
- **BLOCKED** — a known defect, missing prerequisite or undecided choice that prevents the item from being satisfied as things stand.
- **NOT APPLICABLE** — does not apply to this topology or is switched off by design.

Method (all read-only): read the previous readiness reports (Phases 36–41, 51, 5A–5D, the Core Acceptance Test, the safety hardening reports and the environment contract); read the code that enforces startup, CORS, cookies, rate limits, headers, health, timeouts, email and the AI service; ran the repository's own environment preflight on the local env files (variable names and verdicts only, no values read out); scanned all 1,227 committable files, the built bundle and git history for secrets; ran `npm audit`; ran the AI-service unit tests (531 passed); read the last full backend sweep; ran one isolated CORS experiment outside the repository; listed Render, Vercel and Atlas accounts through their read-only connectors.

External account findings (read-only listings):

- **Render:** one workspace ("My Workspace"), **zero services**.
- **Vercel:** no team; 5 personal projects (`blendlab.io`, `healthcare-app`, `hrms-demo`, `subikshan-ramachandran`, `subikshan-mac-os-portfolio`); **none is EOI**.
- **Atlas:** the connector reports **MCP access is disabled for the organization**, so clusters, users, network access and backups could not be inspected (the same limit Phase 41.1 recorded). The local `backend/.env` holds an Atlas `mongodb+srv` URI with credentials and a named database (shape only was read).

## 3. What still stands from the earlier reports

The Phase 38 Section A "code ready" items remain CODE VERIFIED by the current sweep: tenant isolation, authentication and roles, OIDC verification, fail-closed admission, safety independent of confidence, fail-closed startup (database name, providers, AI URL, timeouts, SMTP, https `CLIENT_URL`), no secret or prompt text in logs, no destructive startup, model pinned, Learning OFF. Since then the code gained the 5A–5C analysis-attempt lifecycle, the safety hardening, recurrence and `SAFETY_REVIEW_REQUIRED`; their suites pass. Latest results: **68 of 100 backend suites exit 0**; the 32 others are the same failures and counts as the Phase 5C baseline (live-stack or real-provider suites, stale expectations, shared-database baseline checks); AI service **531 passed**; frontend build succeeds; an end-to-end run with real Gemini on an isolated stack passed on this machine today.

What changed against the previous readiness position:

| Previous statement | Today |
|---|---|
| "No deployment manifest of any kind" (Phase 38/39) | `frontend/vercel.json` now exists (SPA rewrite only). The Phase 38 suite check D5 that asserts "no deployment target" therefore fails; the topology document is out of date on this point. Nothing for Render exists. |
| "Single backend instance only" | Still the supported topology. Since 5A an overlapping instance (for example during a deploy) is handled safely for analysis correctness by durable attempt markers and the unique index; rate limits stay process-local. |
| Environment contract: index count 94 | Atlas document (Phase 41) still says 84; the contract is current. Cosmetic. |
| "The code under review is the code in the repository" (implicit) | **Not true** — see A1/A2. |

## 4. New or sharpened findings (not in the earlier reports)

1. **The release candidate does not exist in git.** HEAD is `d94287f`; `origin/main` is `6c0db8e` and is 4 commits behind HEAD. There are **378 uncommitted entries (124 modified, 27 deleted, 227 untracked)**. `backend/src/auth` has 0 tracked files (14 exist), `backend/docs` 0 of 55, `backend/scripts` 24 tracked of 506. The sign-in, sessions, analysis attempts, safety policy, recurrence and every readiness document exist only in the working tree. A GitHub-connected Vercel or Render deploy would build a much older application.
2. **Critical advisory in a production dependency:** `proxy-addr` 1.1.0–2.0.7 (client-IP spoofing via an IPv4-mapped IPv6 trust subnet), used by Express to derive the client address that rate limiting keys on. A non-breaking fix exists (`npm audit fix`). The code uses a numeric hop count rather than a subnet, so exploitability is probably limited, but it should not ship. Three moderate advisories sit in `mammoth` → `argparse` → `sprintf-js` (denial of service in the document-upload parser; the only fix offered is a breaking downgrade, so this needs a decision).
3. **AI-service dependency mismatch:** `ai-service/requirements.txt` pins `pydantic==2.10.4` but the tested virtual environment runs `pydantic 2.13.5` (and `pydantic_core 2.46.5`). A fresh Render install would run different versions from the ones the 531 tests passed on. `pytest` is also in the runtime requirements. No Python version is pinned.
4. **CORS trailing-slash trap (proved in an isolated experiment):** `CLIENT_URL=https://x.example/` is accepted by every startup check and by the cookie origin check (which normalises), but CORS then answers `Access-Control-Allow-Origin: https://x.example/`, which never equals the browser's `Origin: https://x.example`, so every browser call fails. The preflight tool does not check for it.
5. **Cross-site cookie risk:** with default hostnames the frontend (`*.vercel.app`) and API (`*.onrender.com`) are different sites. The refresh cookie then needs `KOI_COOKIE_SAMESITE=none` and is a third-party cookie, which several browsers restrict. The access token lives 10 minutes, so where the cookie is refused people would be signed out about every 10 minutes. The safe design is two sibling subdomains of one registrable domain (same site, `SameSite=Lax`). This is a topology decision, not a code defect.
6. **Rate limiting depends on `KOI_TRUST_PROXY`.** Unset behind Render's proxy, every user shares one address key: the unauthenticated limit (60/min, which includes `/api/auth/refresh` and the platform health probe) and the 900/min address limit become global. Set too high, forwarded headers can be spoofed (Phase 39 proved the bypass). The exact hop count is only knowable on the target.
7. **Node keep-alive default is 5 s** (`KOI_KEEPALIVE_TIMEOUT_MS`). Load balancers commonly idle longer than that, which produces sporadic 502s on reused connections. Must be tuned above the platform's idle timeout (and `KOI_HEADERS_TIMEOUT_MS` must stay above it).
8. **The SPA is served with no security headers.** `vercel.json` defines none and `index.html` has no CSP. The API sets strict headers, but the page that hosts the approve/reject buttons has no frame protection, CSP or `nosniff`.
9. **SMTP is mandatory to boot in production.** With `AUTH_PROVIDER=eoi` the server refuses to start without a complete SMTP configuration and an https `CLIENT_URL`. No SMTP variable exists anywhere today (local uses the development outbox). The code supports SMTP only (no HTTP email API). If the chosen Render plan restricts outbound SMTP ports, the backend cannot send mail at all. (Render's SMTP policy is a platform fact that must be confirmed against current Render documentation before choosing a plan; it was not verified here.)
10. **Self-registration is on locally** (`KOI_SELF_REGISTRATION=true`). In production that lets anyone who can authenticate create a tenant and spend Gemini budget. There is no per-day spend cap in the application (limits are per minute: 10 AI requests per identity, 30 per workspace), so the budget cap must be set at Google.
11. **Rollback has data-compatibility edges.** Records written with `SAFETY_REVIEW_REQUIRED` are dropped from the safety view by the previous build (an unknown state hides the whole safety object) and shown as "not recognised" by the previous page; builds older than the safety hardening do not store the rule codes that enforce the refusal restriction. The first deployment has no earlier release to roll back to at all.
12. **Readiness-related test failures to resolve before using the suite as a gate:** Phase 38 D5 (stale, see section 3); Phase 41 C3 (synthetic fixtures not on its allow-list); Phase 41 C6 — the real Atlas **password and user were searched for**: the password appears in no file, no bundle and no commit; the **user name** appears once, in a comment in the untracked script `backend/scripts/phase41/atlas-learning-replay-readonly.mjs`; Phase 45B.2.2 G4 (its pattern list contains `accounts.google.com`, the configured public Google authority, which is in the current build).
13. **Local development currently points at an Atlas cluster**, not a local database. The test harness refuses non-loopback databases, but developer scripts and the dev server write there. Staging must have its own database and its own user.

## 5. Item-by-item audit

"Needed before": **S** = before staging, **P** = before production, **—** = nothing required.

### A. Release and source

| ID | Item | Class | Evidence / reason | Before |
|---|---|---|---|---|
| A1 | The code to deploy is committed | BLOCKED | 378 uncommitted entries; HEAD lacks `backend/src/auth` (0/14), `backend/docs`, most scripts | S |
| A2 | The release is on the remote branch the platforms deploy from | BLOCKED | `origin/main` = 6c0db8e (2026-09-24); HEAD 4 ahead and unpushed | S |
| A3 | A named release candidate (commit/tag) with a recorded test baseline | UNVERIFIED | none exists | S |
| A4 | No secret in any committable file, bundle or history | VERIFIED | 1,227 files scanned; hits are synthetic fixtures on `.invalid`/`example` hosts; Atlas password absent everywhere; bundle has no client secret, key or token | — |
| A5 | `.env` files ignored, only `.env.example` tracked | VERIFIED | `git check-ignore`, `git ls-files` | — |
| A6 | Atlas DB user name appears in a comment of an untracked script | BLOCKED | `atlas-learning-replay-readonly.mjs` line 8; fails Phase 41 C6; remove before commit | S |
| A7 | The 227 untracked files are reviewed for what should ship (scratch outputs, model outputs, evaluation artefacts) | UNVERIFIED | not reviewed here | S |

### B. Vercel frontend

| ID | Item | Class | Evidence / reason | Before |
|---|---|---|---|---|
| B1 | A Vercel project for EOI exists | UNVERIFIED | none of 5 projects is EOI | S |
| B2 | SPA fallback for client routes | VERIFIED | `frontend/vercel.json` rewrites everything except `/api/` and `/assets/` to `index.html` | — |
| B3 | Build settings (root `frontend`, `npm run build`, output `dist`, Node version) | UNVERIFIED | local build succeeds (2,016 modules, ~5 s); settings not made | S |
| B4 | Production `VITE_*` values only (https API, `VITE_KOI_AUTH=eoi`, public OIDC values; no dev token, no workspace id) | UNVERIFIED | rules are CODE VERIFIED in the preflight; local file is a development file (5 expected FAILs) | S |
| B5 | Bundle scan on the production build | UNVERIFIED | current `dist` is a development build (contains `localhost:5001`, `localhost:5175`) | S |
| B6 | Security headers for the SPA (frame protection, CSP, nosniff, referrer policy) | BLOCKED | none configured anywhere | P |
| B7 | Preview deployments cannot reach the real API or real sign-in | UNVERIFIED | CORS and OAuth redirects are exact-origin; previews would fail or need their own entries | S |
| B8 | Custom domain, managed certificate, HTTP→HTTPS | UNVERIFIED | no domain chosen | S (P for final) |
| B9 | Vercel serverless functions / `/api` on Vercel | NOT APPLICABLE | the browser calls the Render API directly | — |

### C. Render Node backend

| ID | Item | Class | Evidence / reason | Before |
|---|---|---|---|---|
| C1 | Service exists (region, plan, instance type) | UNVERIFIED | Render has 0 services | S |
| C2 | Build/start (`npm ci`, `npm start`) and a pinned Node version | UNVERIFIED | `engines` is `>=20` (open-ended); tested on 20.17 | S |
| C3 | Environment per the contract (`NODE_ENV=production`, `AUTH_PROVIDER=eoi`, `LLM_PROVIDER=gemini`, URLs, secrets) | UNVERIFIED | contract exists; staging file not built; preflight on local dev files: 22 PASS / 5 FAIL (all expected: development values) | S |
| C4 | Unsafe configuration refuses to start | VERIFIED | `server.js` + startup checks; Phases 36/38/46.1 suites pass | — |
| C5 | Exactly one instance; overlapping deploy is safe | UNVERIFIED (platform) / VERIFIED (code) | scaling pin is a platform setting; analysis single-flight is durable since 5A | S |
| C6 | Instance never sleeps / cold-start behaviour acceptable | UNVERIFIED | platform plan behaviour not checked; free tiers may suspend idle services | S |
| C7 | Graceful SIGTERM | VERIFIED | `server.js` drains, marks in-flight attempts interrupted | — |
| C8 | No local disk state needed | VERIFIED | state is MongoDB only (Phase 38 §4); development outbox refused in production | — |
| C9 | Region co-located with Atlas and the AI service | UNVERIFIED | no regions chosen | S |
| C10 | Node keep-alive set above platform idle timeout | UNVERIFIED | default 5 s | S |

### D. AI service (Render private service)

| ID | Item | Class | Evidence / reason | Before |
|---|---|---|---|---|
| D1 | Service exists as a **private** service reachable only from Node | UNVERIFIED | none exists; an unauthenticated public AI service would spend Gemini quota | S |
| D2 | Service-to-service token on both sides | VERIFIED (code) / UNVERIFIED (target) | constant-time check, docs disabled when set; local preflight PASS | S |
| D3 | Start command and port (`uvicorn app.main:app --host 0.0.0.0 --port <port>`) | UNVERIFIED | no manifest by design | S |
| D4 | Python version pinned | UNVERIFIED | local 3.12.6; no pin file | S |
| D5 | Installed versions equal tested versions | BLOCKED | `pydantic` pinned 2.10.4 vs tested 2.13.5; reconcile and freeze | S |
| D6 | AI-service tests | VERIFIED | 531 passed (deterministic, no network) | — |
| D7 | Gemini key only in the AI service | VERIFIED (local) / UNVERIFIED (target) | preflight: absent from backend env, present on AI side | S |
| D8 | Model pinned; provider/timeout guards fail closed | VERIFIED | startup matrix, Phase 34/36 | — |
| D9 | `EMBEDDING_PROVIDER=gemini` in production | UNVERIFIED | local PASS; the service cannot tell production from development | S |
| D10 | Health endpoint for the platform probe | VERIFIED | `/v1/health` stays open | — |

### E. MongoDB Atlas

| ID | Item | Class | Evidence / reason | Before |
|---|---|---|---|---|
| E1 | Staging cluster and a **separate** production database/user | UNVERIFIED | Atlas not inspectable (org disabled MCP); local dev already uses an Atlas database | S |
| E2 | Least-privilege user (`readWrite` on one database), old admin credential removed | UNVERIFIED | a script comment says readWrite on `koi_staging`; Phase 41 found an `atlasAdmin` password pasted into a chat and rotation was never confirmed | S |
| E3 | Narrow network access; no `0.0.0.0/0`; plan for Render egress addresses | UNVERIFIED | Render egress is shared by region (platform fact, to confirm); this may force a broader allow-list or private networking | S |
| E4 | TLS and authentication | VERIFIED (code) / UNVERIFIED (target) | `mongodb+srv` implies TLS; startup warns otherwise | S |
| E5 | Database name in the URI | VERIFIED | startup refuses a URI without one | — |
| E6 | Indexes build on first start (94, no migration) | VERIFIED (code) / UNVERIFIED (target) | Phase 38 inventory; `atlas-indexes.mjs` exists | S |
| E7 | Cloud backups enabled with retention | UNVERIFIED | tier unknown; the repo's own Phase 41 note says free shared tiers lack them | P (S recommended) |
| E8 | A restore into a copy was performed and the app served from it | UNVERIFIED | only the synthetic logical rehearsal (`restore-rehearsal.mjs`, passes) | P |
| E9 | Workspace deletion transaction | VERIFIED | Atlas is a replica set; used only there | — |

### F. Gemini

| ID | Item | Class | Evidence / reason | Before |
|---|---|---|---|---|
| F1 | Production key, quota, billing and a **budget alert** | UNVERIFIED | external account; no application-level daily cap | S (alert), P |
| F2 | The pinned model answers for the key | VERIFIED (local key) | real calls succeeded in today's run; production key unchecked | S |
| F3 | Latency/availability handling | VERIFIED (design) | 202 + status pattern, 25 s window, 60 s Gemini deadline, no automatic retry; observed provider timeouts earlier (Phase 51: 8 of 12 in one run; 5D: stable for 3 h) | — |
| F4 | Timeout chain fits the hosting proxies | UNVERIFIED | longest browser-facing wait ≈25–30 s; Node→AI up to 65 s; proxy limits unknown | S |
| F5 | Outbound access from the AI service to Google | UNVERIFIED | no service | S |
| F6 | Permission to send operational/guest-derived text to Gemini (privacy/legal) | UNVERIFIED | guest contact details are removed from the context; the policy/legal sign-off is organisational | P |

### G. Authentication and Google OAuth

| ID | Item | Class | Evidence / reason | Before |
|---|---|---|---|---|
| G1 | Token verification, sessions, roles, tenant isolation | VERIFIED | Phases 13–23, 45B–46 suites pass | — |
| G2 | Google Cloud Web client lists the staging/production redirect URI and origin exactly | UNVERIFIED | local client is configured for `http://localhost:5175/` (trailing slash is part of the exact match) | S |
| G3 | Consent screen status (testers vs published), privacy-policy URL | UNVERIFIED | Phase 45B.4: a real person's sign-in was never exercised; in "Testing" mode only listed testers can sign in | S (testers), P (published) |
| G4 | `OIDC_EXCHANGE_*` set together; secret only in the platform secret store | VERIFIED (rule) / UNVERIFIED (target) | partly configured refuses to start in production | S |
| G5 | `KOI_SESSION_SECRET` (≥32 chars) is new and distinct per environment | UNVERIFIED | present locally; must not be the development value | S |
| G6 | First administrator / workspace bootstrap | UNVERIFIED | `scripts/provision-user.mjs` exists, refuses a remote database unless `--allow-remote-db`, and is untracked | S |
| G7 | Self-registration decision | BLOCKED (decision) | on locally; see finding 10 | P |
| G8 | Non-Google OIDC providers, legacy `oidc` mode | NOT APPLICABLE | Google + EOI sessions only | — |

### H. SMTP

| ID | Item | Class | Evidence / reason | Before |
|---|---|---|---|---|
| H1 | Provider chosen; sender domain authenticated (SPF/DKIM/DMARC) | UNVERIFIED | no `SMTP_*` anywhere | S |
| H2 | Startup refuses an incomplete configuration | VERIFIED | `emailStartupProblems`; Phase 46.1 | — |
| H3 | Outbound SMTP port reachable from the chosen Render plan | UNVERIFIED | code is SMTP-only; if blocked the backend cannot send verification/reset mail | S |
| H4 | Verification and reset mail delivered and links open the https frontend | UNVERIFIED | `CLIENT_URL` https is enforced at startup | S |
| H5 | Auth endpoint throttling | VERIFIED | per-address and per-email limits | — |

### I. CORS, HTTPS, cookies

| ID | Item | Class | Evidence / reason | Before |
|---|---|---|---|---|
| I1 | CORS allows exactly one origin and requires auth | VERIFIED | code; Phase 39 live probe | — |
| I2 | `CLIENT_URL` written without a trailing slash | BLOCKED | finding 4; add to the staging checklist and the preflight | S |
| I3 | TLS termination, redirect, HSTS | VERIFIED (API sends HSTS in production) / UNVERIFIED (platforms) | | S |
| I4 | Cookie/domain topology | BLOCKED (decision) | finding 5 | S (decide) |
| I5 | Cookie attributes (HttpOnly, Secure, Path `/api/auth`) and CSRF defence | VERIFIED | code; Phase 46 suites | — |
| I6 | API security headers | VERIFIED | `securityHeaders.js` | — |

### J. Secrets

| ID | Item | Class | Evidence / reason | Before |
|---|---|---|---|---|
| J1 | Secret inventory | VERIFIED | backend: `MONGODB_URI`, `KOI_SESSION_SECRET`, `SMTP_PASSWORD`, `OIDC_EXCHANGE_CLIENT_SECRET`, `AI_SERVICE_TOKEN`; AI service: `GEMINI_API_KEY`, `AI_SERVICE_TOKEN`; frontend: none | — |
| J2 | Stored only in the platform secret stores | UNVERIFIED | nothing created | S |
| J3 | Staging/production secrets are new, not the development ones; exposed ones rotated | UNVERIFIED | the local `.env` holds live Atlas, Gemini, Google and session credentials; the Atlas password from Phase 41 was exposed once | S |
| J4 | No secret in repository, bundle, history | VERIFIED | A4 | — |

### K. Timeouts, proxies, limits

| ID | Item | Class | Evidence / reason | Before |
|---|---|---|---|---|
| K1 | Node timeout set and consistent (headers 15 s, request 60 s, socket 120 s, analysis wait 65 s) | VERIFIED | startup check refuses inconsistent values | — |
| K2 | Request sizes (uploads ≤10 MB) pass the platform proxy | UNVERIFIED | | S |
| K3 | `KOI_TRUST_PROXY` equals the real hop count | UNVERIFIED | finding 6; cannot be known before the target exists | S |
| K4 | Keep-alive above the platform idle timeout | UNVERIFIED | finding 7 | S |

### L. Health checks

| ID | Item | Class | Evidence / reason | Before |
|---|---|---|---|---|
| L1 | Node `/api/health` (200 healthy, 503 database down) | VERIFIED | `healthController.js` | — |
| L2 | It does not exercise the AI service or Gemini | VERIFIED (by design) | add a scheduled synthetic analysis in staging | S |
| L3 | Platform health-check path, interval and restart policy configured | UNVERIFIED | | S |
| L4 | Health probe shares the unauthenticated rate limit | UNVERIFIED | follows from K3 | S |

### M. Logging and monitoring

| ID | Item | Class | Evidence / reason | Before |
|---|---|---|---|---|
| M1 | Structured events on stdout with no content, ids or tokens | VERIFIED | Phases 36/37/38 | — |
| M2 | Log collection, retention and search | UNVERIFIED | the repo ships no shipper; platform retention not checked | S (basic), P |
| M3 | Alerts for the documented events, tested in a drill | UNVERIFIED | thresholds are "initial / tuning required" | P |
| M4 | External uptime monitoring | UNVERIFIED | | P |
| M5 | Named owner and on-call path | UNVERIFIED | organisational | P |
| M6 | Procedure to read the audit trail | UNVERIFIED | service function only, no HTTP route | P |
| M7 | Error tracker / APM | NOT APPLICABLE | not part of the design; stdout events are the signal | — |

### N. Rate limits

| ID | Item | Class | Evidence / reason | Before |
|---|---|---|---|---|
| N1 | Limits on by default (anonymous 60/min, address 900, identity 300, writes 60, AI 10 and 30 per workspace, auth endpoints per 15 min) | VERIFIED | `runtimeConfig.js`; Phase 21 | — |
| N2 | Limits are per process | VERIFIED | one instance is the supported topology | — |
| N3 | Shared store (for example Redis) | NOT APPLICABLE | only if the backend is ever scaled out | — |
| N4 | Spend ceiling at the provider | UNVERIFIED | finding 10 | P |

### O. Backup, restore, rollback

| ID | Item | Class | Evidence / reason | Before |
|---|---|---|---|---|
| O1 | Written runbook: deploy order (MongoDB → AI service → Node → frontend), restore, rollback | UNVERIFIED | restore order is documented in Phase 38; no runbook | P |
| O2 | Frontend rollback (previous Vercel deployment) | UNVERIFIED | no history yet | P |
| O3 | Backend/AI rollback (previous Render deploy) and Node↔AI version compatibility | UNVERIFIED | the two services must move together | P |
| O4 | Data-compatibility boundary for rollback | BLOCKED | finding 11; write down the lowest build that is safe | P |
| O5 | Application-level switches that reduce harm without a rollback | VERIFIED | unset `LLM_PROVIDER` makes analysis answer 503; `KOI_SELF_REGISTRATION=false`; rate limits | — |
| O6 | Database rollback = restore from backup | UNVERIFIED | depends on E7/E8 | P |

### P. Dependencies and tests

| ID | Item | Class | Evidence / reason | Before |
|---|---|---|---|---|
| P1 | Backend production dependencies | BLOCKED | 1 critical (`proxy-addr`, fixable without a breaking change) and 3 moderate (`mammoth` chain, needs a decision) | S |
| P2 | Frontend production dependencies | VERIFIED | 0 vulnerabilities | — |
| P3 | Python dependency audit | UNVERIFIED | `pip-audit` is not installed | S |
| P4 | Lockfiles committed and used for installs | UNVERIFIED | part of A1; Python has no lock | S |
| P5 | A clean, agreed test baseline | UNVERIFIED | 32 suites exit non-zero; all match the 5C baseline or are stale/live-stack checks, but there is no signed-off list of which are expected | S |
| P6 | Local end-to-end with real Gemini | VERIFIED | acceptance test and today's run | — |
| P7 | Staging smoke (two real analyses) and failure injection (AI down, bad key, Mongo down) | UNVERIFIED | | S |

### Q. Operations and organisation

| ID | Item | Class | Evidence / reason | Before |
|---|---|---|---|---|
| Q1 | Data-protection basis, privacy notice and retention for guest-derived data | UNVERIFIED | | P |
| Q2 | Pilot scope accepted: supervised use, Learning OFF, closed safety cue list, open items in the safety reports | UNVERIFIED | the supervised-pilot assumption is in the Core Acceptance and safety reports | P |
| Q3 | Support and incident contact | UNVERIFIED | | P |

### Totals

| Class | Items |
|---|---|
| VERIFIED | 30 |
| UNVERIFIED | 59 |
| BLOCKED | 10 |
| NOT APPLICABLE | 4 |
| MIXED (verified in code, unverified on target) | 6 |
| **Total items** | **109** |

Items needed before staging: **59**; additionally before production only: **18**.

## 6. Must be completed before STAGING (in order)

1. **Make a release candidate.** Review the 378 entries; keep what should ship (A7); remove the Atlas user name from the script comment (A6); commit, push to the branch the platforms will build, and tag it (A1–A3). *Owner: you; the audit did not commit.*
2. **Clear the dependency findings:** apply the non-breaking `npm audit fix` for `proxy-addr`; decide on `mammoth`; freeze Python versions to the tested set (including `pydantic`) and pin Python and Node versions (P1, D4, D5, C2). Re-run the full sweep on the release candidate and write down which suites are expected to be red (P5).
3. **Decide the topology:** domain names (recommended: two sibling subdomains of one domain, so cookies stay same-site), the Render region next to Atlas, and the instance plan (no sleeping, single instance, private service for the AI service) (I4, C1, C6, C9, D1).
4. **Choose the SMTP provider and confirm the Render plan can reach its port** before creating the backend (H1, H3).
5. **Atlas:** a staging database separate from the development one, a least-privilege user, a network-access plan for Render, tier and backup status; rotate the exposed credential (E1–E3, J3). This needs an Atlas organisation owner, because the connector is disabled.
6. **Google Cloud:** add the staging redirect URI and origin exactly; add testers or publish (G2, G3).
7. **Create the three services with the environment contract:** all secrets new and in the platform stores (J2, G5), `NODE_ENV=production`, the same `AI_SERVICE_TOKEN` on both sides, `CLIENT_URL` **without a trailing slash** (I2), `KOI_TRUST_PROXY` set to the observed hop count, `KOI_KEEPALIVE_TIMEOUT_MS` above the platform idle timeout (K3, K4), health-check paths (L3), single-instance pin (C5), production `VITE_*` values (B3, B4, B7).
8. **Run the repository preflight** on the staging env files and on the built bundle; both must be all PASS (B5).
9. **Bootstrap the first administrator** (self-registration on for staging only, or `provision-user.mjs --allow-remote-db`) (G6).
10. **Staging smoke and failure injection:** sign-up mail, Google sign-in, two real analyses, restart during an analysis, AI service down, wrong Gemini key, Atlas unreachable (P7, F4, F5, H4). Set a Google budget alert before the first real call (F1).

## 7. Must be completed before PRODUCTION

1. Everything in section 6, passing on staging for a soak period that includes a Gemini slow state and a platform restart.
2. Atlas backups enabled with stated retention **and one restore into a copy with the application served from it** (E7, E8).
3. Log retention, alerts for the events in `PRODUCTION_OBSERVABILITY.md`, external uptime checks, and one alert drill (M2–M4); a named owner and on-call path (M5); a way to read the audit trail (M6).
4. Written runbook with deploy order, restore, and rollback including the data-compatibility boundary; one rehearsed rollback of the frontend and of the backend (O1–O4).
5. SPA security headers (B6) and the final cookie/domain setup with HSTS on the real domain (I3, I4).
6. Decisions: self-registration (G7), whether upload parsing stays as is given the `mammoth` advisory (P1), provider spend ceiling and budget alert (F1, N4), privacy and legal basis for sending guest-derived text to Gemini and for storing it (F6, Q1).
7. Google consent screen published with a privacy-policy URL, or an explicit decision to stay in testers-only mode (G3).
8. Acceptance of the pilot scope and its documented limits (Q2): supervised use, human decision on every action, nothing executed externally, Learning OFF, the closed safety cue list and the open points in the safety reports.
9. A Python vulnerability scan and a final dependency scan on the release commit (P3, P1).

## 8. Configuration reference (names only; no values)

| Service | Required | Must be absent / off |
|---|---|---|
| Backend (Render web service) | `NODE_ENV=production`, `PORT` (platform), `CLIENT_URL` (https, no trailing slash), `MONGODB_URI` (secret), `AUTH_PROVIDER=eoi`, `KOI_SESSION_SECRET` (secret), `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_EXCHANGE_CLIENT_ID`, `OIDC_EXCHANGE_CLIENT_SECRET` (secret), `OIDC_EXCHANGE_REDIRECT_URIS`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` (secret), `MAIL_FROM`, `LLM_PROVIDER=gemini`, `AI_SERVICE_URL` (private), `AI_SERVICE_TOKEN` (secret); decide: `KOI_SELF_REGISTRATION`, `KOI_TRUST_PROXY`, `KOI_COOKIE_SAMESITE`, `KOI_KEEPALIVE_TIMEOUT_MS` | `KOI_EMAIL_TRANSPORT=outbox`, `AUTH_TOKEN_VERIFIER`, `AUTH_STUB_SECRET`, `KOI_EXPOSE_ERROR_DETAILS`, `KNOWLEDGE_DEV_AUTHORIZED_LEVEL`, `KOI_LEARNING_CONTEXT_ENABLED`, any `GEMINI_API_KEY`/`OPENAI_API_KEY`, `KOI_NO_DOTENV*`, `KOI_RATE_LIMIT_ENABLED=false`, the timeout overrides |
| AI service (Render private service) | `LLM_PROVIDER=gemini`, `LLM_MODEL` (exact approved value or unset), `GEMINI_API_KEY` (secret), `EMBEDDING_PROVIDER=gemini`, `AI_SERVICE_TOKEN` (secret, same as backend), start command with host `0.0.0.0` | `PHASE33_LOG_USAGE`, `P34C1_*`, any test provider |
| Frontend (Vercel build) | `VITE_API_BASE_URL` (https), `VITE_KOI_AUTH=eoi`, `VITE_OIDC_AUTHORITY`, `VITE_OIDC_CLIENT_ID`, `VITE_OIDC_REDIRECT_URI`, `VITE_OIDC_SCOPE`, `VITE_OIDC_TOKEN_EXCHANGE_URL`, `VITE_OIDC_PROVIDER_LABEL` | `VITE_DEV_ACCESS_TOKEN`, `VITE_KOI_WORKSPACE_ID`, any secret-shaped `VITE_*` |

## 9. Evidence log

| Check | Result |
|---|---|
| Git state | branch `main`; HEAD `d94287f`; `origin/main` `6c0db8e`; HEAD is 4 commits ahead of it and 0 behind; 378 uncommitted entries |
| Env preflight on local files | 22 PASS, 5 FAIL (development values), 1 NOT PROVIDED (bundle), 3 NOTE |
| Secret scan | 1,227 committable files; no real secret; bundle clean; history clean |
| Backend sweep | 100 suites: 68 exit 0, 32 non-zero (baseline-equivalent); readiness-relevant reds explained in finding 12 |
| AI-service tests | 531 passed |
| `npm audit --omit=dev` | backend: 4 (1 critical, 3 moderate); frontend: 0 |
| Isolated CORS experiment | trailing slash configured → header `https://eoi.example.com/` ≠ browser origin → mismatch |
| Render / Vercel / Atlas read-only queries | 0 services / no EOI project / Atlas MCP disabled by the organisation |

## 10. Limits of this audit

It could not see Atlas (disabled connector), any Render or Vercel configuration (none exists), Google Cloud, an SMTP provider, or real browsers on the final domains. Platform behaviour statements marked "platform fact" (egress addresses, SMTP port policy, sleeping plans, proxy timeouts, private-service availability) come from general knowledge and were **not** checked against current vendor documentation; they are listed as UNVERIFIED so the owner confirms them before choosing plans. The audit did not run the application against the cloud, did not send mail and did not call Gemini.

**Status: audit complete. Nothing was changed, committed, pushed or deployed.**
