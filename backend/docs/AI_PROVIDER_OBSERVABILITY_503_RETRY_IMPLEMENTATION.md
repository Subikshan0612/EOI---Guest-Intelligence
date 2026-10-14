# AI provider observability + safe 503 retry - implementation report

Workstream 1 of the plan in `AI_PROVIDER_RELIABILITY_DIAGNOSTIC.md`. Scope: end-to-end correlation id, structured provider-failure observability, and **exactly one retry for a provider HTTP 503, nothing else**.
Date: 2026-10-12 (IST). Nothing was committed, pushed or deployed. Work stopped after the report; the timeout/output-length question and the safety-failure UX were **not** started.

## 1. Executive summary

- **Correlation id.** The backend already had a request-id mechanism (`middleware/requestId.js`: one random uuid per request, `X-Request-Id`, carried on every `[KOI EVENT]`). It was reused. The analysis call to the AI service now forwards it as `X-KOI-Request-Id` (only when it is a canonical uuid). The AI service accepts it only when it is a canonical uuid, otherwise generates a fresh random uuid4, and puts it on every provider event. The id is never an input to any decision.
- **Observability.** The AI service now writes one safe, allow-listed JSON line per Gemini attempt (`provider.attempt`) and one per analysis (`provider.analysis_final`), prefixed `[KOI AI EVENT]` (the same convention as Node's `[KOI EVENT]`): correlation id, provider, model, attempt number, outcome, internal category (`PROVIDER_503` / `_504` / `_OTHER` / `_TIMEOUT` / `_UNKNOWN`), the provider's own HTTP status and status word when it reported one, duration, retry decision, final classification. For 5xx answers the provider's own message is kept (sanitised, at most 200 characters); a 4xx message is never logged.
- **Retry.** Exactly one retry, only for a provider HTTP 503, only when the first attempt failed within 3 s (so the retry always fits inside Node's 25 s wait), after a fixed 1 s delay. 504, client timeouts, every other status, transport errors, unexpected exceptions, malformed or invalid responses, validation and persistence failures are never retried. The SDK's own retry stays off (`attempts=1`), so there is one retry layer with a hard cap.
- **Unchanged:** every public error code/status/message, all timeouts, the model, the prompts, output limits, persistence, validation/sanitisation, the safety policy, Learning (OFF), the frontend, `.env` files.
- **Evidence.** New tests: 37 (AI service) + 29 (Node) all pass. AI-service suite 518 passed (481 + 37). All 94 pre-existing backend suites give **exactly the same results as the pre-change baseline** (0 differences; the same 15 baseline/environment failures). A controlled verification with fault injection through a real Node backend and the production AI-service code passed every check (16/16 harness checks, plus the correlation join verified from the complete logs), including one real Gemini retry path.

## 2. Files changed

Production source (5 files; one new):

| File | Change |
|---|---|
| `ai-service/app/provider_observability.py` | **NEW.** Correlation-id resolution, provider-failure classification, the pure `decide_retry`, message sanitiser, allow-listed event emitter. No network, SDK call, configuration or database access |
| `ai-service/app/services/gemini_analysis_client.py` | The single provider call is now `_call_gemini_with_one_503_retry(...)` (two attempts at most, 503 only); `generate_gemini_analysis` takes an optional `correlation_id`; `time` and the observability module imported. SDK client construction (timeout, `attempts=1`), model policy, prompt building, response validation: untouched |
| `ai-service/app/routers/analysis.py` | Reads the `X-KOI-Request-Id` header and passes it on (Gemini branch only) |
| `backend/src/services/ai/aiServiceClient.js` | `postToAiService` / `requestAnalysisFromAiService` accept an optional `{ requestId }` and send `X-KOI-Request-Id` when it is a canonical uuid; embeddings and retrieval calls unchanged; no retry added |
| `backend/src/services/intelligenceAnalysisService.js` | One line: passes the existing `requestId` into `requestAnalysisFromAiService` |

Tests (3 files; two new, one minimally modified):

| File | Change |
|---|---|
| `ai-service/tests/test_provider_observability.py` | **NEW**, 37 tests |
| `backend/scripts/validate-ai-provider-observability.mjs` | **NEW**, 29 checks |
| `ai-service/tests/test_provider_policy.py` | **Modified, one assertion.** The parametrised taxonomy test pinned "no retry for any failure" (`call_count == 1`) including the 503 case; that is the very behaviour this workstream changes on purpose, so the 503 case now expects 2 calls and the retry delay is patched out. All other cases and assertions untouched (including "the provider's message never appears in `caplog`") |

Docs: this report (new). No `.env`, `.env.example`, deployment, frontend, Learning, safety, prompt, config or `provider_errors.py` file was changed.

Verified unchanged by SHA-256 against hashes taken before the first edit (20 files, all `OK`): `analysis_prompt.py`, `provider_policy.py`, `config.py`, `provider_errors.py`, `exceptions.py`, `models/analysis.py`, `gemini_client.py`, `ai-service/.env.example`, `safetyPolicy.js`, `runtimeConfig.js`, `analysisSchema.js`, `claimValidator.js`, `proseConsistency.js`, `outputGuard.js`, `confidencePolicy.js`, `intelligenceService.js`, `models/Intelligence.js`, `logEvent.js`, `requestId.js`, `backend/.env.example`. `git status` differs from before only by the three new files. The frontend production bundle hash is identical to the one built before this work.

## 3. Correlation-id design

```
Browser -> Node: requestId middleware (existing): X-Request-Id honoured only if a canonical uuid, else a fresh randomUUID(); req.requestId; X-Request-Id response header
  -> intelligenceController -> analyzeSignal(options.requestId) -> runAnalysis(requestId)          (existing plumbing)
  -> requestAnalysisFromAiService(..., { requestId })  -> POST /v1/intelligence/analyze  header  X-KOI-Request-Id: <uuid>      (NEW, analysis call only)
  -> AI service router: reads the header -> generate_gemini_analysis(correlation_id=...)
  -> resolve_correlation_id(): canonical uuid -> used (source "node"); anything else -> new uuid4 (source "generated")
  -> every provider.attempt / provider.analysis_final event carries correlationId
Node's own analysis.accepted / analysis.rejected events and the AnalysisAdmission row already carry the same requestId -> the two log streams join on it.
```

Properties: reuses the existing mechanism (no competing id); cryptographically random (`crypto.randomUUID`, `uuid4`/`os.urandom`); contains no workspace, Mongo, guest or Signal identifier; only a canonical uuid is ever accepted or forwarded (a hostile value such as `workspace-507f...`, a log-forging string, a number, an over-long string is dropped/replaced and never logged); it is not an authorization credential and no code reads it for any decision; it travels in a header only (never in the request body or the prompt, and never in a response body). Embedding and retrieval calls are not given the id in this workstream (see risks).

## 4. Provider error classification

Internal, for logs only (`provider_observability.classify_provider_exception`); the existing public codes (`PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT`, ... in `exceptions.py`, mapped by `provider_errors.py` and Node's `AI_SERVICE_ERRORS`) are unchanged.

| Category | Meaning | Provider status recorded |
|---|---|---|
| `PROVIDER_503` | the provider answered HTTP 503 | 503 (+ its status word, e.g. `UNAVAILABLE`) |
| `PROVIDER_504` | the provider answered HTTP 504 (its own `DEADLINE_EXCEEDED`) | 504 |
| `PROVIDER_OTHER` | the provider answered any other HTTP error (400, 401, 403, 404, 408, 429, 500, 502, ...) | the number it reported |
| `PROVIDER_TIMEOUT` | the client side gave up (httpx / OS timeout); the provider said nothing | none |
| `PROVIDER_UNKNOWN` | anything else: a transport error, an unexpected exception, an API error without a usable status | none (never guessed) |

Logged alongside: the exception **class name** (a code identifier), never an exception message of unknown origin; for a 5xx answer only, the provider's own message, redacted (the exact configured Gemini key and service token, Google-key-shaped strings, `Bearer ...`, `key=/token=/secret=` pairs, any 32+ character opaque token, e-mail addresses, URLs), stripped of control characters and cut at 200 characters. A 4xx message is never logged (a rejected-request message can quote the request). This is the one deliberate exception to the module docstring's earlier rule that no SDK message is logged; it is written to stdout as a structured event and does not go through the `logging` module, so the existing test that no provider text appears in `caplog` still holds.

Public behaviour: unchanged. Verified by the tests and by the controlled run (e.g. 504 -> `504 PROVIDER_TIMEOUT`, two 503s -> `502 PROVIDER_UNAVAILABLE`, 400 -> `502 PROVIDER_BAD_REQUEST`, 401 -> `503 PROVIDER_AUTHENTICATION_FAILED`).

## 5. Exact retry behaviour

```
attempt 1: generate_content(...)
  success                      -> return the response (validated exactly as before)
  provider HTTP 503 AND took <= 3000 ms AND attempt 1
                               -> log provider.attempt (retry_503); wait 1.0 s; attempt 2
  anything else                -> log provider.attempt (no_retry_not_503 / no_retry_budget); raise the SAME mapped error as before
attempt 2: generate_content(...)   (same model, same contents, same config object, same client)
  success                      -> return
  any failure (including 503)  -> log provider.attempt (no_retry_attempts_exhausted); raise the mapped error. NO third attempt.
```

- Constants (`provider_observability.py`): `MAX_PROVIDER_ATTEMPTS = 2`, `RETRY_DELAY_SECONDS = 1.0` (fixed: no jitter, so the behaviour is exactly testable), `RETRY_FIRST_ATTEMPT_MAX_MS = 3000`.
- **Why the 3 s budget rule:** the provider timeout is 20 s per attempt and Node waits 25 s by default (20 s base + 5 s margin, startup-checked to exceed 20 s). Worst case = first attempt + 1 s + 20 s; with the first attempt at most 3 s that is 24 s, inside Node's wait with 1 s headroom. Observed 503s answer in 1.5-2.2 s, so the rule costs nothing in practice; a slow 503 is simply not retried (`no_retry_budget`) so a retry can never outlive Node's wait. No timeout value was changed.
- `decide_retry` is a pure function of (failure, attempt number, elapsed ms): deterministic, cannot loop (the cap is on the attempt number), unit-tested exhaustively. There is no generic retry loop and no retry helper other code could reuse by accident.
- SDK retry: `HttpRetryOptions(attempts=1)` (no SDK retry) is unchanged and asserted by a test (`options.retry_options.attempts == 1`, `timeout == 20000`), so retries cannot multiply.
- Scope: the analysis path (`/v1/intelligence/analyze`, the only AI call the Node backend makes for analysis). The legacy `/v1/intelligence/signal` path (`gemini_client.py`, not called by Node), embeddings and retrieval are untouched.
- Node does not retry (asserted: one AI-service request per analysis whether the service answers 503 or 504).

## 6. Tests added

**AI service, `tests/test_provider_observability.py` (37 tests):**

1. successful first attempt: one call, no retry, two events;
2. 503 then success: two calls, one 1.0 s delay, events show `PROVIDER_503`/`retry_503` then success, final `retried: true`;
3. 503 then 503: exactly two calls (a queued third success is never reached), existing public failure `PROVIDER_UNAVAILABLE`, final `PROVIDER_503`;
4-6. 13 parametrised cases that must **not** retry (one call each, no sleep, public mapping unchanged): 504, `ReadTimeout`, `ConnectTimeout`, 408, 400, 401, 403, 404, 429, 500, 502, `ConnectError`, a generic exception; plus a received-but-unusable response is never retried;
7. classification: statuses, categories, no invented status (an API error without a status is `PROVIDER_UNKNOWN`); provider message kept for 5xx only and sanitised (key, bearer, e-mail, URL, control characters, length);
8-10. correlation: generated when none is sent; the Node-sent id (even upper-case) is on every event of the request; seven hostile header values are replaced and never logged; three requests, three different ids;
11. no secrets in events: Signal title and text markers, guest name and e-mail, model-output marker, access token, cookie, service token, the API key (including inside a provider message), `mongodb`, `workspaceId` are absent from every line and from captured stdout; only allow-listed fields can be emitted and unsafe values are dropped;
12. retry bound: attempt cap, determinism, time-budget rule, no retry for any non-503; the worst case fits inside Node's 25 s; timeout (20,000) and output limit (4,096) defaults unchanged; the SDK client is still built with one attempt;
13-15. both attempts send an identical request and the id never enters the prompt; a response that arrives after a retry is validated exactly as before (malformed -> `MALFORMED_RESPONSE`); the deterministic test provider is unaffected.

**Node, `scripts/validate-ai-provider-observability.mjs` (29 checks; isolated local DB, loopback stub AI service, spawned backend, no Gemini):** the header is sent as a lower-case uuid and only then (hostile, malformed, numeric and absent values never sent), other headers and the body shape unchanged, embeddings unaffected; every analysis response carries a uuid, requests differ, the id Node generated is the id the AI service received, a caller-supplied canonical uuid is honoured and a hostile one replaced, Node's own `analysis.rejected` event carries the same id; Node never retries (one AI request per analysis for 503 and 504 answers); public statuses/codes/messages unchanged; persistence unchanged (nothing stored on failure, one rejected audit row per attempt with the unchanged failure class, no Decision/Action/Outcome; a repeat call is a fresh single attempt); no token, bearer string, Mongo URI or credential in the Node logs; the header carries only a uuid; no `learning` key in any request body and the flag reads false; timeouts (20 s / 25 s / 20 s ceiling), the safety policy (gas/smoke/CO hazard, access refusal forbids dispatch, sparks still `NORMAL` - the known gap, untouched) and the event allow-list unchanged; the Node client has no retry loop.

## 7. Test results

| Run | Result | Class |
|---|---|---|
| New AI-service tests (`test_provider_observability.py`) | **37 passed** | PASS |
| New Node suite (`validate-ai-provider-observability`) | **29 passed, 0 failed** | PASS |
| AI-service suite (full) | **518 passed, 0 failed** (baseline 481 + 37 new) | PASS |
| Backend validation suites, default environment (same runner and database as the baseline) | **95 suites (94 existing + 1 new): 64 exit 0, 31 exit non-zero; compared suite by suite with the pre-change run: 0 differences** (same exit code and same pass/fail counts in every one of the 94 existing suites); 7,510 assertions passed, 36 failed in the default environment, all in suites that failed identically before | PASS vs baseline |
| HTTP-dependent suites on the throwaway test stack (AI service with test providers, stub-auth backend, local DB) | identical to the baseline: `validate-api` 261/0, `validate-import` 195/0, `validate-intelligence-persistence` 64/0, knowledge suites (authoring 49, chunking 54, grounding 46, ingestion-upload 158, ingestion 86, retrieval 106, knowledge 54), `validate-ai-service` 24/0, `validate-dev-token` 14/0; with the AI-service token requirement off: `validate-knowledge-embedding` 42/0, `validate-knowledge-visibility-api` 144/0, `validate-intelligence-analysis-api` 81/0, `validate-phase24-canonical-intelligence` 60/0 | PASS |
| Frontend `npm run build` | OK, bundle hash identical to the pre-change build (no frontend change) | PASS |

Failures that remain are **exactly the previously documented ones**, none caused by this work:

- EXPECTED/BASELINE FAILURE (stale assertions or documented baselines, identical to before): `validate-phase27/29/30/31/32` (DB-baseline counts), `validate-phase33-lite-evaluation` (2), `validate-phase33-real-learning-evaluation` (1), `validate-phase38-deployment-readiness` (D5), `validate-phase41-atlas-readiness` (C3/C6 allow-list and username), `validate-phase45a-landing` (6), `validate-phase45b22-auth-hardening` (G4), `validate-dashboard` (1).
- ENVIRONMENT FAILURE (same as before, the default environment has no test stack / specific embedding cache): the HTTP-dependent suites in the default run (they pass on the test stack, above), `validate-phase26-evaluation`, `validate-phase26_5-real-embedding`, `validate-provision-dev-identity`.
- No new FAIL. No unrelated failing test was modified to make a suite green; the single test edit is the 503 assertion described in section 2.

## 8. Controlled verification results

Method: the **unmodified production AI-service app** (new retry and events included) launched through a scratchpad launcher that replaces only `google.genai ... Models.generate_content` with a fault injector (genuine google-genai error objects, or the real call); a **real Node backend** (stub auth, Learning flag unset) on an isolated local MongoDB (dropped afterwards); Atlas never contacted. Two real Gemini calls were made (A and B's retry); everything else is injected.

| Scenario | Plan (per provider call) | Result | Provider calls | Evidence |
|---|---|---|---|---|
| A normal | real | **201** in 4.0 s | 1 | one `provider.attempt` (success) + final |
| B 503 -> retry | 503, real | **201** in 4.7 s | **2** | attempt 1 `PROVIDER_503`, status 503/`UNAVAILABLE`, decision `retry_503`, delay 1000 ms; attempt 2 success; final `retried: true`; 1 Intelligence stored |
| C 504 | 504 | **504 `PROVIDER_TIMEOUT`** in 0.5 s | **1** | `PROVIDER_504`, `no_retry_not_503` |
| D 503 twice | 503, 503 | **502 `PROVIDER_UNAVAILABLE`** in 1.5 s | **2** | `retry_503` then `no_retry_attempts_exhausted`; final `PROVIDER_503`, 2 attempts; no third call |
| E client timeout | `ReadTimeout` | **504 `PROVIDER_TIMEOUT`** | **1** | `PROVIDER_TIMEOUT`, no status invented |
| F 400 | 400 | **502 `PROVIDER_BAD_REQUEST`** | **1** | `PROVIDER_OTHER`; no provider message logged for a 4xx |
| G 401 | 401 | **503 `PROVIDER_AUTHENTICATION_FAILED`** | **1** | no retry |

- **D. Correlation in the diagnostic path:** for all 7 requests the response `X-Request-Id`, Node's `analysis.accepted/rejected` event `requestId`, the audit row `requestId`, and the AI service's `correlationId` on every one of its events are the same value (checked against the complete logs: 7/7 join; 7 requests, 7 different ids). My harness' first read of the Node log raced with Node's asynchronous stdout flush and reported a false negative for 5 scenarios; the audit rows already showed the match and the full-log check confirmed it.
- **E. No sensitive information in the logs:** a scan of both log streams for the operator and reviewer bearer tokens, the AI-service token, the real Gemini API key, a Mongo URI, an `Authorization` header or `Bearer `, a marker in the Signal text, the guest's name, e-mail and phone, and the report wording found **none**; all 16 AI event lines are 482 characters or shorter and contain only allow-listed fields.
- **F. No duplicate records:** after scenario B succeeded, asking again returned the stored record (200) with **zero** provider calls; the full Decision -> Action -> Outcome journey ran (201/200/201/200/201); totals: 2 Intelligence = 2 accepted admissions, 5 rejected admissions, 1 Decision, 1 Action, 1 Outcome, no duplicate Intelligence per (Signal, level), `learningUsed` 0.
- Sample event line (scenario B, attempt 1): `{"event":"provider.attempt","correlationId":"c0eaf411-...","correlationSource":"node","provider":"gemini","model":"gemini-3.1-flash-lite","attempt":1,"maxAttempts":2,"outcome":"failure","category":"PROVIDER_503","httpStatus":503,"providerStatus":"UNAVAILABLE","exceptionClass":"APIError","durationMs":0,"retryDecision":"retry_503","retryDelayMs":1000,"providerMessage":"This model is currently experiencing high demand (injected test fault)."}`.
- Not demonstrated: a naturally occurring Gemini 503 being retried (they were injected; the real provider was fast during this run). The mechanism is exercised end to end, but the real-world recovery rate of the retry is unmeasured.

## 9. 504 and timeouts are NOT retried

Confirmed at four levels: the pure decision function (`decide_retry` returns no retry for `PROVIDER_504`, `PROVIDER_TIMEOUT`, `PROVIDER_OTHER`, `PROVIDER_UNKNOWN`), the parametrised unit tests (504, `ReadTimeout`, `ConnectTimeout`, 408 each make exactly one provider call and no sleep), the controlled run (scenario C: one call; scenario E: one call; public results unchanged), and the Node suite (Node itself never retries a 504 answer). The Node client contains no retry construct (checked by a static test).

## 10. Prompts, model and timeouts were NOT changed

Prompt (`analysis_prompt.py`), model policy (`provider_policy.py`, approved model `gemini-3.1-flash-lite`), configuration (`config.py`: `request_timeout_ms` 20,000, `llm_max_output_tokens` 4,096), `runtimeConfig.js` (base 20 s, analysis 25 s, provider ceiling 20 s, retrieval budget), the SDK client construction (`timeout`, `attempts=1`) and the output schema are unchanged (hash-verified, and re-asserted by tests: Python defaults, Node `getAiTimeoutMs() == 20000`, `getAiAnalysisTimeoutMs() == 25000`, ceiling 20,000).

## 11. Safety policy was NOT changed

`safetyPolicy.js` is byte-identical to before (hash verified), as are the claim, prose, identifier, confidence and schema validators. A Node check re-asserts: gas, smoke and carbon monoxide -> `LIFE_SAFETY_HAZARD` (immediate); access refusal forbids dispatch; **sparks and a burning smell still classify `NORMAL`** (the known gap from the health check, deliberately untouched here); an AC fault is `NORMAL`. The safety-aware failure message is not addressed (separate, later workstream).

## 12. Learning remains OFF

`KOI_LEARNING_CONTEXT_ENABLED` was never set in any process started for this work (and is deleted from the environment of every spawned backend); no request body sent to the AI service contained a `learning` key; `learningUsed` was `false` on all 7 admissions recorded in the controlled verification (and on every row in the Node suite's database). No Learning code or document was touched; no synthetic Learning case was created.

## 13. Remaining risks

1. **The retry only helps 503s.** In the diagnostic roughly half of the failures were 503 and the other half were 504 / slow-period timeouts, which this workstream deliberately leaves alone. Expect the visible failure rate to fall by up to about half, not to zero.
2. **The 3 s first-attempt rule can skip a retry.** Observed 503s answer in 1.5-2.2 s, but a 503 that took longer is not retried (`no_retry_budget`). The rule assumes Node's analysis wait is at least about 24 s; if an operator lowers `KOI_AI_TIMEOUT_MS` so Node's wait is barely above 20 s, a retry could outlive Node's wait (Node would answer 504 and nothing would be stored; harmless but wasted). The two processes cannot verify each other's value; the Node startup check only guarantees Node > 20 s.
3. **Observability is logs only.** Events go to stdout; nothing ships, aggregates or alerts on them, the Node admission row still does not store the provider category/status (it joins to the Python event through the shared id), and Node's events do not carry the Python attempt count.
4. **Correlation covers the analysis call only.** Knowledge-retrieval and embedding calls to the AI service do not carry the id (they were not part of the trace requested and are not Gemini generation calls).
5. **The provider message is now logged for 5xx answers.** It is redacted and capped, but it is provider-controlled text; a future provider could place something unexpected in a 5xx body. Only the 5xx case is logged, and the redaction covers the secrets this service actually holds.
6. **Retry cost/load.** A retry doubles provider calls during a 503 incident (each failed call costs nothing and returns in about 2 s; the retry costs one normal call). The per-identity AI-route limiter (10/min) still bounds a user.
7. **Single-flight remains in-process**, as before (unchanged by this work).
8. The retry's real-world effectiveness is unmeasured (the 503s in the controlled run were injected).

## 14. Recommended next step

Review and, if accepted, commit the change. Then run the same controlled sample as the diagnostic against real Gemini for a while to measure how many real 503s the retry recovers and what residual failure remains (mostly 504 / slow-period). That measurement is what decides the second item of the diagnostic: the timeout / output-length question (the 20 s deadline shared by the SDK, Gemini's server-side deadline, the cross-service contract and the browser's 30 s must be moved together, not one at a time). The safety-aware failure message (a hazard report must not receive the neutral "try again") remains a separate workstream. Neither was started.

## Change boundary (explicit)

- production source modified: **YES** (5 files, one new: `provider_observability.py`, `gemini_analysis_client.py`, `routers/analysis.py`, `aiServiceClient.js`, `intelligenceAnalysisService.js`)
- tests modified: **YES** (2 new test files; one assertion in `test_provider_policy.py` changed because it pinned the old no-retry behaviour for 503; nothing else edited)
- docs modified: **YES** (this report is the only doc written)
- .env modified: **NO** (read at run time by the harness for the service token and key, never printed or stored)
- database writes: **YES, local throwaway only** (isolated local MongoDB databases created and dropped by the new suite, the controlled verification and the regression runs, plus the existing suites' own temporary databases; **no Atlas/staging access at all**)
- Learning changed: **NO**
- safety policy changed: **NO**
- timeout changed: **NO**
- prompt changed: **NO**
- model changed: **NO**
- .claude modified: **NO**
- CLAUDE.md modified: **NO**
- commits: **NO**
- pushes: **NO**
- deploys: **NO**

Other facts: 2 real Gemini calls were made (scenarios A and B); the controlled-verification launcher, harness and raw outputs are in the session scratchpad, outside the repository; my temporary processes (AI service on 8012, backends on 5350/5360/5002, AI service on 8001) were stopped and no listener remains; the long-running AI service on port 8000 and the dev backend were not touched (they run the pre-change code until restarted). After this report, work stopped.
