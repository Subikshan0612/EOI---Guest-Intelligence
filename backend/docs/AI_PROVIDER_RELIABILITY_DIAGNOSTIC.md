# AI provider reliability - diagnostic investigation

Status: **DIAGNOSTIC ONLY.** Nothing was fixed or changed. No production source, prompt, timeout, retry count, model, provider, safety policy, Learning code, `.env`, flag, deployment configuration, `.claude` or `CLAUDE.md` was modified; nothing was committed, pushed or deployed. Date: 2026-10-12 (IST).
All measurements were taken on a throwaway local MongoDB and a purpose-started Node backend, talking to an AI-service instance that ran the **unmodified** service code with the **unmodified** configuration (its own `ai-service/.env`) and the real Gemini API. The instrumentation (a launcher that wraps the Gemini SDK call and records timing, sizes, token usage and the provider's exception) lives in the session scratchpad, outside the repository, and only observes: it calls the original function with the original arguments and re-raises the original exception. Staging (Atlas) was read through a driver-level read-only block (0 blocked attempts).

## Executive verdict

**The failures originate at Google's Gemini API, not in EOI's application layers. Confidence: CONFIRMED for where, LIKELY for why.**

1. Every provider failure captured with full detail (6 of 6 in the controlled sample) is an error response **returned by Gemini itself**: either `503 UNAVAILABLE - "This model is currently experiencing high demand. Spikes in demand are usually temporary."` (fast: 1.5-2.0 s) or `504 DEADLINE_EXCEEDED` (17.0-18.5 s). None was a Node, Python-internal, retrieval, validation, sanitizer, persistence or authentication failure. Not one analysis in this investigation failed after a Gemini response had been received.
2. Gemini's response time for this exact workload (4.8k input tokens, 550-1,100 output tokens, no thinking tokens) is **unstable and bimodal**: 13.6-17.7 s per call in a "slow" period, 3.2-5.3 s in a "fast" period, for the same prompt shapes and the same output sizes (about 40 output tokens/s vs 190-210). Both periods occurred within the same five minutes. In the slow period a call is already within 2-4 s of the configured 20 s limit, so any response that is a little longer (about 1,000 output tokens: contradiction and RAG-hit cases) cannot finish and ends in `504`. This is why the contradiction case (C1) and the RAG-hit case (E2) looked "scenario-specific" in the health check.
3. It is **not prompt-specific**: C1 and H1 failed 0 of 4 in the health check, yet H1 succeeded 3 of 3 and C1 3 of 3 (supplementary) once the provider was in its fast period. Same prompts, opposite results.
4. EOI's handling is correct and consistent (single attempt, 20 s provider timeout < 25 s Node timeout < 30 s browser timeout, one admission row per attempt, no partial persistence, no duplicate records, no downstream effects). The one weakness that matters for safety is **what a person is told** when a life-safety report cannot be analysed (see "Safety-failure behavior").

Overall classification of the 10/20 health-check failures: **mixed, provider-side**: transient capacity shedding (fast 503) plus slow-period timeouts (504 / client read timeout). Both are properties of the provider's service, observed in this environment, not defects in EOI's code path.

## Failure classification

Failure sources, with the evidence level for each (the final HTTP status was **not** used on its own to classify):

| Category | Count (all failures examined) | Evidence |
|---|---|---|
| **Gemini/provider 5xx (503 UNAVAILABLE "high demand")** | 3 of 6 in the controlled sample, **CONFIRMED** (Gemini's own response body captured). Health check: 5 of 10 had the same fast-failure signature (1.4-3.8 s; Node `PROVIDER_UNAVAILABLE`); staging: 3 of 7 (1.9-2.8 s). Counted as 503 by signature, not individually confirmed, except those in the sample | `gemini_call` records |
| **Gemini/provider timeout (504 DEADLINE_EXCEEDED returned by Gemini)** | 3 of 6 in the sample, **CONFIRMED** (provider code 504 / DEADLINE_EXCEEDED at 17.0, 17.2, 18.5 s). Health check: 2 of 10 (18.3 s LIKELY; 19.8 s confirmed as a provider 504 in the earlier AI-service log). Staging: 2 of 7 (18.7 and 19.7 s) are LIKELY the same, since only the provider can answer before the 20 s client limit | provider exception captured; durations below the 20 s SDK timeout can only be provider-originated |
| Client read timeout in the Python SDK (20 s) | Health check: 2 of 10 at 20.5 and 20.6 s (one confirmed as `ReadTimeout` in the Python log, the other LIKELY); staging: 1 of 7 at 20.5 s LIKELY | Python log |
| One unclassifiable 502 | health check run 1: 11.5 s, `PROVIDER_UNAVAILABLE`; staging: one at 4.9 s. Not individually traced (no per-call detail existed at the time) | UNKNOWN sub-cause; still class `provider_unavailable` |
| Node -> Python timeout | **0** (never reached: the Node limit is 25 s, the SDK limit 20 s, so Python always answers first; Python adds about 0.45 s on top of the Gemini call, Node's own pre-call work the rest) | timing |
| Python internal timeout / error | **0** | no Python exception other than the provider's |
| Retrieval timeout / failure | **0** (retrieval calls: 0.96-1.0 s, HTTP 200, in every case that used it) | probe HTTP records |
| Validation, sanitizer or persistence failure | **0** (every Gemini response that arrived passed all seven admission stages; `intelligenceRows` equals `accepted` admissions in every run) | admission rows |
| Authentication / token failure | **0** | no 401/403 on any call |
| Unclassified | the single 11.5 s and 4.9 s 502s above | UNKNOWN |

Aggregates by source:

| Source | Attempts | Failed | Failure types |
|---|---|---|---|
| Health check (previous task, four isolated runs) | 20 analysis calls | 10 | 6 x HTTP 502 `PROVIDER_UNAVAILABLE`, 4 x HTTP 504 `PROVIDER_TIMEOUT` |
| Staging history (Atlas, read-only) | 23 admissions | 7 | 4 x 502 (1.9, 1.9, 2.8, 4.9 s), 3 x 504 (18.7, 19.7, 20.5 s) |
| Controlled sample (this task, 18 planned attempts) | 18 | 6 | 3 x Gemini 503, 3 x Gemini 504 |
| Supplementary C1 check (this task) | 3 | 0 | - |

Staging pattern: 10 Oct 11:00-12:00 UTC: 3 rejections in 11 attempts, all fast 502 (success latencies that day 3.7-10.9 s, median 7.3 s, no timeouts); 12 Oct 06:00 UTC: 4 rejections in 11 attempts (3 timeouts, 1 fast 502; success latencies 11.5-16.5 s, median 14.3 s). **Timeouts appear only on the day the provider was slow; 502s appear on both.**

## Request-path trace

```
Browser (Assistant page; auto-called right after a report is sent, or by "Try again")
  POST /api/intelligence/analyze/:signalId?workspaceId=...           axios timeout 30,000 ms
Node: auth + RBAC (intelligence:generate) + AI-route rate limit (10/min per identity, 30/min per workspace)
  analyzeSignal()                                                     single-flight per (workspace, Signal, level), in this process
    runAnalysis(): LLM_PROVIDER must be an AI-service route; Signal read (tenant-scoped); stored analysis? -> return it, no model call
    buildOperationalContext()  (MongoDB reads, bounded, validated)
    retrieveKnowledgeOrThrow() (0..10 sequential Node->Python /v1/knowledge-retrieval calls, each <= 20,000 ms, together <= 85,000 ms; fails CLOSED)
    [Learning context: only if flag on - OFF]
    requestAnalysisFromAiService()                                    Node->Python POST /v1/intelligence/analyze, AbortController 25,000 ms
AI service (FastAPI; sync endpoint -> thread pool)
    token check; visibility filter; build prompt (system 15.7k chars + user 3.7-5.4k chars)
    genai.Client(timeout 20,000 ms, retry attempts=1).models.generate_content(model gemini-3.1-flash-lite, JSON schema, max_output_tokens 4096)
        SDK adds header X-Server-Timeout: 20  ->  Gemini enforces its own server-side 20 s deadline (-> 504 DEADLINE_EXCEEDED)
    exception -> map_provider_exception(): 429 rate-limited / 408,504 timeout / 401 auth / 403 forbidden / 404 not-configured / other 4xx bad-request /
                 5xx unavailable / httpx timeout -> timeout / transport error -> unavailable / else unknown      (never re-raised raw)
    response -> model identity check -> unusable-response check (safety block, empty, truncated) -> JSON -> pydantic contract -> authorized refs only
Node: mapAiServiceError() (closed table; raw text never forwarded) -> AppError(status, details.code)
    validateAndVerifyAnalysis(): schema -> identity -> claims -> safety policy -> prose consistency -> identifier guard -> confidence ceiling
    createAnalysisIntelligence()  (partial unique index: one stored analysis per (workspace, Signal, level))
    recordAnalysisAdmission()  - one audit row per attempt that passed the idempotency check (accepted or rejected, best-effort)
Browser: presentGenerationFailure({status, code, rule}) -> a fixed sentence; "Try again" is a manual click
```

Failure boundaries and what each produces:

| Boundary | Failure | Node `details.code` -> HTTP | Failure class (admission row) | Person sees |
|---|---|---|---|---|
| Node -> Python connect | refused / reset / DNS | `AI_SERVICE_UNREACHABLE` 502 | `provider_unavailable` | "temporarily unavailable. Please try again." |
| Node -> Python | Node abort at 25 s | `AI_SERVICE_TIMEOUT` 504 | `provider_timeout` | "took too long ... try again" |
| Python -> Gemini | Gemini 503/5xx or transport error | `PROVIDER_UNAVAILABLE` 502 | `provider_unavailable` | same "temporarily unavailable" sentence |
| Python -> Gemini | Gemini 504, or SDK 20 s read timeout | `PROVIDER_TIMEOUT` 504 | `provider_timeout` | "took too long ... try again" |
| Python -> Gemini | 429 | `PROVIDER_RATE_LIMITED` 503 | `rate_limit` | "busy ... try again" |
| Python | safety block / empty / malformed | `PROVIDER_SAFETY_BLOCK` 422 / `MALFORMED_RESPONSE` 502 | `safety_block` / `malformed_response` | fixed sentences |
| Node | admission rejects the model's content | `CLAIM_VALIDATION_FAILED`, `SAFETY_POLICY_VIOLATION`, ... 502 | `validation_failure` | fixed sentences |
| Node | persistence error | internal | `internal` (admission `phase: persistence`) | generic |

## Current timeout / retry configuration (read, not changed)

| Setting | Effective value | Source |
|---|---|---|
| Browser request timeout, generation | **30,000 ms** (`frontend/src/services/api.js`, `analyzeSignal`); other calls 15,000 ms | code |
| Node analysis timeout (Node -> Python `/v1/intelligence/analyze`) | **25,000 ms** = `KOI_AI_TIMEOUT_MS` (20,000, default; no override in `backend/.env`) + min(5,000, 25 %) | `runtimeConfig.getAiAnalysisTimeoutMs` |
| Retrieval / embedding call timeout (each Node -> Python call) | **20,000 ms** (`KOI_AI_TIMEOUT_MS`), further capped by the remaining retrieval budget | `knowledgeRetrievalService`, `nextRetrievalCallTimeoutMs` |
| Retrieval budget (all pages together) | **85,000 ms** (deadline 110,000 = socket timeout 120,000 - 10,000 margin; minus the 25,000 analysis reserve); at most 10 pages | `getAnalysisTimeBudget` |
| Node HTTP server | headers 15 s, request 60 s, socket 120 s, keep-alive 5 s | `getHttpTimeouts` |
| Python -> Gemini timeout | **20,000 ms** (`REQUEST_TIMEOUT_MS=20000` in `ai-service/.env`; validated 1..20,000 at start and per call) | `provider_policy.py` |
| Server-side deadline sent to Gemini | `X-Server-Timeout: 20` (set by the SDK from the timeout; SDK 2.23.0) | SDK source |
| Provider retry count | **none**: `HttpRetryOptions(attempts=1)` (one attempt) | `gemini_analysis_client.py` |
| Retry delay / backoff / circuit breaker | **none** | `provider_errors.py` ("classification only") |
| Node-level retry | **none**; frontend retry is a manual click only (the page also calls generation once right after a report is sent) | code |
| Single-flight | per (workspace, Signal, level), **in-process**; followers wait for the leader's record or failure; a failed leader is not retried | `analyzeSignal` |
| Model / output cap | `gemini-3.1-flash-lite`; `max_output_tokens` 4,096 | `ai-service/.env`, `config.py` |
| Ordering contract | Gemini deadline 20 s < Node 25 s < browser 30 s (startup check enforces Node > 20 s) | `startupChecks.js` |

## Controlled reproduction results

Setup: isolated local database; `NK` (no knowledge) and `K` (five synthetic knowledge documents, really chunked and embedded) workspaces; one fresh property/unit/guest/stay per case; Node rate limiter OFF in this harness backend only (so the limiter could not confound); 3 s between calls; round-robin over scenarios; **every attempt recorded**. A failed attempt was retried on the **same Signal** (what "Try again" does); after a success the next attempt used a fresh, identically shaped case. At most 3 attempts per scenario (18 in all). A defect in my own harness (a second case with the same room number was treated by intake as ambiguous, so 6 of the 18 planned attempts initially never reached analysis) was corrected and the **missing attempts were run afterwards** (nothing was dropped or re-rolled). A supplementary check of 3 extra C1 attempts is reported separately.

| Attempt | Start (UTC) | Scenario | Node total | HTTP / Node code | Python HTTP | Gemini call | Gemini result | Retry # | Before/after Gemini | Gemini response received | Validation reached |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 10:49:02 | A normal #1 | 17,275 ms | 201 | 200 / 17,099 | 16,637 ms | OK, 672 out | 0 | - | yes | yes (accepted) |
| 2 | 10:49:08 | B contradiction (C1) #1 | 2,043 ms | 502 `PROVIDER_UNAVAILABLE` | 503 / 1,990 | 1,528 ms | **503 UNAVAILABLE "high demand"** | 0 | **during** Gemini call | no | no |
| 3 | 10:49:30 | C injection (H1) #1 | 18,171 ms | 201 | 200 / 18,109 | 17,661 ms | OK, 627 out | 0 | - | yes | yes |
| 4 | 10:49:36 | D RAG miss (F2) #1 | 2,262 ms | 502 `PROVIDER_UNAVAILABLE` | 503 / 2,224 | 1,776 ms | **503 UNAVAILABLE "high demand"** | 0 | during | no | no |
| 5 | 10:49:57 | E safety hazard (G1) #1 | 18,181 ms | 201 | 200 / 18,134 | 17,692 ms | OK, 745 out | 0 | - | yes | yes |
| 6 | 10:50:21 | F RAG hit (E2) #1 | 19,991 ms | 504 `PROVIDER_TIMEOUT` | 504 / 18,914 | 18,471 ms | **504 DEADLINE_EXCEEDED (from Gemini)** | 0 | during | no | no |
| 7 | 10:50:42 | B C1 #2 (retry of #2) | 17,698 ms | 504 `PROVIDER_TIMEOUT` | 504 / 17,661 | 17,213 ms | **504 DEADLINE_EXCEEDED** | 1 | during | no | no |
| 8 | 10:51:02 | D F2 #2 (retry of #4) | 16,706 ms | 201 | 200 / 16,665 | 16,223 ms | OK, 711 out | 1 | - | yes | yes |
| 9 | 10:51:24 | F E2 #2 (retry of #6) | 18,519 ms | 504 `PROVIDER_TIMEOUT` | 504 / 17,447 | 17,000 ms | **504 DEADLINE_EXCEEDED** | 1 | during | no | no |
| 10 | 10:51:30 | B C1 #3 (retry of #7) | 2,197 ms | 502 `PROVIDER_UNAVAILABLE` | 503 / 2,158 | 1,703 ms | **503 UNAVAILABLE** | 2 | during | no | no |
| 11 | 10:51:39 | F E2 #3 (retry of #9) | 6,073 ms | 201 | 200 / 5,049 | 4,606 ms | OK, 975 out | 2 | - | yes | yes |
| 12 | 10:52:44 | A #2 (fresh) | 15,232 ms | 201 | 200 / 15,048 | 14,605 ms | OK, 788 out | 0 | - | yes | yes |
| 13 | 10:53:02 | C H1 #2 | 14,112 ms | 201 | 200 / 14,052 | 13,581 ms | OK, 738 out | 0 | - | yes | yes |
| 14 | 10:53:11 | D F2 #3 | 5,802 ms | 201 | 200 / 5,731 | 5,285 ms | OK, 704 out | 0 | - | yes | yes |
| 15 | 10:53:19 | E G1 #2 | 3,998 ms | 201 | 200 / 3,951 | 3,489 ms | OK, 675 out | 0 | - | yes | yes |
| 16 | 10:53:26 | A #3 | 3,647 ms | 201 | 200 / 3,604 | 3,152 ms | OK, 627 out | 0 | - | yes | yes |
| 17 | 10:53:33 | C H1 #3 | 4,106 ms | 201 | 200 / 4,062 | 3,619 ms | OK, 661 out | 0 | - | yes | yes |
| 18 | 10:53:41 | E G1 #3 | 4,133 ms | 201 | 200 / 4,088 | 3,644 ms | OK, 555 out | 0 | - | yes | yes |

Supplementary (C1, 3 further fresh cases, run after the above): 201 at 4.1 s, 5.2 s, 5.2 s (Gemini 3.5, 4.7, 4.6 s; 986, 1,025, 1,093 output tokens).

Results by scenario (main sample): A normal 3/3; B contradiction 0/3 (supplementary 3/3); C injection 3/3; D RAG miss 2/3; E safety hazard 3/3; F RAG hit 1/3. **12 of 18 succeeded; all 6 failures fell between 10:49:08 and 10:51:30; nothing failed after 10:51:39.** For every attempt: provider-retry count 0 (the SDK made exactly one HTTP attempt; "retry #" above counts a person's manual retries on the same Signal), no failure at or after validation, no failure before Gemini was called, no Learning (`learningUsed` 0 on all 21 admissions).

## Successful vs failed comparison

| Property | Successful Gemini calls (n=15, incl. 3 supplementary) | Failed Gemini calls (n=6) |
|---|---|---|
| Input prompt size (system + user chars) | 15,737 + 3,738-5,438 | 15,737 + 3,796-5,438 (identical ranges) |
| Input tokens | 4,777-5,352 | not returned |
| Node->Python request body | 1.67-1.82 kB (4.48 kB with RAG) | 1.73-1.81 kB (4.48 kB with RAG) |
| Retrieved context | 0 chunks, or 1 RAG hit (E2: 1 call OK in 4.6 s) | 0 chunks (3 x 503, C1 504) or the RAG hit (2 x 504) |
| Evidence refs / history items | same range | same range |
| Output tokens (successes) | 555-1,093 (about 1,000 for C1 and E2; 555-790 otherwise) | n/a |
| Thinking tokens | none reported (field empty) | n/a |
| Duration | 3.2-17.7 s (bimodal: 13.6-17.7 s slow, 3.2-5.3 s fast) | 503: 1.5-2.0 s; 504: 17.0-18.5 s |
| Scenario type | all | C1 x3, F2 x1, E2 x2 |
| Time of day | whole run | 10:49:08-10:51:30 only |

Hypotheses tested against the evidence:

| Hypothesis | Verdict | Why |
|---|---|---|
| A. Random provider availability | **CONFIRMED** for the 503s | Gemini's own response says so; the same F2 prompt (3,796 chars) failed with 503 once and succeeded 40 s later |
| B. Timeout-related | **CONFIRMED** for the 504s | Gemini enforces a 20 s deadline (`X-Server-Timeout: 20`) and answered 504 at 17.0-18.5 s; in the slow period successes took 13.6-17.7 s, so the tail crosses the line |
| C. Payload / context-size related | **UNLIKELY** | prompts differ by under 1.5k chars among successes and failures alike; input token counts 4.78-5.35k in both groups; failures occur at 1.8 kB and 4.5 kB bodies |
| D. Scenario / prompt related | **UNLIKELY as a direct cause; LIKELY as a modifier** | the same prompts later succeeded (C1 3 of 3 after the slow period, H1 3 of 3); but contradiction and RAG-hit analyses produce about 1,000 output tokens vs 550-790, so in the slow period (about 40 tokens/s) they cannot finish inside 20 s while shorter ones just do |
| E. Application-layer related | **REJECTED** | no failure after a Gemini response; Node/Python overhead 0.2-1.0 s; retrieval 1 s; 0 validation, sanitizer, persistence, auth failures |
| F. Mixed / unknown | **partly**: the cause of the provider's slow period itself (their capacity, routing or quota behaviour) is not observable from here |

## Provider evidence

- Model `gemini-3.1-flash-lite` (SDK `google-genai` 2.23.0); `response.model_version` matched the approved identity on every success. Retries: none (`attempts=1`).
- **503** body (captured verbatim, no key present): `503 UNAVAILABLE ... "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later."` Returned in 1.5-2.2 s, so it is load shedding at the provider, not a slow computation.
- **504 DEADLINE_EXCEEDED** returned by Gemini at 17.0-18.5 s of client time (before the SDK's own 20 s read timeout), consistent with the SDK-supplied server-side deadline. A separate ReadTimeout at 20.5 s was seen in the health-check re-run: the client limit won the race that time.
- Throughput: roughly 40 output tokens/s in the slow period (672 tokens in 16.6 s) vs 190-210 in the fast period (675 tokens in 3.5 s). The fast period also showed ordinary variation (3.2-5.3 s). A fast call (4.6 s, 975 tokens) occurred in the middle of the slow period, so the slow/fast switch is not a clean time window.
- Request size: system prompt 15,737 chars (constant) + user 3.7-5.4k chars = 4.8-5.4k input tokens. Response 1.8-3.2 kB. No thinking tokens reported, matching the code's own comment that none are used.
- **Not rate limiting from this side:** one request at a time, 3 s apart, 21 calls in about 5 minutes; no 429 occurred; the provider reported demand, not our quota.
- Python adds about 0.45 s on top of each Gemini call (client construction, validation); Node adds 0.05-0.2 s after it; retrieval takes 0.96-1.0 s and embeddings 1.0-1.2 s per call.
- What I could not observe: why the provider was slow, whether it is specific to this API key/project/region or the model's general load, and whether a different time of day or model variant behaves differently. Those need the provider's status/quota view or a longer sampling window.

## Error translation assessment

| Question | Answer |
|---|---|
| Does the chain preserve enough to tell **provider unavailable / timeout / validation failure / application failure** apart? | **Yes at class level, end to end.** `details.code` (wire), the admission row (`failureClass`, `reasonCode`, `httpStatus`, `decidedAt`, `latencyMs`) and the browser's fixed sentences all distinguish the four families. Two Node-side failure causes use different codes (`AI_SERVICE_UNREACHABLE` vs `PROVIDER_UNAVAILABLE`) but the same class and the same user sentence. |
| Secrets to the frontend? | None. The browser maps only `status`, `code`, `rule` to fixed sentences; no provider text, key, or model message is forwarded. |
| What is **lost** (and matters for production observability) | (1) Gemini's own status code and message are **not stored**: a 503 "high demand", a 500, and a connection reset all become `PROVIDER_UNAVAILABLE`; a Gemini 504 and an SDK read timeout both become `PROVIDER_TIMEOUT`. Python logs only `Gemini provider error: <taxonomy> status=<code>` at ERROR level on stdout (the message text and the duration are not logged). (2) **No correlation id** is sent from Node to Python, so an admission row cannot be tied to a Python log line except by timestamp. (3) The admission row records Node's HTTP status (502/504), not the provider's. (4) No token counts, prompt size or provider latency are recorded for failures (and Python's own timing is not logged). (5) No alerting on rate. |
| Sufficient for production observability? | **No, not yet.** It is sufficient to tell an operator "the provider is the problem" but not "which kind, how often, how slow, and for which calls". The distinction that drove this whole investigation (fast 503 vs slow 504 vs slow-period tail) could only be recovered because I added external instrumentation. |

## Retry safety assessment

Reviewed, not changed. Evidence from the controlled sample: every failed attempt left **0 Intelligence** for its Signal and exactly **1 rejected admission row**; every success left exactly 1 Intelligence; across 21 calls `intelligenceRows` = accepted admissions and no duplicates exist (partial unique index).

| Risk | Assessment |
|---|---|
| Duplicate persistence / duplicate analysis records | **Safe.** Persistence happens only after full validation; a unique index allows one stored analysis per (workspace, Signal, level); a repeat call after success returns the stored record with no model call (`created: false`). |
| Duplicate downstream actions | **Safe.** Decisions/Actions/Outcomes can only be proposed from an existing Intelligence; none existed after any failure (`decisions: 0, actions: 0`). |
| Single-flight consistency | **Safe in one process** (health check: 3 concurrent calls -> 1 model call, 1 record). **Not shared across instances**: two backend instances could both call the model; the unique index then keeps one record. |
| A model-side success lost after Node gives up | Not observed (Node's limit exceeds the SDK's); if persistence failed after a successful call, the paid result would be discarded and a retry would pay again (`phase: persistence` is audited). |
| Unnecessary provider load | **Real but bounded.** A "Try again" always costs a full provider call; there is no backoff or circuit breaker. During an incident a person can keep clicking; the AI-route limiter (10/min per identity, 30/min per workspace) bounds it. The page also makes one automatic call right after each send. Fast 503s cost almost nothing (about 1.5-2 s, no tokens); slow 504s burn up to 20 s each. |
| Adding provider retries later | Python's call is stateless and idempotent (no side effects until Node persists), so a retry inside the AI service would be safe with respect to persistence; the time budget (20 s per attempt vs Node 25 s) is the constraint. |

## Safety-failure behavior

Tested by pointing a throwaway backend at an unreachable AI service (no Gemini), for a gas-smell report (G1), a gas smell with an access refusal (G5) and a normal AC report (A1), and by reading the code. This is **exactly what currently happens** when the analysis cannot be produced:

- The Signal is stored (status `new`, severity `medium`) with the server-derived issue `gas_supply/safety_hazard/UNKNOWN` (the AC case: `air_conditioner/temperature_fault/not_cooling`). The intake reply to the person is the normal "I've recorded this report. My assessment is based on ..." message.
- `POST /intelligence/analyze` returns an error; the person sees, for the unreachable case, **"The AI analysis service is temporarily unavailable. Please try again."** (for a Gemini 503/504: that sentence, or "took too long to complete. Please try again."). The sentence is identical for the gas report and the AC report.
- **No Intelligence, no Decision, no Action, no Outcome** exists; no Decision can be proposed (404). One rejected `AnalysisAdmission` row records the attempt (`provider`, `provider_unavailable`, 502).
- The deterministic safety policy (`deriveSafetyPolicy`) is evaluated **only inside the admission of a successful analysis**. After a provider failure its result (`LIFE_SAFETY_HAZARD`, `ACCESS_REFUSED`) is never computed for display, and the frontend does not use the Signal's `issue.problemFamily = safety_hazard` (which the Signal API does return). The Signal's own `severity` stays `medium`.

Assessment: **data-safe, not hazard-aware.** The application never fabricates or half-saves an assessment and never executes anything (a correct fail-closed state), but a person reporting a gas leak during a provider incident gets the same neutral "try again" message as for a dripping tap, with no indication that EOI recognised a life-safety hazard or that they should escalate by other means, and nothing in the stored Signal ranks it above other reports. This is not a defect of the error handling's mechanics; it is a product-behaviour gap that provider unavailability exposes. Exposure at the observed failure rate: the hazard case G1 succeeded 3 of 3 in the controlled sample; in the health check the life-safety scenarios (G1, G2, G3, G5, H3) plus the electrical case G4 succeeded on 6 of 7 attempts (G3 failed once with a 504 and succeeded on retry), so a hazard report can and does hit this path. Not changed; flagged for a decision.

## Root-cause confidence

| Suspected cause | Confidence | Basis |
|---|---|---|
| Gemini API sheds load with 503 "high demand" (fast failures) | **CONFIRMED** | provider response body captured 3 times; fast-502 signature in 5/10 health-check and 4/7 staging failures |
| Gemini slow period (about 40 tokens/s) pushes calls to 14-18 s and onward past the 20 s deadline (504) | **CONFIRMED** (mechanism observed), **LIKELY** (as the cause of the earlier health-check/staging timeouts: consistent durations and the day-level latency shift, but those calls were not instrumented) | 3 provider 504s with durations 17.0-18.5 s; successes 13.6-17.7 s in the same minutes; staging median success latency 7.3 s (no timeouts) vs 14.3 s (3 timeouts) |
| The 20 s limit (SDK + Gemini server deadline) is too tight for current Gemini latency | **LIKELY** | successes up to 17.7 s; outputs of about 1,000 tokens cannot complete at 40 tokens/s |
| Longer outputs (contradiction, RAG-hit analyses) make specific scenarios fail more often | **LIKELY** | C1 about 1,000 output tokens and E2 975; both failed most in the slow period; C1 3/3 and H1 3/3 when the provider was fast |
| Input-specific / prompt-triggered provider failure (C1, H1) | **REJECTED** (as the primary cause) | same prompts succeed in the fast period |
| Payload or retrieved-context size | **UNLIKELY** | similar sizes among successes and failures |
| Application layer: Node, Python, retrieval, validation, sanitizer, persistence, auth | **REJECTED** | 0 failures after a provider response; 0 non-provider failures anywhere |
| Rate limiting / quota exhaustion from EOI's own traffic | **UNLIKELY** | sequential calls, no 429 |
| The provider's own capacity condition (project quota tier, region, model variant, time of day) | **POSSIBLE** / **UNKNOWN** | not observable from the client side; needs provider-side view and a longer window |
| Network between this machine and Google | **UNLIKELY** | responses were Google error bodies, retrieval/embedding calls to the same API were stable at 1 s |

## Recommended fix (not implemented)

Smallest appropriate next change, in order of increasing scope:

1. **Observability first (no behaviour change):** in the AI service log the provider's HTTP status, a message class, the call duration and token usage per call; send a request id from Node to Python and log it; record the provider status in the admission row. This is the evidence the next decision needs, and it is tiny.
2. **Then, one bounded retry confined to the fast-failure case (provider 503 only) inside the AI service's Gemini client**, with a short delay (about 1 s). Rationale: it addresses the largest, cheapest-to-fix share of failures (503s are about half), costs nothing (the failed call returns in about 2 s, before any generation), is safe for persistence (stateless call; nothing is stored until Node validates), and fits the 25 s Node budget (about 2 s + 1 s + up to 20 s). It does not change the 504 behaviour and needs the Node/Python timeout contract re-checked. Estimated effect on the sample: 3 of 6 failures would have had a second chance.
3. **Separately, decide the timeout / output-length question** with data from step 1 (the 20 s deadline is shared by the SDK, Gemini's server-side deadline, the cross-service contract and the browser's 30 s): either measure and shorten the typical output, or raise the whole ordered chain together. Do not change one number alone.
4. **Separately, decide the safety-failure message** (a person reporting a gas, smoke or CO hazard should not see the generic "try again" without an escalation hint). That is a product and safety-policy decision and was explicitly out of scope here.

## What must NOT be changed

- The ordered timeout chain as separate edits (Gemini 20 s < Node 25 s < browser 30 s; the Node startup check and the Python bound enforce it): any change must move all of them together.
- The no-hidden-retry principle for the model path: any retry must be explicit, bounded, restricted to provider failures, and never applied after a received response or to validation failures.
- Fail-closed behaviour: nothing persisted on any failure; admission before persistence; one record per (workspace, Signal, level); single-flight.
- The safety policy and its enforcement (do not weaken or bypass it to "reduce failures"), the approved-model policy and provenance checks, the claim/prose/identifier validators, the confidence ceiling.
- Prompts and output schema (they are validated by suites and by the Phase 53 evaluation; changing them to shorten output is a separate, evaluated change).
- Provider/model selection (`gemini-3.1-flash-lite`) and server-side-only configuration; the AI service must keep its service-token protection.
- Error sanitisation: raw provider text must never reach the browser; the frontend's fixed sentences stay closed-table.
- Tenant isolation, RBAC, rate limiting on the AI route, the "generation only on explicit user action" rule.
- Learning (flag OFF; V2 deferred), `.claude`, `CLAUDE.md`, and all frozen artifacts.

## Change boundary (confirmations)

| Item | Answer |
|---|---|
| production source modified | **NO** |
| tests modified | **NO** |
| `.env` modified | **NO** (read for non-secret timeout keys only; the AI-service token was read at run time by the harness and never printed or stored) |
| flags modified | **NO** |
| staging / Atlas writes | **NO** (read-only admission history; driver-level write block; 0 blocked attempts) |
| synthetic production data created | **NO** (synthetic data existed only in throwaway local databases `koi_reliab_*` and `koi_failsafe_*`, dropped by the scripts; verified none remain) |
| Learning changed | **NO** (flag unset; `learningUsed` 0 on every admission) |
| `.claude` modified | **NO** |
| `CLAUDE.md` modified | **NO** |
| commits | **NO** |
| pushes | **NO** |
| deploys | **NO** |

Other facts for the record: this document is the only repository file written for this task (the instrumented launcher, harnesses and raw results are in the session scratchpad); the instrumented AI-service instance (port 8011) and the test backends (5330, 5340) were stopped; the long-running AI service on port 8000 was not touched. Gemini was called about 21 times for analysis (18 sample + 3 supplementary C1), plus 5 document-embedding requests and the retrieval query embeddings. Staging was inspected read-only.

After this report, work stopped. The recommended fix has not been started.
