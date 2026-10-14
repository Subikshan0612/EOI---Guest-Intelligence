# Workstream 5A - backend hybrid analysis execution foundation

Status: **implemented and tested; nothing committed, pushed or deployed.** Scope: the backend execution lifecycle only. The provider/Gemini deadline is **unchanged at 20 s**; no frontend, prompt, model, output limit, safety policy, Learning, RAG, validation, sanitiser, Decision/Action gating, deployment configuration, `.env`, `.claude` or `CLAUDE.md` change. Frontend/status UX is 5B; the provider deadline increase and its measurement are 5C.
Date: 2026-10-13.

## 1. Implementation summary

One analysis is now an **attempt** with its own lifetime, separate from the HTTP request that started it:

```
user-triggered POST /intelligence/analyze/:signalId
   -> preflight: provider route, the Signal in THIS workspace (404 otherwise), an already stored analysis (returned, no model call)
   -> claim ONE durable in-progress attempt marker (unique per workspace + Signal + level, across processes)
   -> the EXISTING pipeline runs once: retrieval -> AI service -> validation -> sanitiser -> persistence (unchanged)
   -> the HTTP request waits at most the response window (25 s):
        finished in time  -> exactly today's answer (201 with the analysis / the same error as before)
        still running     -> 202 "in_progress" (attempt state only); the SAME attempt keeps running in this process
   -> the attempt ends: marker 'succeeded' (analysis stored) or 'failed' (stable code/class only)
   -> the client reads the state: GET /api/intelligence/analysis-status/:signalId
```

No queue, no worker, no schedule, no autonomous or repeated generation: the continuation is the already-started, user-triggered call finishing inside the process that started it, exactly as the design review defined (Option D).

New or changed pieces:

- **`AnalysisAttempt`** model (new): a minimal lifecycle marker.
- **`analysisAttemptService`** (new): claim / finish / read; pure state view; staleness; the status read.
- **`intelligenceAnalysisService`**: `analyzeSignal` now wraps the unchanged pipeline (`runAnalysis`) in the attempt lifecycle (`runAttempt`); the existing in-process single-flight is kept and its registration made race-free.
- **Controller / route**: 202 for an in-progress answer; `GET /api/intelligence/analysis-status/:signalId` (read-only, `intelligence:view`).
- **Config**: the three timeout boundaries made explicit (`getAnalysisResponseWindowMs`, `getAnalysisAttemptStaleAfterMs`); one optional variable.
- **Shutdown**: attempts owned by a process that ends gracefully are marked interrupted.
- **Workspace lifecycle**: attempt markers are removed with their workspace (they are workspace-owned).

## 2. Exact lifecycle / state model

**Stored states** (`AnalysisAttempt.status`): `in_progress` -> `succeeded` | `failed`. **Public states** (status read): `not_started`, `in_progress`, `succeeded`, `failed`.

Record (workspace-scoped; one row per attempt; a failed attempt stays as history and a later explicit request makes a new row):

| Field | Meaning |
|---|---|
| `workspaceId`, `signalId`, `analysisLevel` | the key (the same key as the stored analysis) |
| `attemptId` | the random id the attempt's `AnalysisAdmission` row also carries |
| `requestId` | the X-Request-Id of the request that started it (canonical uuid or absent; correlation only) |
| `status`, `startedAt`, `finishedAt` | lifecycle |
| `intelligenceId` | on success only: the stored analysis (an id, never content) |
| `failureCode`, `failureClass`, `httpStatus` | on failure only: the already-public failure vocabulary |

It holds **no** prompt, raw model output, Signal text, guest data, evidence, provider payload, header, message or secret (asserted by test 11.1). Indexes: a **partial unique index** on (workspace, Signal, level) where `status = in_progress` (the cross-process single-flight), a lookup index with `startedAt`, and a unique (workspace, attemptId).

**How the public state is derived** (`getAnalysisStatus`; read-only: it starts nothing and writes nothing):

1. the Signal must be in the caller's verified workspace, else 404 (the same answer as a missing one);
2. a **stored analysis** for (workspace, Signal, level) -> `succeeded` with `intelligenceId` (the stored record is the source of truth, so a completed analysis is never re-run because a client reconnects or polls);
3. otherwise the latest attempt: fresh `in_progress` -> `in_progress`; `in_progress` older than the staleness horizon -> `failed` / `ATTEMPT_INTERRUPTED` (derived, not written); `failed` -> `failed` with `{ code, class, httpStatus }`;
4. nothing -> `not_started`.

The 202 body and the status body carry only `status`, `attemptId`, `startedAt`, (`finishedAt`), (`intelligenceId`), (`failure: { code, class, httpStatus }`): no analysis content and no message.

## 3. HTTP vs attempt vs provider timeout separation

| Boundary | Where | Value | Changed? |
|---|---|---|---|
| **1. Browser / HTTP response window** | `getAnalysisResponseWindowMs()`: how long one HTTP request waits before answering 202 | **25,000 ms** by default = the shorter of 25 s and the request deadline; anchored to the browser's fixed 30 s, not to any Node setting; optional `KOI_ANALYSIS_RESPONSE_WINDOW_MS` (50-110,000 ms) so a test or operator can shorten it | new name, **value equals today's longest wait** |
| **2. Node analysis-attempt lifetime** | the pipeline: retrieval (budget 85 s) + the Node -> AI-service call (25 s `getAiAnalysisTimeoutMs()`), bounded by the 110 s request deadline; `getAnalysisAttemptStaleAfterMs()` = deadline + 30 s = **140 s**: an in-progress marker older than this belongs to a dead process | unchanged limits; the attempt now simply is not cancelled when the HTTP request stops waiting | no value changed |
| **3. Provider / Gemini deadline** | the AI service: 20 s per attempt (SDK read timeout and `X-Server-Timeout`), cross-service ceiling 20 s | **20,000 ms** | **unchanged** (asserted by test 0.3) |

With the provider deadline at 20 s the pipeline finishes inside the 25 s window in normal operation, so the 202 path is **not reached in normal operation**: it is built, tested and dormant until 5C. It is reached only if retrieval is unusually slow or a test shortens the window. The old two-tier design flaw (the analysis wait is derived from the same setting that sets each retrieval/embedding call timeout) is **not** touched here; it is a 5C item.

## 4. Coalescing / idempotency behaviour

- **In one process:** the existing single-flight map is kept; the entry is now registered synchronously (the attempt function runs up to its first `await` before the map is set), so there is no gap in which two leaders can form. Followers wait for the same attempt for at most the response window and receive its record (`created: false`), its failure, or the same 202 state.
- **Across processes:** claiming the attempt marker is an insert guarded by the partial unique index. A second process (or a second instance) finds the existing fresh marker, **starts no provider call**, and answers 202 with that attempt immediately (it does not wait; the client reads the state).
- **Completed work:** a stored analysis is returned (HTTP 200, no model call, no new attempt) and the status read reports it without any provider call. A second stored-analysis check inside the pipeline stays: another process may finish the same analysis between the first check and the claim.
- **After a failure:** an explicit new request starts a new attempt (a new row); nothing re-runs by itself.
- **Proven** (suite, section 3): 12 concurrent requests for one Signal -> **1 attempt, 1 provider call, 1 analysis, 1 admission row**; the same through **two backend processes** (4 simultaneous requests) -> still **1 / 1 / 1**; 25 simultaneous claims of one key -> **exactly 1** succeeds.
- Behaviour change worth stating: two simultaneous requests that land on **different instances** used to both call the model (one wasted paid call; both clients got an answer). Now one instance runs the analysis and answers 201, the other answers **202** at once with no call. This follows the design (the existing attempt's state is returned) and is why the Phase 37 two-instance test was updated (section 12).

## 5. Restart behaviour (items D and E)

Stated as what the code can safely guarantee; **no recovery semantics were invented**.

| Event | What is guaranteed | What is not |
|---|---|---|
| **Browser disconnect** | Node carries the attempt to its end and stores the analysis; a later request or poll gets it (tests 4.1, 4.2: 1 call, 1 attempt, `succeeded`) | the page, if it showed a failure, does not know until it reads the state (5B) |
| **Node graceful shutdown** (SIGINT/SIGTERM) | the attempts this process owns are marked `failed` / `ATTEMPT_INTERRUPTED` before the database closes (test 7.6) | a signal cannot be delivered gracefully on every platform (on Windows `kill` is forceful), so the hook is exercised through the function the shutdown handler calls and its wiring is asserted statically |
| **D. Node restart / SIGKILL while an attempt is in progress** (test 7.1-7.5) | the marker survives; the new process reports `in_progress` and starts **no** second provider call while the marker is fresher than 140 s (the call might still be running); older than 140 s the state is `failed` / `ATTEMPT_INTERRUPTED` (a GET writes nothing); an **explicit** new request then expires the stale marker (compare-and-set) and starts exactly one new attempt | nothing resumes the interrupted attempt; nothing re-runs it automatically; a person who asks again within 140 s of a crash is told "in progress" until the horizon passes |
| **E. Process termination while the Python/provider call is still running** (test 7.2) | the provider call completes (the test AI service does) with nobody to persist it: **no analysis, no partial record, no admission row**; the marker stays `in_progress`; one provider call was spent | the spent call cannot be recovered or cancelled (a Python worker thread is not cancelled when its caller dies; with the 20 s deadline it ends on its own) |

Durable recovery (resuming or re-running an interrupted attempt without a person asking) would need a durable queue and a worker. That is **explicitly deferred** and not built: the project rule against background AI workers and automatic generation stands.

## 6. Browser disconnect behaviour

Verified directly (suite 4.1-4.2, and earlier in the Workstream 4 experiment with real Gemini): the client left 0.4 s after sending; the same attempt completed and persisted; one provider call; one attempt row `succeeded`; a later request returned the stored result (HTTP 200) with no new call. "Try again" during the in-flight call joins it (2.3, 3.1) instead of starting a second one.

## 7. Failure semantics

The existing pipeline remains the single source of truth for outcomes. When it throws, the lifecycle records the failure as state and re-throws the **same** error: the public error is unchanged (HTTP status, `details.code`, message), exactly one admission row is written as before, and the attempt marker is finished `failed` with only `failureCode` (stable, already public), `failureClass` (the existing taxonomy; none added) and the HTTP status. A marker update that itself fails is logged (error class only) and never changes the analysis outcome (best-effort, like the audit row). The one deliberate exception: if the **claim** cannot be written (a database error other than "an attempt is already in flight") the analysis fails closed rather than run without single-flight protection.

Verified (suite section 5, 6 and the fault-injection run): provider 503 -> HTTP 502 `PROVIDER_UNAVAILABLE`, class `provider_unavailable`; 504 -> 504 `PROVIDER_TIMEOUT`, `provider_timeout`; 4xx-class -> 502 `PROVIDER_BAD_REQUEST`, `invalid_request`; no answer at all -> 504 `AI_SERVICE_TIMEOUT`, `provider_timeout`; a failure **after** the response window (202 first, then 503) is persisted and readable; no provider text, raw prompt/output or secret anywhere.

**503 retry unchanged:** the Workstream 1 policy is untouched (exactly one retry, only provider 503, no retry for 504, timeouts, 4xx, validation or persistence failures). Verified with the production Python code and faults injected at the SDK boundary (section 11): 503 -> one retry -> success; 503, 503 -> failure after exactly two attempts; 504, timeout, 400, 401 -> one call each; Node itself never retries.

## 8. Security / tenant isolation

- Every attempt row is workspace-scoped; every read and write filters by the **membership-verified** workspace (never a request value), and the Signal is looked up in that workspace first, so a foreign Signal id is a 404 and **no marker is ever written for it**.
- Workspace B (own `workspaceId` or a forged one) cannot read A's attempt state (403/404), cannot attach to A's analysis, and cannot cause one: refused, **zero provider calls, zero attempt rows** (tests 9.1-9.3).
- Authorization is unchanged: starting an analysis needs `intelligence:generate` (and the AI-tier limiter); reading the state needs `intelligence:view` (a viewer may read it, 403 on starting; 401 without a token); an invalid id is 400, an unknown one 404 (9.4, 9.5). The route inventory/authorization probe (Phase 19) now covers the new route for all four roles: 1,013 passed, 0 failed.
- The correlation id stored on a marker is a canonical uuid (lower-cased) or absent; found by regression: an upper-case id had crashed marker creation, now normalised exactly as the admission row does.

## 9. Safety, Decision and Action gating verification

- An in-progress or failed analysis grants nothing: no Intelligence exists, so a Decision cannot be proposed (the attempt's own ids and a non-existent analysis id are refused, 400/404), and no Decision, Action or Outcome exists (10.1). The generic Action/Outcome creation routes stay closed (nobody holds `action:execute`, 10.2).
- Once the analysis is stored the existing flow is unchanged and nothing is duplicated: Decision 201 -> approved -> Action 201 -> approved -> Outcome 201, exactly one record each; a later analyze call returns the stored analysis (10.3).
- The deterministic safety policy, the claim/prose/identifier validators, the confidence ceiling and the sanitiser are untouched (no file of theirs was modified; section 12) and the pipeline that applies them is called exactly as before. The known electrical-fire gap and the hazard-failure wording remain separate decisions.
- Learning stays OFF: the flag is never set and no admission row used it.

## 10. Test results

New suite `backend/scripts/validate-analysis-attempt-5a.mjs`: **46 passed, 0 failed** (isolated local database, the deterministic test AI service behind a scripted loopback proxy, spawned backends; zero Gemini calls). Coverage: the three boundaries and the untouched provider deadline/retry constants (0.x); attempt creation, completed-result reuse and status (1.x); the 202 in-progress answer, same-attempt coalescing and persistence after the response ended (2.x); concurrency in one process, across two processes and a direct claim race (3.x); browser disconnect (4.x); failure persistence for 503/504/4xx, a failure after the window, and an explicit new attempt after failure (5.x); provider timeout (6.x); restart, SIGKILL, provider work outliving Node, stale-marker expiry and graceful shutdown (7.x); a marker owned elsewhere (8.x); workspace isolation and authorization (9.x); Decision/Action gating and the unchanged downstream flow (10.x); marker content, correlation id, Learning, lifecycle cascade (11.x).

Regression:

| Run | Result | Class |
|---|---|---|
| New suite | 46 passed | PASS |
| AI-service pytest | 518 passed (unchanged: 481 + the 37 Workstream 1 tests) | PASS |
| Backend validation suites, default environment (same runner and database as the baselines) | **96 suites, 65 exit 0** (baseline 95 / 64, plus the new suite); 7,540 assertions passed, 32 failed. Compared suite by suite with the pre-5A run, the only differences are **(a) `validate-phase19-route-inventory` 1,001 -> 1,013 passed** (the new route probed for four roles) and **(b)** eight HTTP-dependent suites that fail in the default environment both before and after but now stop one step earlier (see below) | PASS vs baseline |
| The HTTP-dependent suites on the throwaway test stack | **identical to the baseline**: `validate-api` 261/0, `validate-import` 195/0, `validate-intelligence-persistence` 64/0, the knowledge suites, `validate-ai-service` 24/0, `validate-dev-token` 14/0; with the AI-service token requirement off: knowledge-embedding 42/0, knowledge-visibility-api 144/0, intelligence-analysis-api 81/0, phase24 60/0 | PASS |
| Frontend `npm run build` | OK; bundle hash identical to the pre-5A build (no frontend change) | PASS |

Failures that remain are the documented ones: EXPECTED/BASELINE (Phase 27/29-32 baseline counts, Phase 33-Lite/real, Phase 38 D5, Phase 41 C3/C6, Phase 45A, 45B.2.2 G4, dashboard) and ENVIRONMENT (the HTTP-dependent suites in the default environment; `validate-phase26*`; `validate-provision-dev-identity`). The change in (b): during this run **the long-running AI service on port 8000 was not running** (it had been up during the baselines and is not part of this work), so those suites now fail at "Python AI service reachable" instead of at the next connection; they pass on the test stack.

**Regression findings that were fixed (not hidden):** (1) a real defect: an upper-case request id made marker creation throw (Phase 37 suite); fixed in the service. (2) Contract/inventory suites that correctly noticed new surface: the Phase 19 route inventory (new route), the Phase 38 index classification, environment-contract completeness (the new optional variable), the generated index table and the observability event table; all brought up to date (section 12). (3) Two suites asserted the *old* limitation that two instances can both call the model (Phase 37 C2/C3); updated to the new, stronger guarantee. (4) Phase 41's count of unique indexes (17 -> 19). (5) The Phase 45C `C6` failure seen once looks like a pre-existing flake in the suite (by its source it replaces the last character of a token with `A`, which is sometimes already that character); it passed on re-run and does not touch the changed code.

## 11. Provider-call counts

| Source | Provider calls |
|---|---|
| New suite (deterministic test AI service behind the proxy) | exactly as asserted per scenario: success 1; second request in flight 1 (not 2); 12 concurrent 1; 4 across two processes 1; completed-result reuse 0 new; browser disconnect 1; each failure case 1 (Node never retries); marker owned elsewhere 0; foreign workspace 0; killed Node 1 (spent, nothing stored); stale re-run +1 (2 in total for that Signal). **0 Gemini calls** |
| Controlled verification (scratchpad; the production Python app with its retry and events, faults injected at the Gemini SDK boundary, a real Node backend on an isolated database, new lifecycle in the path) | A normal: **1 real Gemini call**; B 503 then retry: **2 provider calls (the 503 injected, the retry real)**; C 504: 1 (injected); D 503+503: 2 (injected); E timeout: 1 (injected); F 400: 1 (injected); G 401: 1 (injected). **Real Gemini calls: 2.** Each scenario's attempt row matched its outcome (`succeeded`; `failed` with `PROVIDER_TIMEOUT`/`provider_timeout`; `PROVIDER_UNAVAILABLE`; `PROVIDER_BAD_REQUEST`/`invalid_request`; `PROVIDER_AUTHENTICATION_FAILED`/`authentication`); repeat request returned the stored result with 0 calls; Decision/Action/Outcome journey unchanged; no duplicates; logs free of tokens, keys, Mongo URI, Signal text, guest data (the harness's windowed log read raced with Node's asynchronous flush for 5 scenarios, as in Workstream 1; the full-log correlation join was 7/7) |
| Atlas / staging | not contacted |

## 12. Change boundary

**Production source (9 files; 2 new):** `src/models/AnalysisAttempt.js` (new), `src/models/index.js`, `src/services/analysisAttemptService.js` (new), `src/services/intelligenceAnalysisService.js`, `src/controllers/intelligenceController.js`, `src/routes/intelligenceRoutes.js`, `src/config/runtimeConfig.js`, `src/services/workspaceLifecycleService.js`, `server.js`.

**Tests and test tooling (7 files; 1 new):** `scripts/validate-analysis-attempt-5a.mjs` (new); `scripts/validate-phase19-route-inventory.mjs` (the new route added to the audited table); `scripts/validate-phase37-reliability-gate.mjs` (C2/C3 now assert the cross-instance guarantee instead of the old limitation); `scripts/validate-phase41-atlas-readiness.mjs` (19 unique indexes); `scripts/lib/authFixtures.mjs` (the orphan sweep also removes orphaned attempt markers of deleted throwaway workspaces); `scripts/phase38/index-inventory.mjs` (classification of the two new unique indexes). No unrelated failing test was altered to make a suite green.

**Docs (2 existing + this report):** `docs/PRODUCTION_ENVIRONMENT_CONTRACT.md` (the optional `KOI_ANALYSIS_RESPONSE_WINDOW_MS` row and the three new index rows), `docs/PRODUCTION_OBSERVABILITY.md` (six `analysis.attempt_*` event rows).

**Not changed (hash/mtime verified; no repository file other than those listed is newer than the start of this workstream):** the AI service (all of it), the Gemini model and prompt, `provider_policy.py`, `config.py`, `provider_errors.py`, `provider_observability.py` and the 503 retry, `aiServiceClient.js`, `safetyPolicy.js` and every validator/sanitiser/confidence module, `intelligenceService.js` (persistence), `models/Intelligence.js`, Decision/Action/Outcome services and gating, Learning, RAG, authentication, `logEvent.js` and `requestId.js`, the frontend (bundle hash identical), `.env` and `.env.example` files, `.claude`, `CLAUDE.md`, deployment configuration.

Other facts: the production Atlas database was not contacted; all database work was on throwaway local databases that were dropped (the new suite's, the verification's and the regression runs'); no processes remain from this work; 2 real Gemini calls were made (section 11); no commit, push or deploy; Learning not used. A new collection (`analysisattempts`) and its three indexes are created by the application's own index initialisation on first start of a deployed backend, like every other model; none was created in Atlas.

## 13. Deferred items for 5B (frontend / status UX)

- Handling the HTTP 202 `in_progress` answer and bounded polling of `GET /api/intelligence/analysis-status/:signalId`; the in-progress, succeeded and failed presentations; replacing the "took too long, try again" message for the case where the analysis is still running or later succeeded.
- The **safety-aware** failure and in-progress wording (a hazard report must not receive the neutral "try again"): a policy-owner decision using only the existing deterministic classification; the status read does not yet carry that classification and none was added.
- The browser's own timeout and polling cadence; refreshing a page whose analysis finished while it was away (the status read makes this possible).
- `docs/` for API consumers: the 202 response and the status route.

## 14. Deferred items for 5C (provider deadline and measurement)

- Raising the provider/Gemini deadline (design target about 60 s, to be validated) together with the AI-service timeout, **both ceiling constants** (`provider_policy.py`, `runtimeConfig.js`) and the start-up checks.
- Decoupling the Node -> AI-service call timeout (the attempt lifetime, still derived from `KOI_AI_TIMEOUT_MS`, which also sets each retrieval/embedding call timeout) from the response window and from the retrieval timeout; re-deriving the 503-retry first-attempt budget (3 s) for the new attempt lifetime.
- Raising the staleness horizon in step with a longer attempt lifetime (it is derived from the request deadline, which already accommodates a 60 s analysis).
- Validating the target with the existing provider events on real traffic; hosting-proxy timeouts (unknown; no deployment configuration exists); behaviour under concurrency and several instances.
- Also deferred (not planned for 5C unless approved): any durable recovery of an interrupted attempt, which would need a queue and a worker.

Work stopped after this report. 5B and 5C were not started.
