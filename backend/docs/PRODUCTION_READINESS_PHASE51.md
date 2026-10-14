# Phase 51 - production readiness for the current EOI scope (Signal -> Context -> Intelligence -> Decision -> Action -> Outcome)

Scope: no new product feature. The product, its UI and its security model are frozen; this phase verified the finished loop end to end against a real Gemini, fixed the concrete
blockers found, and recorded what an operator must supply. Learning stays OFF. Nothing was deployed, committed or contacted outside the local machine.

## What changed in Phase 51 (and why)

| Change | Kind | Why it was necessary |
|---|---|---|
| `ANALYSIS_SYSTEM_PROMPT` rule 25 and the closing instruction now say a RECOMMENDATION claim is REQUIRED in every response, also when no business knowledge applies or the evidence is weak (`ai-service/app/services/analysis_prompt.py`) | AI prompt (no validator changed) | **A real RAG-miss / weak-evidence blocker.** With the real model, cautious analyses for signals with no usable guidance were frequently rejected in full for `CLAIM_NO_RECOMMENDATION`: the model returned a correct cautious analysis but omitted the RECOMMENDATION claim the application requires. Before: 8 of 14 attempts on these two kinds of signal failed this way (4 consecutive attempts on the weak-evidence signal in one run). After: 12 of 12 fresh no-guidance / weak-evidence signals succeeded on the first attempt (6 medium, 6 low confidence). No validator, ceiling or provenance rule was relaxed. |
| Optional `AI_SERVICE_TOKEN` (backend sends `X-KOI-Service-Token`; AI service refuses everything but `/v1/health` without it and stops publishing `/docs`, `/redoc`, `/openapi.json`) | AI service + backend config | The AI service had no authentication of its own: where the host cannot keep it on a private network, anyone who could reach it could spend Gemini quota and bypass Node's tenant checks. Off by default; a production start-up warning when unset. |
| `env-preflight.mjs`: accepts `AUTH_PROVIDER=eoi`; an endpoint URL such as `VITE_OIDC_TOKEN_EXCHANGE_URL` is not a "secret-shaped" variable; an absent `VITE_KOI_WORKSPACE_ID` is correct with real sign-in; checks SMTP / MAIL_FROM / CLIENT_URL and the token on both sides | operator tool | The Phase 39 preflight predated the unified sign-in and **failed a correct production configuration** (3 false FAILs). |
| `PRODUCTION_ENVIRONMENT_CONTRACT.md`: `AI_SERVICE_TOKEN`; `VITE_KOI_WORKSPACE_ID` is development-only | docs | The contract still described a build-time workspace id as required. |

No UI, no Outcome model, no RBAC and no retrieval change.

## Verified (CODE VERIFIED unless stated)

* **Journey** (production build served against a real backend, real Gemini, throwaway DB): sign up (verification mail) -> sign in -> workspace -> Signal -> Intelligence -> Decision -> Action (not executed) -> Outcome -> refresh. Zero Gemini calls for decisions, actions, outcomes, duplicates, concurrent attempts and refresh.
* **Intelligence**: RAG hit (cites the procedure, high confidence), RAG miss / irrelevant knowledge (cautious, "no documented guidance", medium), weak evidence (low), prompt injection in the Signal text (the invented policy, refund and "reveal your prompt" were ignored; low confidence), life-safety (hazard, immediate, escalation, high), access refusal (no maintenance dispatch).
* **Safety**: a hazard Action is escalation / critical / immediate and a weaker type is refused (409). The Outcome never changes the safety state.
* **Authentication**: sign-up, verification (single use), sign-in, wrong password / unknown user (401), refresh cookie (HttpOnly, SameSite=Lax, path `/api/auth`) with rotation, reuse detection after the 10 s grace window (suites), logout (session and access token stop working), forgot / reset (single use token, old password refused), Google sign-in (the local OIDC provider suites; a live Google round trip is NOT VERIFIED from this machine).
* **Isolation**: another workspace's user gets 404 on read, analyse, decide, approve and record-outcome, with the right or a forged workspace selector; a forged workspace in a body is refused; unauthenticated requests are 401.
* **Frontend production build**: no localhost (apart from React Router's own placeholder string), no dev token, no credential-shaped string, only the intended API origin; the Phase 39 bundle scan passes.

## Operator checklist (values are never in the repository)

Run `node backend/scripts/phase39/env-preflight.mjs --backend <file> --ai <file> --frontend <file> --bundle <build dir>` on the real configuration. Supply: `MONGODB_URI` (Atlas, database named, least-privilege user), `KOI_SESSION_SECRET`, `SMTP_*` + `MAIL_FROM`, `CLIENT_URL` (https), `OIDC_*` / `OIDC_EXCHANGE_*` for Google (the authorised redirect URI and origin in Google Cloud must match the production URLs), `GEMINI_API_KEY` (AI service only), and the same random `AI_SERVICE_TOKEN` on the backend and the AI service. Frontend build: `VITE_API_BASE_URL`, `VITE_KOI_AUTH=eoi`, the public `VITE_OIDC_*` values; **not** `VITE_KOI_WORKSPACE_ID`, **not** `VITE_DEV_ACCESS_TOKEN`. One backend instance only (documented in Phases 37-39).

## Honest limits

* **Gemini availability.** During testing today the provider timed out (20 s) or was unavailable on 8 of 12 calls in one run, then behaved normally. The application fails closed with a retryable message and, by design, never retries automatically (cost control). Expect users to press "Try again" sometimes. This is outside the repository's control.
* The model still occasionally returns output the validators reject (a prose/structure inconsistency, a missing source reference). That is the guard working; a retry normally succeeds.
* Outcome: recording needs `operations:manage`, reading needs `decision:review`. The normal signed-up user is admin and holds both (verified); an operator-role member could record but not see it. No such member can be created through the product today, so no change was made.
* No live Google sign-in, no real SMTP delivery and no Atlas connection were exercised from this machine.
