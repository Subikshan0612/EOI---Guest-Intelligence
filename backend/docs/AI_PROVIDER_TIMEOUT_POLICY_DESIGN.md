# EOI analysis timeout policy - design review (Workstream 4)

Status: **DESIGN ONLY.** No production source, test, `.env`, prompt, model, output limit, safety policy, retry behaviour, frontend, Learning or deployment configuration was changed; nothing was committed, pushed or deployed; Atlas was not contacted. This report is the only repository file written. The one experiment run for this review (section 6) used a throwaway local stack from the scratchpad and was removed afterwards.
Sources used as authoritative: `AI_PROVIDER_RELIABILITY_DIAGNOSTIC.md`, `AI_PROVIDER_RELIABILITY_MEASUREMENT.md`, `AI_PROVIDER_OBSERVABILITY_503_RETRY_IMPLEMENTATION.md`, `AI_PROVIDER_SLOW_STATE_PROBE.md`, `AI_PROVIDER_SLOW_STATE_LONG_WINDOW.md`, `EOI_CURRENT_STATE_HEALTH_CHECK.md`, plus a read-only inspection of the current code.

Evidence labels used throughout: **PROVEN** (directly measured or demonstrated), **STRONGLY SUGGESTED** (consistent across independent runs but not directly shown), **REQUIRES VALIDATION** (inference or untested).

## 1. Executive conclusion

1. **The deadline question is no longer "is 20 s too short?" but "should EOI wait for the answer at all?"** Production-shaped Gemini requests legitimately took 25.0 s and 52.9 s during a slow-state-like period (PROVEN, 2 of 10 slow calls in Workstream 3B), while the browser waits at most about 30 s and the whole synchronous chain is ordered around 20 s. A synchronous design that tolerates 25-60 s waits would push every layer, and the person's patience, out together.
2. **Recommended architecture: a hybrid ("bounded synchronous window + server-side continuation + status read"), not a bare timeout increase.** Keep answering within the current window (about 25 s, which fits inside the browser's 30 s) when Gemini is fast, which is most of the time; when it is not, answer immediately with an explicit "analysis in progress" state while Node continues the **same, already-started provider call** up to a longer provider deadline (design target: about 60 s, to be validated), persist the result exactly as today, and let the page read the state until it finishes. This is Option D below. It is deliberately **not** a job queue or a background worker.
3. **The current Node code already behaves correctly in the two properties this design leans on** (PROVEN here by test, section 6): Node keeps running and persists the result after the browser disconnects, and a "Try again" sent while the first call is still in flight joins that call (one provider call, one record). What is missing is the *visibility* of an in-flight analysis (nothing records or reports "in progress") and a way to let the call run longer than the HTTP response window.
4. **Decisions in one line each:** the Gemini deadline should **remain at about 20 s for now and be raised only as part of the hybrid** (to about 60 s, validated afterwards); Node's response window should **stay about 25 s**, but the provider/continuation budget must be **decoupled from it** and extended; the browser should **not** become indefinitely synchronous: synchronous for the first window, then status-based; an async/continuation model **should be the next implementation workstream**, staged so that no wait is ever lengthened before the person can see an in-progress state; the 503 retry rule can stay as it is; the 504 retry question stays deferred. Details in section 11 and the closing statements.

What this report does **not** claim: no p95/p99 for any duration (Workstream 3B had 18 requests, 10 slow), no failure percentage for any deadline other than the 20 s deadline that was actually run in production-boundary measurements.

## 2. Evidence from Workstreams 1-3B

| Source | What it established | Label |
|---|---|---|
| Health check (staging) | 7 of 23 staged analyses were rejected for provider reasons (3 x 504 at 18.7-20.5 s, 4 x 502); success latencies had a median of 7.3 s one day and 14.3 s on the day with timeouts | PROVEN (counts), the day-level shift is descriptive |
| Diagnostic | failures originate at Gemini (503 "high demand", 504 DEADLINE_EXCEEDED); none in Node, Python, retrieval, validation, persistence or auth; the 20 s deadline is shared by the SDK, Gemini's server-side deadline (`X-Server-Timeout`) and the cross-service ceiling | PROVEN |
| Workstream 1 | one correlation id end to end; one 503 retry (first attempt must have failed within 3 s; 1 s delay); 504, timeouts and 4xx never retried; persistence and idempotency unchanged | PROVEN (66 new tests: 37 AI-service + 29 Node; controlled fault-injection run) |
| Workstream 2 (production boundary, 20 s deadline, 50 requests) | 36 succeeded, 14 failed (11 x Gemini 504 at 17.0-19.8 s, 2 x client read timeout at about 20.05 s, 1 x 503+503); 13 of the 14 within an 8-minute window; success was 55% (16/29) in that window and 95% (20/21) in the fast periods; Node's 25 s was never reached (maximum 21.2 s); successful outputs were 522-1,223 tokens against a 4,096 cap | PROVEN for this window |
| Workstream 3A (direct probe, 90 s deadline) | 29 of 29 requests 2.7-5.1 s; no slow state occurred | PROVEN; answered nothing about slow-state completion |
| Workstream 3B (direct probe, 90 s deadline, 18 requests over 68 minutes) | a slow-state-like period appeared at about 13:17 UTC and lasted at least 38 minutes; 10 of 18 calls took 11.3-52.9 s; **all 10 completed successfully**: 8 within 20 s (3 of them at 16.4-19.0 s), **25.0 s and 52.9 s beyond it**; none beyond 60 s; throughput fell to about one fifth (median 42 vs 226 output tokens/s); output size did not explain duration (correlation about -0.1); all five categories affected; no provider error of any kind | PROVEN for these 18 calls |

What the evidence together supports:

- **PROVEN:** a 20 s provider deadline truncates requests that Gemini would have completed (the 25.0 s and 52.9 s calls; the Workstream 2 504s are the same phenomenon seen from the production side, at 19.3-19.8 s).
- **STRONGLY SUGGESTED:** slow-state-like periods are provider-wide and time-bound rather than content-driven (they cluster in time, span every category, and identical inputs succeed or fail depending on the moment); they occurred in three separate windows on 12 October (about 10:27-10:53 UTC, 11:41-12:00 UTC, 13:17 UTC onward, the last still running when sampling stopped).
- **REQUIRES VALIDATION:** how long and how often such periods last beyond one day; the tail beyond 53 s; how many of the Workstream 2 504s would have completed at what time; behaviour under concurrent load.

## 3. Current timeout chain (read from the code, not changed)

| Layer | Setting (default as run) | Source | Role |
|---|---|---|---|
| Browser, analysis request | **30,000 ms** (axios timeout on `analyzeSignal`); other calls 15,000 ms | `frontend/src/services/api.js` | the person's waiting window; on expiry shows "took too long ... try again" (`CLIENT_TIMEOUT`) |
| Node HTTP server | request/header read timeouts 60 s / 15 s (these bound the *incoming* request only); **socket idle timeout 120,000 ms** | `server.js`, `getHttpTimeouts` | no relevance below 120 s; nothing aborts the handler when the client disconnects |
| Node internal request deadline | 110,000 ms (socket timeout minus a 10 s margin) | `getAnalysisTimeBudget` | caps retrieval + analysis together; retrieval gets what is left after the analysis call's full timeout is reserved |
| Node retrieval | each call min(20,000 ms, remaining), up to 10 pages, 85,000 ms total; fails closed | `knowledgeRetrievalService`, `nextRetrievalCallTimeoutMs` | retrieval is typically about 1 s |
| **Node -> Python analysis call** | **25,000 ms** = `KOI_AI_TIMEOUT_MS` (20,000, no override) + min(5,000, 25% of it); aborted with `AbortController` | `getAiAnalysisTimeoutMs`, `aiServiceClient.js` | must exceed the Gemini ceiling; startup check enforces it on the gemini route |
| Python endpoint | none of its own; a synchronous endpoint run in a worker thread, not cancelled when the caller goes away | `routers/analysis.py` | the thread runs until the provider call returns or fails |
| **Python -> Gemini** | **20,000 ms** per attempt (SDK read timeout; SDK also sends `X-Server-Timeout: 20`, so Gemini enforces the same limit server-side); SDK retry off | `ai-service/.env`, `config.py`, `gemini_analysis_client.py` | **the dominant deadline** |
| Cross-service ceiling | 20,000 ms constant in both services (`PROVIDER_TIMEOUT_CEILING_MS`, `AI_PROVIDER_TIMEOUT_CEILING_MS`); each side validates itself at start | `provider_policy.py`, `runtimeConfig.js`, `startupChecks.js` | forbids a larger provider timeout without a code change on both sides |
| 503 retry | one retry, 1 s delay, only if the first attempt failed within 3,000 ms | `provider_observability.py` | worst case 3 + 1 + 20 = 24 s, inside Node's 25 s |
| Hosting proxies / load balancers | **unknown**: no deployment configuration exists in the repository | `DEPLOYMENT_TOPOLOGY_AND_RECOVERY_PHASE38.md` | NOT VERIFIED; a synchronous response beyond 30-60 s may be cut by the host regardless of any setting here |

**Effective ordering today:** Gemini 20 s < Node wait 25 s < browser 30 s < Node deadline 110 s < socket 120 s. **Which dominates (PROVEN in Workstream 2):** the Gemini/SDK 20 s deadline: all 13 timeout failures ended at 17-20.5 s of provider time; neither Node's 25 s nor the browser's 30 s was reached.

Structural coupling that matters for any change: Node's analysis wait is *derived* from the same setting (`KOI_AI_TIMEOUT_MS`) that also sets the timeout of each retrieval and embedding call, so raising the analysis deadline by changing that one value also loosens retrieval; the analysis wait, the retrieval call timeout and the provider deadline are three different concerns held by one number. The 3 s first-attempt rule for the 503 retry was derived from the 25 s wait.

## 4. Candidate deadline comparison: 20 / 25 / 30 / 45 / 60 seconds

Method and limits: the only deadline for which failure behaviour was **measured** is 20 s (Workstream 2: 14 of 50 failed; 13 of 29 in the slow stretch). For the others the only data are the 18 provider durations observed with a 90 s deadline, so the table reports **which observed durations would have fitted**, not a failure rate. It is a descriptive count over 18 calls (10 slow), not a probability and not a percentile.

Observed provider durations (3B): fast 2.9, 3.2, 3.4, 3.4, 3.9, 3.9, 4.0, 9.4 s; slow 11.3, 13.4, 13.9, 13.9, 14.9, 16.4, **18.2, 19.0, 25.0, 52.9** s.

| Provider deadline | The four reference completions (18.2 / 19.0 / 25.0 / 52.9 s) | Observed calls that fit (of 18; of the 10 slow) | Node wait implied by the current formula (D + up to 5 s) | Versus the browser's 30 s | Worst wait for a person when the provider is stuck | Status |
|---|---|---|---|---|---|---|
| **20 s** (today) | 18.2 yes (1.8 s margin); 19.0 yes (1.0 s); 25.0 **no**; 52.9 **no** | 16 (8) | 25 s | Node < browser: ordered | about 20 s | **measured in production**: 14/50 failed, 11 as Gemini 504 at 19.3-19.8 s |
| **25 s** | 25.0 fits by **14 ms** (24,986 ms): not a real margin | 17 (9) | 30 s | equal to the browser: a tie, the browser may give up first | about 25 s | untested; no failure rate can be stated |
| **30 s** | 25.0 yes (5 s margin); 52.9 **no** | 17 (9) | 35 s | Node > browser: the browser must change or it abandons the wait first | about 30 s | untested |
| **45 s** | same as 30 s in this sample (no observed completion between 30 and 45 s); 52.9 **no** | 17 (9) | 50 s | browser must change | about 45 s | untested; adds nothing observed over 30 s |
| **60 s** | all four yes; 52.9 with a 7.1 s margin | 18 (10) | 65 s | browser must change; hosting proxies become relevant | about 60 s | untested; **the only candidate with no observed completion truncated**; resting on a single 52.9 s point |

Reading the table:

- **Truncation risk:** at 20 s, PROVEN truncation of completable work (2 of 10 slow calls in 3B). At 25 s the improvement is one observed call by 14 ms, which any ordinary variation would reverse; it is not a meaningful setting. At 30 and 45 s, one of the two observed beyond-20 s completions is still lost. At 60 s no observed completion is lost, but with 10 slow calls the position of the tail is unknown: **insufficient sample size to determine** how many completions would exceed 60 s.
- **Effect on 504 failures:** a Gemini 504 DEADLINE_EXCEEDED is Gemini's server-side enforcement of the deadline the SDK sends, so a longer deadline moves the point at which it occurs; with a 90 s deadline none of the 10 slow calls produced one (PROVEN for that sample). The reduction at 30/45/60 s is **REQUIRES VALIDATION**; the failure percentage at those deadlines is not estimated here.
- **User waiting:** a successful slow call means a 25-53 s wait; a stuck call means waiting the full deadline before an error appears (about 20 s today, up to 60 s at the top candidate). Nothing measured says that hung calls exist beyond 53 s; nothing excludes them.
- **Safety-critical requests:** every extra second of a synchronous wait is a second a person reporting a hazard sees no assessment and, today, no indication that EOI recognised a hazard (section 9).
- **Node budget:** Node's 110 s request deadline accommodates a 60 s analysis plus retrieval (retrieval budget 85 s to 40-45 s), so Node's *deadline* is not the obstacle; Node's *analysis wait* (25 s today) and its derivation from the retrieval setting are.
- **Browser:** any synchronous deadline of 25 s or more collides with the browser's 30 s; the hard-coded 30 s would have to move above the Node wait, which lengthens the blocking wait for everyone. If the browser gives up first, Node still finishes (section 6), so the result exists but the page reports a failure.
- **Python / Node after a disconnect:** see section 6.

## 5. End-to-end synchronous model analysis

Under the current model one HTTP request carries the whole analysis. Extending it (Options A and B below) means moving, in lockstep: the Python provider timeout, both ceiling constants and their start-up checks, Node's analysis wait (and decoupling it from the retrieval timeout), the browser's hard-coded 30 s, possibly the Node socket timeout if D approaches 100 s, and whatever the hosting proxies impose (unknown). It is a fragile, many-place change; its failure mode is a mismatch between layers (a layer that gives up before the one beneath it), which produces the worst outcomes: a result stored while the person was told it failed.

Is a synchronous model still appropriate? **For the fast case (about 3-5 s, most requests), yes.** For a slow case that can legitimately take 25-53 s, a synchronous HTTP request is a poor fit: the longest waits are exactly the least predictable, one stuck call blocks a browser tab and a worker thread, and the browser's 30 s was set for a world of 3-20 s answers. The evidence does not justify abandoning the synchronous path for everything (that would add latency and moving parts for the fast majority); it does justify not relying on it for the slow tail.

## 6. Browser disconnect analysis

**Current behaviour (code inspection, then tested).** No request-abort handling exists on the analysis route (no `close` listener, no abort signal passed to the service), so a browser disconnect does not stop Node. Python's endpoint is a synchronous function in a worker thread and is not cancelled if its caller goes away; Python is only affected when *Node* aborts (its own 25 s wait), and the ordering 20 s < 25 s means that does not happen in normal operation today.

**Test performed for this review** (isolated local stack, the unmodified production code, real Gemini via the scratchpad launcher; two real Gemini calls; throwaway DB dropped; nothing in the repository touched):

| Case | Result |
|---|---|
| Client aborts 1.5 s after sending | the analysis still ran to completion (about 6 s) and was **persisted by Node**; exactly 1 provider call, 1 accepted admission row (**PROVEN**) |
| A later "Try again" for that Signal | HTTP 200 with the stored record and **no provider call** (**PROVEN**) |
| Client aborts, then immediately re-sends (the "Try again" the UI offers) while the first call is still in flight | the re-send **joined** the in-flight call (single-flight): 1 provider call, 1 record, the re-send received it at about 7 s (**PROVEN**) |

**What this means.**
- If the client disappears, the analysis is **not lost**: it completes and is stored, visible on the next read or on "Try again". The page, however, has already told the person it failed ("took too long ... try again"), because the browser's timeout wording is the same as a server timeout's. Today this inconsistency window is small (Node answers by 25 s, the browser waits to 30 s); with any longer synchronous deadline it becomes the normal slow-state experience.
- The page reads the stored assessment on open/refresh and re-reads after a generation attempt finishes; it does **not** poll (code inspection). So a result that arrives after the browser gave up is visible only after a refresh or a "Try again".
- Single-flight is **in-process** only (documented): two backend instances can both call the model; the unique index then keeps one record. With calls lasting up to a minute, the cost of that duplicate window grows with the deadline.
- **Not tested here:** a Node restart in the middle of a call (the call and its result would be lost with the process; nothing records that it was in flight), a Node abort while Python continues (orphaned Python/Gemini work; irrelevant at 20 s < 25 s, relevant if the provider deadline ever exceeds Node's wait).

## 7. Async / job model analysis

Four options were assessed against the criteria requested. "Idempotency" here means the existing rule that one stored analysis exists per (workspace, Signal, level) and that a repeat request returns it with no model call.

| Criterion | A. Sync, simply raise every timeout | B. Sync, bounded longer timeout (about 30 s) | C. Fully asynchronous (always return at once; poll) | D. Hybrid: sync window, then continuation + status |
|---|---|---|---|---|
| Correctness | unchanged validation/persistence; risk of layer mismatch | same, smaller mismatch | same pipeline, new attempt state to keep consistent | same pipeline; attempt state must agree with the stored record |
| Reliability | long held connections; hosting proxies unknown; one stuck call blocks a tab and a worker thread up to D | modest; still truncates the 52.9 s call | removes dependence on any HTTP wait; Node restart loses an in-flight call unless state is durable | fast path unchanged; slow path survives browser loss; Node restart still loses the in-flight call (marked stale) |
| UX | up to D of spinner; if the browser limit is not raised, "failed" while the result is later stored | up to 30 s of spinner | a status screen for every analysis, including fast ones (extra latency or push mechanism) | fast answers as today; slow ones show an explicit in-progress state |
| Safety | longest silent wait for a hazard; no pending indication | same, shorter | pending state must carry existing deterministic classification | same as C but only the slow case needs it |
| Implementation complexity | low in code, high in coordination (many constants, browser, host) | low-moderate | highest (state model, status API, UI states, restart handling) | moderate-high (same state model, but the sync path stays) |
| Observability | existing events suffice | existing | needs attempt-state events | needs attempt-state events; Workstream 1's correlation id carries over |
| Duplicate prevention / idempotency | in-process single-flight only; the duplicate window grows with D | same | durable in-progress marker makes it cross-instance | durable in-progress marker recommended (same) |
| Browser disconnect | Node completes (proven), the page shows a false failure | same | a refresh shows the true state | a refresh shows the true state |
| 503 retry | 3 s rule keeps valid (D + 5 s wait keeps the 5 s margin), re-derive if the margin changes | same | not bound by a request wait | not bound by a request wait in the continuation |
| 504 behaviour | moves to D | moves to 30 s | moves to the continuation deadline | moves to the continuation deadline |
| Persistence semantics | unchanged | unchanged | Intelligence unchanged; new attempt-state record | same as C |
| Decision/Action gating | unchanged (needs a stored Intelligence) | unchanged | unchanged | unchanged |
| Fit with current architecture | simple, but fights the 30 s browser and 120 s socket design | simple | large departure; a worker/queue conflicts with the project's "no background AI workers" rule if built as a queue | small departure: the same call continues in the same process |

Verdicts:

- **A (simply raise everything): not recommended.** It makes the slowest, least predictable waits the browser's default experience, depends on unverifiable hosting behaviour, and still produces the stored-result-but-"failed" mismatch at the edges.
- **B (bounded longer, about 30 s): not recommended as the answer.** It converts at most one more observed completion (25.0 s) and loses the 52.9 s one; it can serve only as a stopgap and still requires the browser change.
- **C (full job model): the logical end state if volume or operations demand it, but not the first step.** It adds a status path for every analysis and, if implemented as a queue with workers, conflicts with the project rule against background AI workers and with its cost-control stance (generation is user-triggered only).
- **D (hybrid): recommended** (next section).

Decision/Action creation stays safely gated under every option **by construction**: proposals require a persisted Intelligence (an in-progress or failed attempt exposes nothing to propose), and the persisted Intelligence is written only after full validation, as today.

## 8. Hybrid model analysis (the recommended shape, at design level)

Design sketch (no implementation implied; names are placeholders):

1. **Bounded synchronous window.** `POST /intelligence/analyze/:signalId` waits as today (target: unchanged, about 25 s, keeping the browser's 30 s valid) and returns 201/200 with the analysis when it is ready in time.
2. **Continuation of the same call.** If the provider call is still running at the end of the window, Node answers immediately with an explicit "in progress" status (for example HTTP 202) and **keeps awaiting the same in-flight call** up to a longer provider deadline (design target about 60 s). No second call, no queue, no worker, no schedule: the continuation is the already-started user-triggered call finishing. On success it persists exactly as today (full validation first); on failure it records the rejection as today.
3. **Durable attempt state.** A minimal persisted marker (workspace, Signal, level, correlation id, started-at, status in-progress/succeeded/failed, a staleness horizon) so that (a) any instance can report "in progress", (b) a second instance does not start a duplicate provider call (a unique partial index on the in-progress marker is the natural guard), and (c) a Node restart leaves a marker that expires to "interrupted" rather than "in progress forever". It is audit/operational metadata like `AnalysisAdmission`, not Intelligence, consistent with the principle that facts and AI-derived records stay separate. Whether it extends the admission record or is its own record is an implementation decision.
4. **Status read.** A workspace-scoped read (same authorization as reading Intelligence) returning only the attempt status, never model content; the page reads it with a bounded backoff while an analysis is in progress. How the page presents it is a UX workstream (section 12).
5. **Decoupled deadlines.** Separate the three things currently derived from one setting: the response window (about 25 s), the provider/continuation deadline (target about 60 s, validated afterwards), and the retrieval/embedding call timeout (unchanged 20 s). Raise the cross-service ceiling constants on both sides together with the Python timeout.
6. **Python stays request/response.** No change to its role; it simply may be asked to wait longer for Gemini. At 40 default worker threads and a 60 s worst-case hold, sustained capacity is roughly 0.67 stuck calls per second, far above what the AI-route rate limit (10/min per identity, 30/min per workspace) allows; this is arithmetic from defaults and REQUIRES VALIDATION under load.
7. **Rate limiting.** Status reads must not consume the AI-tier limit.

Why 60 s as a design target (and not 45 or 90): it is the smallest candidate that does not truncate any observed completion (52.9 s, 7.1 s margin); 45 s would still lose it; 90 s was the probe's observation limit, not a measured need, and holds a thread and an attempt marker longer for hung calls. It is a **starting target to validate with the existing Workstream 1 events** (provider.attempt durations), not a derived guarantee.

Open implementation questions this sketch leaves: whether in-process continuation is acceptable under the project rule that generation is user-triggered only with no background AI workers (the continuation adds no call and no worker, but it does mean work continues after the HTTP response; this needs explicit approval, see section 14); how long an in-progress marker lives; whether a Node restart should offer an automatic re-ask (no: that would be an automatic retry) or only a manual "Try again".

## 9. Safety-critical behaviour analysis

Boundary: **no new safety policy is proposed.** The existing deterministic handling is the boundary: `deriveSafetyPolicy` (gas, smoke, CO and fire cues, access refusal, required/forbidden action types, minimum urgency) is evaluated by Node from the Signal alone and enforced on the model's output; the Signal also carries a server-derived structured issue (for example `gas_supply/safety_hazard`) from intake. Today these classifications are used only inside the admission of a *successful* analysis and are not shown to the person.

What currently happens when the provider is slow or unavailable for a gas, smoke, CO or access-refusal-with-hazard report (PROVEN in the diagnostic and Workstream 2): the Signal is stored (severity `medium`, with the server-derived hazard issue), no Intelligence, Decision or Action exists, one rejected admission row records the failure, and the person sees the same neutral "temporarily unavailable / took too long, please try again" message as for any other report. In Workstream 2 a safety request failed with a client timeout in the slow stretch; in the health check, 6 of 7 life-safety and electrical attempts succeeded and one (carbon monoxide) failed once with a 504. The state is data-safe (nothing fabricated or half-saved, nothing executed) but **not hazard-aware**.

How each timeout architecture bears on that, using only existing mechanisms:

| Architecture | Effect on a hazard report |
|---|---|
| Today (20 s) | fails quickly (about 20 s) with the neutral message; "try again" is the only path; no hazard signal reaches the person |
| A / B (longer sync) | a longer silent wait before the same neutral failure (up to 30-60 s); no hazard indication during the wait |
| C / D (status-based) | the in-progress/failed status is the natural carrier for the **existing** deterministic classification: the server already knows the Signal is a hazard from intake; it could be reported alongside "in progress" or "failed" without any model involvement. Defining that wording and its prominence is a policy and UX decision (the separate safety-aware failure workstream); this design only notes that the status model makes it possible and that a long sync wait does not |

Rules that must hold in every option (unchanged): a hazard report must never get a model-free recommendation invented on its behalf; nothing may be auto-executed; Decision and Action proposals remain impossible without a stored, validated Intelligence; the enforcement of the existing minimum urgency and required/forbidden action types on a *successful* analysis is untouched. The unaddressed gap the earlier reports flagged (sparks and a burning smell classify `NORMAL` in the deterministic policy) is a safety-policy matter and out of scope here.

Recommendation within the boundary: do not lengthen any wait for a hazard report before the person can see an in-progress or failed state that does not rely on the model; sequence the work accordingly (section 12).

## 10. 503 retry interaction

Current rule: exactly one retry; only for a provider HTTP 503; 1 s delay; only if the first attempt failed within 3 s; 504, timeouts, 4xx, 5xx other than 503, transport errors, validation and persistence failures are never retried. The 3 s first-attempt rule exists so that first attempt + delay + provider timeout fits inside Node's wait with 1 s of headroom.

| Architecture | Does the rule stay valid unchanged? | Notes |
|---|---|---|
| Today (20 s) | yes | worst case 24 s inside 25 s |
| A / B (sync, D up to 60 s, Node wait derived as D + 5 s) | **yes, numerically**: the 5 s cap on the margin means first (3 s) + delay (1 s) + D still leaves 1 s of headroom for every D of 20 s or more; but the justification must be re-checked if the margin is ever changed, and a retry after a slow 503 holds the person's wait longer | REQUIRES VALIDATION |
| C / D (response window decoupled from the provider deadline) | the rule keeps its value (a 503 is typically fast, 1.5-3.4 s) but its reason changes: it no longer protects a Node wait, it bounds the total continuation (3 + 1 + 60 s) | keep unchanged initially |

Only 1 of 50 requests in Workstream 2 had a 503 and its retry also failed (0 of 1; **insufficient sample size to determine** recovery); Workstream 3B saw no 503. There is no evidence to change the rule.

**504 retry:** not implemented and not proposed. Inference only (REQUIRES VALIDATION): since slow-state-like periods lasted at least 15-38 minutes and Workstream 2's 504s were consecutive within one 8-minute window, an immediate second attempt after a 504 would likely meet the same state while costing a full extra wait; the better lever is the deadline itself. A 504 retry should be reconsidered only with data gathered after the new architecture exists.

## 11. Recommended architecture

**Option D: the hybrid**, built behaviour-preservingly in stages, with these properties:

- Fast analyses behave exactly as today (answer within the window, HTTP 201/200, same body).
- A slow analysis returns an explicit in-progress state at the end of the window and completes in the background of the same process within a longer, decoupled provider deadline (design target about 60 s, to be validated), persisting only after full validation; the person (or any instance) can read the state; "Try again" never starts a second call while one is in flight, even across instances.
- A durable attempt marker with a staleness horizon makes the in-flight state visible and de-duplicates across instances; a Node restart marks the attempt interrupted and never silently re-runs it.
- Nothing about validation, sanitisation, the safety policy, Decision/Action gating, Learning (OFF), the model, the prompt or the output limit changes.
- The Workstream 1 correlation id and events extend to attempt-state transitions; the same events are the instrument for validating the 60 s target (provider duration distribution on real traffic).

Strength of the recommendation: **PROVEN** that a 20 s deadline truncates completable work and that Node already survives disconnects and de-duplicates in-flight retries; **STRONGLY SUGGESTED** that slow-state-like periods recur and that a bounded longer deadline plus visibility is the right shape; **REQUIRES VALIDATION**: the 60 s value, hosting-proxy behaviour, behaviour under concurrency and multiple instances, the tail beyond 53 s.

## 12. Recommended immediate next workstream

**Workstream 5: analysis attempt lifecycle (backend first, behaviour-preserving), then the presentation.** Staged so that no wait is lengthened before it is visible:

- **5A (backend, no visible behaviour change).** Decouple the three deadlines; add the durable attempt marker with the in-flight uniqueness guard and staleness horizon; add the status read; add the continuation path **behind the existing endpoint with the provider deadline still at 20 s**, so the continuation path is built and tested without ever triggering in production (the window and the provider deadline coincide). Observability events for attempt transitions. Verify with the existing disconnect and fault-injection techniques (including the cases listed as untested in section 6).
- **5B (presentation).** The page's in-progress/failed states and bounded status polling, **together with the safety-aware failure wording**, which needs a decision by the policy owner and uses only the existing deterministic classification.
- **5C (enable).** Only after 5A and 5B exist: raise the provider deadline (and the ceiling constants on both sides) to the validated target, enable the 202 window, and measure with the existing events.

Pre-conditions to settle before 5A starts (decisions, not code): approval that in-process continuation of a user-triggered call is compatible with the project's "no background AI workers / no background generation" rule; the hosting topology's proxy timeouts (currently unknown); the policy owner for hazard-failure wording.

## 13. Explicitly deferred decisions

- The exact provider deadline (60 s is a validated-later target; 45 and 90 s were considered and not chosen).
- Whether to ever add a durable job queue/worker (Option C proper), and under what cost-control conditions.
- A 504 retry, and any change to the 503 retry beyond keeping it.
- The browser's final timeout and polling cadence; all UX wording and layout, including hazard wording.
- Whether the attempt marker extends `AnalysisAdmission` or is a separate record, and its retention.
- Multi-instance deployment details beyond the unique in-progress guard.
- Any change to the output limit, prompts, model, Learning, or the deterministic safety policy (including the known electrical-fire gap).

## 14. Risks and unknowns

| Item | Status |
|---|---|
| Hosting proxy / load-balancer timeouts for backend and AI service | unknown; no deployment configuration exists; REQUIRES VALIDATION |
| Tail beyond 53 s; frequency, duration and recurrence of slow-state-like periods (three windows on one day; one 18-request sample) | unknown |
| Behaviour under concurrent users (Python thread occupancy at longer holds, provider behaviour under load) | unmeasured |
| The 60 s target rests on a single 52.9 s observation | REQUIRES VALIDATION |
| In-process continuation versus the project's "no background AI workers" rule | needs explicit approval |
| Node restart mid-call; Node abort while Python continues | not tested; designed for (stale marker) but unproven |
| Single-flight is process-local today; durable guard is a design proposal | known limitation |
| The unaddressed hazard-failure experience persists until 5B | known gap |
| Workstream 2's 20 s measurements and 3B's direct probe are different methods and are not pooled; the link "the 504s are the same slow calls" is an inference from two runs | inference |
| `CLAUDE.md` is stale in places (mock intelligence, no authentication) and was not used as a source of facts about the current system | note |

## 15. Change boundary

- Production source, tests, `.env` files, `.claude`, `CLAUDE.md`, prompts, model, output limits, safety policy, retry behaviour, frontend, Learning, deployment configuration: **not modified**.
- Atlas: **not contacted**. Commits, pushes, deployments: **none**.
- Repository files written: **this report only**. A check for repository files newer than the start of this workstream finds only it, and `git status` is unchanged.
- Scratchpad (outside the repository, since removed): one disconnect experiment (two real Gemini calls, a throwaway local database dropped by the script, processes stopped).

## Closing statements (the explicit answers requested)

- **Should the current ~20 s Gemini deadline remain?** For now, yes: raising it alone would move slow-state failures into the browser's 30 s window and produce a stored-but-"failed" experience. It is **proven** to truncate completable requests and **should be raised as part of the hybrid** (target about 60 s, validated afterwards), not before the in-progress state is visible.
- **Should it be increased?** Yes, but only inside the hybrid (stage 5C), to a validated target of about 60 s; no value between 25 and 45 s is recommended (25 s fits the 25.0 s call by 14 ms; 30 and 45 s still lose the 52.9 s call).
- **Should Node's current budget change?** The HTTP response window should stay about 25 s; the provider/continuation budget must be decoupled from it and extended; Node's 110 s request deadline already accommodates a 60 s analysis plus retrieval.
- **Should the browser remain synchronous?** Synchronous for the first window only; beyond it, status-based. Not indefinitely synchronous.
- **Should an async analysis/continuation model be the next implementation workstream?** Yes, as the staged hybrid (Workstream 5A/5B/5C) with an in-process continuation and a durable attempt marker; a general job queue/worker is deferred.
- **What must NOT be changed yet:** the Gemini deadline on its own; the browser's 30 s on its own; Node's analysis wait on its own or its coupling to the retrieval timeout in isolation; the 503 retry; any 504 retry; the output limit, prompts, model; the deterministic safety policy and Decision/Action gating; Learning; hazard-failure wording without the policy owner; hosting configuration.

Work stopped after this report. No implementation was started.
