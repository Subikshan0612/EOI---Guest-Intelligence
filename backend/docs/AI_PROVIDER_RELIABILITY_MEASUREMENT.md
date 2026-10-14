# AI provider reliability - measurement (Workstream 2)

Status: **MEASUREMENT ONLY.** Nothing in the repository was changed to produce these numbers; the only file written is this report. Date of the runs: 2026-10-12, 11:37-12:11 UTC (17:07-17:41 IST).
Baseline measured: the production boundary exactly as it stands after Workstream 1 (observability, correlation id, exactly one retry for provider HTTP 503; 504, timeouts and 4xx not retried).

## 1. Executive summary

- **50 real requests** through Node -> Python AI service -> real Gemini -> Python validation -> Node validation and persistence, across six scenario categories, interleaved and spaced about 12 s apart (about 2 requests per minute). No faults were injected in these.
- **36 succeeded, 14 failed (72% / 28%).** Every failure was a **provider-side** event: 11 requests ended in a **Gemini HTTP 504 DEADLINE_EXCEEDED**, 2 in a **client read timeout** at 20.05 s, and 1 in **two consecutive Gemini 503s**. There were **0** validation, sanitizer, persistence, authentication, Node-timeout or Python-internal failures.
- **Failures are clustered in time, not in content.** 13 of the 14 failures happened within an 8-minute stretch (11:47-11:55 UTC) while Gemini was running in a slow state (about 50 output tokens/s instead of about 200); the other failure came at 11:40:30. In the first 9 requests (fast) and the last 12 (fast again, after a 12-minute pause) there was 1 failure in 21 requests. All six categories failed at least once and succeeded at other times, and every scenario that failed also succeeded at another time.
- **503s were rare: 1 of 50 requests (2.0%) had a first-attempt 503** (2 of 51 provider calls). That one request retried once, and the retry also returned 503 (0 of 1 recovered). **The 503 retry recovery rate is therefore "insufficient sample size to determine"** (n = 1; one further incidental real 503 in the regression run also failed on retry, see section 16).
- **Gemini's own 20 s deadline is the binding limit, not Node's 25 s budget.** All 11 provider 504s arrived at 17.0-19.8 s (10 of 11 between 19.3 and 19.8 s), i.e. at the server-side deadline that the SDK requests (`X-Server-Timeout: 20`); the 2 client read timeouts fired at 20.05-20.07 s. **No request ever reached Node's 25 s limit** (maximum 21.2 s). In the slow state, successful calls took 11.7-18.8 s, so the 20 s ceiling sat only 1.2 s above the slowest success.
- **Output size is not what limits requests**: successful outputs were 522-1,223 tokens (median 754), far below the 4,096 cap; within a given speed state, output length explains little of the latency (correlation about 0.3). The dominant factor is the provider's speed at that moment (median 204 tokens/s in fast periods vs 51 tokens/s in slow periods).
- **Evidence-based recommendation (Workstream 3): investigate the 504/deadline behaviour before changing anything.** The data cannot say whether a longer deadline would turn the 504s into successes (those calls were cut off, so their true duration is unknown), and it does not support changing the output limit. Details in section 19.

## 2. Exact test environment

| Item | Value |
|---|---|
| Machine / OS | the developer workstation, Windows 11, Node v20.17.0, Python 3.12 venv |
| Backend under test | the repository's Node backend (`server.js`), spawned for the run on a throwaway local MongoDB database (dropped afterwards); stub authentication; Learning flag unset; **rate limiter ON (production default)** |
| AI service | the repository's FastAPI app, unmodified, started through a scratchpad launcher (`ai_probe.py`) that only **observes** the SDK call (timing, sizes, token counts, provider exception) and re-raises everything unchanged; its own `[KOI AI EVENT]` lines (Workstream 1) were the primary source for attempts, status and category |
| Provider | real Gemini API through the Google Gen AI SDK 2.23.0 |
| Production staging (Atlas) | **not contacted** |
| Data | synthetic cases built from the frozen Phase 53 dataset (read-only import); a fresh property, unit, guest and stay for every request; no operational history (see limitations); five synthetic knowledge documents for the RAG-hit workspace, really chunked and embedded |
| Order and pacing | six categories round-robin; 12 s pause after each request finished; stop rule: abort after 8 consecutive failures (it triggered once, as intended) |

## 3. Exact model and configuration used (read, not changed)

| Setting | Value |
|---|---|
| Model | `gemini-3.1-flash-lite` (approved model; `model_version` verified on every success) |
| Provider timeout (Python -> Gemini) | 20,000 ms per attempt (`REQUEST_TIMEOUT_MS`); the SDK also sends `X-Server-Timeout: 20` |
| Node analysis timeout (Node -> Python) | 25,000 ms (20 s base + 5 s margin) |
| Browser generation timeout | 30,000 ms (not exercised) |
| Output limit | `max_output_tokens` 4,096 |
| Retry | SDK retry off (`attempts=1`); one retry for provider HTTP 503 only, 1 s delay, only if the first attempt failed within 3 s |
| Prompt | unchanged: system prompt 15,737 characters; user prompt about 3.7-5.4k characters; 4,724-5,389 input tokens |
| Learning | OFF (`learningUsed` false on every admission) |

## 4. Sample size

| Batch | UTC window | Requests | Notes |
|---|---|---|---|
| 1 | 11:37:57-11:40:30 | 9 | the first round plus the start of the second (the batch ended early because of a defect in my harness's room numbering, which made later cases fail at intake before any provider call; those cases are not counted anywhere) |
| 2 | 11:41:37-11:55:46 | 29 | ended by the stop rule (8 consecutive provider failures): 36 were planned, 7 were deliberately not sent |
| 3 | 12:08:00-12:11:24 | 12 | run after a 12-minute gap (which also contained the regression check of section 16) |
| **Total** | | **50** (51 provider calls) | within the 30-50 target; no request was repeated in a tight loop |

An earlier launch (harness path error: the AI service never started) made 8 requests that failed at connection time with no provider call; they are not part of the sample.

## 5. Test matrix

| Category | Scenario ids (frozen Phase 53 dataset) | Workspace | Requests |
|---|---|---|---|
| A normal routine | A1 AC not cooling, A2 sink leak, A3 housekeeping, A4 refrigerator, A5 repeated AC | no knowledge | 9 |
| B RAG-hit | E1 AC, E2 toilet leak, E3 key card (matching guidance documents exist) | knowledge workspace | 9 |
| C RAG-miss | F1, F2, F3 (the same three reports with no guidance available) | no knowledge | 9 |
| D contradiction | C1, C2, C3 (report conflicts with the stay record) | no knowledge | 8 |
| E prompt injection | H1 (refund order), H2 (do not send anyone), H3 (ignore safety policy, gas), H4 (reveal instructions) | no knowledge | 8 |
| F safety / hazard | G1 gas, G2 smoke, G3 carbon monoxide, G5 gas with access refused | no knowledge | 7 |

A per-request appendix (correlation id, status, durations, attempts, tokens) is at the end. No prompt, output, guest detail or secret is recorded anywhere.

## 6. Raw aggregate counts

| Measure | Count |
|---|---|
| Requests | 50 |
| Provider calls (attempts) | 51 (36 success, 11 Gemini 504, 2 client read timeouts, 2 Gemini 503) |
| Successful requests | 36 (all on the first attempt) |
| Failed requests | 14 |
| First attempt succeeded | 36 |
| First attempt 503 | 1 request (2 attempts: 503 then 503) |
| First attempt 504 | 11 requests |
| First attempt client timeout | 2 requests |
| First attempt other provider status | 0 |
| 503 retry recovered | 0 |
| 503 retry failed | 1 (a second 503) |
| Failures not originating at the provider (validation, sanitizer, persistence, auth, Node timeout, Python internal) | **0** |
| Learning used | 0 |

## 7. Reliability metrics

| Metric | Value |
|---|---|
| Success rate (all 50) | **72.0%** (36/50) |
| Success rate, batches 1 and 3 (fast provider) | **95.2%** (20/21) |
| Success rate, batch 2 (slow provider) | **55.2%** (16/29) |
| 503 rate, requests with a first-attempt 503 | 2.0% (1/50); per provider call 3.9% (2/51) |
| 504 rate, requests | 22.0% (11/50); per provider call 21.6% (11/51) |
| Client timeout rate, requests | 4.0% (2/50) |
| Other provider failure categories | 0 |
| Final failure categories (14) | 504: 11 (79%); client timeout: 2 (14%); 503: 1 (7%) |

## 8. Latency percentiles

(p99 requires at least 100 observations; with n <= 51 the maximum is reported instead.)

Node total request duration (milliseconds; POST /intelligence/analyze, including database reads, retrieval, provider call(s), validation and persistence):

| Set | n | min | p50 | p75 | p90 | p95 | max |
|---|---|---|---|---|---|---|---|
| all requests | 50 | 3,242 | 15,290 | 19,269 | 20,247 | 20,540 | 21,240 |
| successful | 36 | 3,242 | 9,732 | 16,380 | 18,206 | 18,664 | 19,278 |
| failed | 14 | 6,654 | 20,014 | 20,465 | 20,991 | 21,202 | 21,240 |

Provider (Gemini) call duration, per call (the SDK call, as seen by the observer):

| Set | n | min | p50 | p75 | p90 | p95 | max |
|---|---|---|---|---|---|---|---|
| successful calls | 36 | 2,755 | 9,150 | 15,015 | 17,661 | 17,902 | 18,791 |
| failed calls | 15 | 1,718 | 19,472 | 19,752 | 19,943 | 20,058 | 20,065 |
| all calls | 51 | 1,718 | 14,430 | 18,387 | 19,701 | 19,767 | 20,065 |

The distribution of successful calls is **bimodal**, which the percentiles hide: in the fast periods (batches 1 and 3) successful calls mostly took 2.8-6.4 s (median about 4 s), with two exceptions of about 14 s and 16 s at the transitions; in the slow period (batch 2) they took 11.7-18.8 s.

## 9. 503 retry recovery analysis

| Case | Requests |
|---|---|
| 1. First attempt succeeds | 36 |
| 2. First attempt 503, retry succeeds | 0 |
| 3. First attempt 503, retry also fails | 1 (retry returned a second 503, 3.4 s) |
| 4. Other provider failures (504, client timeout; never retried by design) | 13 |

**503 retry recovery rate = 0 / 1 = 0%, with n = 1: insufficient sample size to determine.** The only real 503 in the sample occurred on a request at 11:53:46 inside the slow stretch; the first attempt answered in 1.7 s, the retry after the 1 s delay answered in 3.4 s with a second 503; total 6.7 s. For context only (not in the metric): the regression run (section 16) incidentally hit one more real 503 whose retry failed with a Gemini 499 CANCELLED at 19.5 s, also during the degraded period. Two failed recoveries during one degraded period say nothing about the recovery rate in general. Injected 503s are excluded from these numbers.

## 10. 504 and timeout analysis

| Observation | Value |
|---|---|
| Provider 504 DEADLINE_EXCEEDED | 11 requests; call duration 16,985 ms (once) and 19,297-19,766 ms (ten times); Node total 19.8-21.2 s |
| Client read timeout (SDK, 20 s) | 2 requests, at 20,055 and 20,065 ms; Node total 20.5 s |
| Node 25 s timeout reached | **0** (max Node total 21.2 s) |
| Python internal timeout | 0 |
| Public result | all 13: HTTP 504 `PROVIDER_TIMEOUT` (unchanged behaviour), nothing stored, one rejected audit row each |

Interpretation limits: the 20 s Gemini-side deadline (`X-Server-Timeout: 20`) and the 20 s SDK timeout are the same number, so a call that would have needed more than about 19.5 s is always cut off at about that time. The durations of those 13 calls are therefore **censored**: this data cannot say whether they would have finished at 21 s, 30 s or never. All 11 provider 504 durations lie within 17-19.8 s, matching the deadline, not a request-specific latency.

## 11. Output size vs latency

Successful calls only (n = 36; output sizes are the token counts the SDK reports; output text is never recorded):

| Measure | Value |
|---|---|
| Output tokens | min 522, p50 754, p75 863, p90 1,021, p95 1,096, max 1,223 (cap 4,096: never close) |
| Input tokens | min 4,724, p50 4,836, p90 5,367, max 5,389 |
| Correlation of output tokens with duration (all successes) | Pearson 0.29, Spearman 0.43 (weak to moderate) |
| Within fast calls (< 8 s, n = 18) | Pearson 0.30; median 204 output tokens/s |
| Within slow calls (>= 10 s, n = 18) | Pearson 0.26; median 51 output tokens/s |

Latency by output band (successful calls): < 700 tokens: n 8, median 4.1 s; 700-900: n 20, median 12.8 s; 900-1,100: n 6, median 8.9 s; >= 1,100: n 2, median 17.0 s. The bands are not ordered by size because the provider-speed state, not output length, dominates; the largest outputs were produced in both states (the longest, 1,223 tokens, took 16.0 s in the slow state; an 885-token output took about 4 s in the fast state).

What this supports: a 4x difference in tokens per second between periods; at the slow speed (about 50 tokens/s plus a fixed start-up of about 1-2 s) an output of about 900-1,000 tokens needs about 19-21 s. What it does not support: any claim about the outputs of the 14 failed requests (no response was received, so their lengths are unknown), or that shortening outputs would remove the failures. **Insufficient sample size to determine** a precise size threshold.

## 12. RAG hit vs RAG miss

Interleaved in time, so both faced the same provider conditions.

| | RAG-hit (n = 9) | RAG-miss (n = 9) |
|---|---|---|
| Success | 7 (77.8%) | 6 (66.7%) |
| Failures | 2 x provider 504 | 3 x provider 504 |
| Node total, all (p50 / p90 / max) | 15,978 / 21,194 / 21,240 ms | 13,512 / 20,249 / 20,259 ms |
| Node total, successful (p50 / p90 / max) | 15,415 / 17,731 / 19,241 ms | 8,056 / 15,786 / 18,060 ms |
| Gemini duration, successful (p50 / max) | 13,866 / 17,742 ms | 7,538 / 17,579 ms |
| Input tokens (median) | 5,368 (+11%) | 4,813 |
| Output tokens (median, successful) | 957 | 709 |
| Grounding | all 7 successes stored knowledge provenance | none (as designed) |

RAG-hit successes were slower (median 13.9 s vs 7.5 s of Gemini time) and produced longer outputs (957 vs 709 tokens) with a slightly larger prompt. But the success rates (7/9 vs 6/9) do not differ meaningfully at this sample size, and the median difference is confounded with which requests happened to fall into the slow period. **Insufficient sample size to determine** whether RAG-hit requests are slower or fail more often by themselves; retrieval itself took about 1 s per request and never failed.

## 13. Scenario / category analysis

| Category | n | Success | 503 | 504 | timeout | Node total p50 / p90 / max (all) | Node total p50 (successful) | Gemini p50 (successful) | Output tokens p50 | Input tokens p50 |
|---|---|---|---|---|---|---|---|---|---|---|
| A normal | 9 | 7 (78%) | 1 | 1 | 0 | 7.2 / 18.0 / 19.9 s | 7.2 s | 6.6 s | 736 | 4,819 |
| B RAG-hit | 9 | 7 (78%) | 0 | 2 | 0 | 16.0 / 21.2 / 21.2 s | 15.4 s | 13.9 s | 957 | 5,368 |
| C RAG-miss | 9 | 6 (67%) | 0 | 3 | 0 | 13.5 / 20.2 / 20.3 s | 8.1 s | 7.5 s | 709 | 4,813 |
| D contradiction | 8 | 5 (63%) | 0 | 2 | 1 | 17.5 / 20.2 / 20.5 s | 5.9 s | 5.4 s | 1,085 | 4,882 |
| E injection | 8 | 5 (63%) | 0 | 3 | 0 | 17.2 / 19.9 / 20.0 s | 4.0 s | 3.5 s | 719 | 4,807 |
| F safety | 7 | 6 (86%) | 0 | 0 | 1 | 16.3 / 19.2 / 20.5 s | 10.8 s | 10.3 s | 703 | 4,807 |

- Every category had both successes and failures, and every category's failures fall in the slow stretch. With 7-9 requests per category the differences in success rate (63%-86%) are well within what chance and timing alone would produce: **insufficient sample size to determine a category effect.**
- The scenario ids that failed also succeeded at other times, e.g. (UTC) C1 (contradiction): ok 11:38, ok 11:43, **timeout 11:52**, ok 12:09; H1 (injection): ok 11:39, ok 11:43, **504 11:55**, ok 12:09; E2 (RAG-hit): ok 11:40, ok 11:45, **504 11:54**, ok 12:10; F2 (RAG-miss): **504 11:40**, ok 11:45, **504 11:54**, ok 12:10; C2: ok 11:46, **504 11:55**, ok 12:10. Same input, opposite outcomes, determined by when it was sent.
- Contradiction cases produced the longest outputs (median 1,085 tokens) and had one of the lowest success rates, but they also completed in 5.9 s in fast periods; this sample cannot separate output length from timing for them.
- Safety / hazard requests (7): 6 succeeded; 1 (G5, gas with access refusal) failed with a client read timeout in the slow stretch. A hazard report is exposed to the same provider behaviour as any other.

## 14. Budget proximity analysis

Share of requests by total Node duration (n = 50) and of provider calls by Gemini duration (n = 51):

| Band | Node total, all requests | Node total, successful only (n = 36) | Gemini calls (n = 51) |
|---|---|---|---|
| < 10 s | 19 (38%) | 18 (50%) | 20 (39%) |
| 10-15 s | 4 (8%) | 4 (11%) | 9 (18%) |
| 15-20 s | 20 (40%) | 14 (39%) | 20 (39%) |
| 20-25 s | 7 (14%) | 0 | 2 (4%) |
| >= 25 s / timed out | 0 (0%) | 0 | 0 |

- **0 requests reached the 25 s Node budget** (max 21.2 s), so Node's wait is not currently the limiting factor.
- 40% of requests (and 39% of successes) took 15-20 s, i.e. within 5 s of the 20 s provider ceiling; the 14% in the 20-25 s band are all failures that ended at the provider deadline plus overhead.
- Gemini's own time versus the 20 s ceiling: 20 of 51 calls (39%) took more than 15 s; the slowest success was 18.8 s.

## 15. Real-provider results (summary)

All results above (sections 6-14) are real Gemini measurements through the full production boundary. By time (the main structure in the data):

| Period (UTC) | Requests | Successes | Failures | Successful-call median |
|---|---|---|---|---|
| 11:37-11:40 (fast start) | 9 | 8 | 1 (504 at 17.0 s, 11:40:30) | 4.3 s (3.2-6.4 s, plus one 13.9 s at 11:40:02: the transition) |
| 11:41-11:47 (slow, still completing) | 12 | 12 | 0 | 17.0 s (11.7-18.8 s) |
| 11:47:34-11:55:46 (slow, over the line) | 17 | 4 | 13 (10 x 504, 2 x client timeout, 1 x 503+503) | 12.8 s (12.5-15.9 s for the 4 successes) |
| 12:08-12:11 (recovered; after a 12-minute gap) | 12 | 12 | 0 | 3.7 s (2.8-6.4 s, plus one 16 s: the first RAG-hit call) |

The failures are not spread evenly: 13 of 14 occurred within 8 minutes. During the 6 minutes before them, 12 of 12 requests succeeded, every one at 11.7-18.8 s. The 12-minute gap before the last batch was not completely idle: the regression check of section 16 ran inside it and its three real provider attempts (a 503, a 499 and a 504) show the provider was still degraded shortly before it recovered.

## 16. Fault-injection regression results (separate from the measurement)

Regression check of the Workstream 1 behaviour using the existing fault-injection launcher (faults injected at the SDK boundary only; the production retry code, events and error mapping run unmodified; real Node backend, isolated DB). **These are not reliability data and are not counted above.**

| Scenario | Injected plan | Result | Provider calls | Verdict |
|---|---|---|---|---|
| 503 then (real) retry | 503, real | the retry reached the real provider and returned a real **504** (Node 504 `PROVIDER_TIMEOUT`) | 2 | PASS: exactly one retry after a 503, correctly classified (`PROVIDER_503` then `PROVIDER_504`), no third attempt |
| 504 | 504 | 504 `PROVIDER_TIMEOUT` in 0.5 s | 1 | PASS: no retry |
| 503 then 503 | 503, 503 | 502 `PROVIDER_UNAVAILABLE` | 2 | PASS: failure after exactly two attempts |
| client timeout | ReadTimeout | 504 `PROVIDER_TIMEOUT` | 1 | PASS: no retry |
| 400 | 400 | 502 `PROVIDER_BAD_REQUEST` | 1 | PASS: no retry; no provider message logged |
| 401 | 401 | 503 `PROVIDER_AUTHENTICATION_FAILED` | 1 | PASS: no retry |

Also checked: all 7 correlation ids differ, Node's analysis event, the audit row and the AI-service events share the same correlation id for every scenario (verified against the complete logs; my harness's windowed read raced with Node's asynchronous log flush and printed a false negative, as in Workstream 1), nothing sensitive in either log stream, no duplicate or partial records.
Harness expectations that did not hold, explained: scenario "A normal (real)" expected one provider call, but the **real** provider answered a genuine 503 (1.6 s) and then, on the retry, a genuine **499 CANCELLED at 19.5 s**: the retry happened exactly as designed. Observation for the record: the existing taxonomy maps a 499 `ClientError` to `PROVIDER_BAD_REQUEST` (public 502 "rejected the request"), although a cancel at 19.5 s resembles a deadline event rather than a bad request. No 499 occurred in the 50-request sample. (This was observed, not changed.)

## 17. Interpretation

Answers to the twelve questions, each limited to what the measurements support:

1. **Real 503 frequency:** 1 of 50 requests (2.0%); 2 of 51 provider calls (3.9%). Low in this window (compare 3 of 21 calls in the earlier diagnostic, which predates the retry; small samples both times).
2. **503 recovery through the retry:** 0 of 1. **Insufficient sample size to determine.**
3. **504 frequency:** 11 of 50 requests (22%); 11 of 51 calls.
4. **Timeout frequency:** 2 of 50 (4%), both client read timeouts at 20.05 s; Node never timed out.
5. **Other provider categories:** none in the sample (one real 499 in the regression run).
6. **Latency distribution:** section 8; successful calls bimodal (fast 3-6 s, slow 12-19 s).
7. **Output size vs latency:** weak (r about 0.3); provider speed state dominates (204 vs 51 tokens/s); outputs never near the 4,096 cap.
8. **RAG-hit vs miss:** hits slower on success (13.9 vs 7.5 s Gemini median) and longer outputs; failure rates similar. **Insufficient sample size to determine** an independent RAG effect.
9. **By category:** no category effect can be separated from timing at 7-9 requests each.
10. **Proximity to Node's 25 s:** none (max 21.2 s). Proximity to the 20 s provider ceiling: 40% of requests took 15-20 s; 13 requests ended at the ceiling.
11. **Are the current timeout/output constraints appropriate?** The output limit is not a constraint in practice (max 1,223 of 4,096). The 20 s deadline is the binding limit: in the slow state it cuts off a large share of requests (13 of 29 = 45% in batch 2) and clipped calls could not be observed to completion, so whether 20 s is "too short" or whether those calls would simply have been slower still (or never finished) **cannot be determined from this data.** In fast periods the same ceiling is irrelevant (one failure in 21).
12. **Provider-load-related rather than content-related?** The evidence points to the provider's state at the time: failures cluster within 8 minutes, span all six categories, and every failing scenario succeeded at other times with identical inputs. Whether that state is Gemini-side load, quota/tier behaviour of this key, region, or the model variant is **not observable from the client side** and is not claimed.

Causal summary (confidence): provider-side slow period producing deadline (504/timeout) failures: **LIKELY**; 503 behaviour: **UNKNOWN beyond its low frequency** (n = 1); request content as a cause: **UNLIKELY** (not excluded for 504 at long outputs); application layers (Node, Python, retrieval, validation, persistence): **REJECTED** for this sample (0 failures there).

## 18. Limitations

- **One machine, one API key, one model, one afternoon (34 minutes), two provider states.** The slow stretch lasted about 15 minutes; its recurrence, frequency and cause are unknown. A different time of day could look very different (staging history showed a similar slow day and a fast day).
- **No operational history in the prompts.** Cases were fresh; real workspaces add historical items, so real prompts (and latencies) may be somewhat larger than the 4.7-5.4k input tokens measured.
- **Failed calls are censored**: no response, so their output lengths and true durations are unknown; the latency distribution of successes is truncated at the 20 s ceiling.
- **Small samples:** 50 requests, 7-9 per category; only 1 request had a 503; percentiles above p95 are not reported.
- **Interleaving was chosen to spread categories over time, not to randomise them**; categories are not independent of time.
- The observer launcher is outside the production code; it adds negligible overhead but is not part of production.
- Throwaway synthetic data with a rate limiter ON; the load (about 2 requests per minute) is lower than a busy production workspace.
- Token counts come from the SDK's usage metadata (counts only); no output text was inspected or stored.
- The regression run's incidental real events (a 503 followed by a 499, and a real 504 on a retry) occurred in the degraded period and are reported separately; they are not part of any rate above.

## 19. Recommendation for Workstream 3

**Investigate the 504/deadline behaviour before changing anything. Do not change the output limit, the retry, or any timeout yet.**

Evidence for this choice:

1. 504 and client timeouts account for **13 of the 14** failures (93%); 503s account for 1.
2. The 504s arrive exactly at the configured deadline (19.3-19.8 s for 10 of 11; the SDK sends the same 20 s to Gemini), and in the slow state successful calls sit 1.2-8 s below it: the limit, not the application, decides the outcome. Yet because those calls were cut off, **the data cannot tell whether a longer deadline would convert them into successes**, so adjusting a timeout now would be a guess.
3. The output limit (4,096) is not binding (max 1,223 tokens); output length explains little within a speed state, so "adjust output limit only" is not supported. Shortening outputs would be a prompt/schema change that needs its own evaluation.
4. The 503 retry has too little evidence to judge (n = 1); it is cheap and safe, so keep it as it is.
5. Provider quality is currently **acceptable in fast periods and not acceptable in slow periods** (95% vs 55% success); "keep current settings" alone would leave 45% of requests failing whenever the slow state returns.

Suggested scope for Workstream 3 (measurement-first, no production change until the result is in):

- A scratchpad-only experiment that observes how long the slow-state calls actually take when the deadline is not the limiter (for example a parallel instrumented probe with a longer client/server deadline, never wired into the product), to learn the uncensored tail and what share of today's 504s would complete within, say, 25 s or 30 s. Only then decide between "raise the whole timeout chain together" (Gemini deadline, Node 25 s, browser 30 s, cross-service ceiling) and "leave as is and handle the failure better".
- A longer, low-rate monitoring window (for example one request every few minutes over a day) to learn how often the slow state occurs and how long it lasts, so the decision is not based on one afternoon.
- Independently of the timeout answer, a decision on the safety-failure experience: in the slow state a safety request (G5) failed too, and the user sees the same neutral "try again" message (this was a separate item in the earlier diagnostic and is not addressed here).
- A note for later triage, not for action now: Gemini's 499 CANCELLED is currently labelled "bad request".

## 20. Verification of the change boundary

| Item | Result |
|---|---|
| Production behaviour changed | **NO** |
| Model / prompt changed | **NO** |
| Timeout values changed | **NO** |
| Retry policy / timing changed | **NO** |
| Safety policy changed | **NO** |
| Learning changed | **NO** (flag never set; `learningUsed` 0 on every admission) |
| Frontend changed | **NO** |
| `.claude` / `CLAUDE.md` changed | **NO** |
| Production (Atlas/staging) writes | **NO** (not contacted) |
| Commits / pushes / deploys | **NO / NO / NO** |
| Files changed in the repository | **one: `backend/docs/AI_PROVIDER_RELIABILITY_MEASUREMENT.md` (this report, new)**. A check for any repository file newer than the start of the workstream found none besides it, and `git status` is identical to its state at the start (367 paths) |
| Database writes | local throwaway MongoDB databases only (created and dropped by the harnesses); no other writes |
| Gemini usage | 51 analysis calls in the measurement; 3 real analysis attempts in the regression run (one 503, one 499, one 504); 15 document-embedding requests and the per-request retrieval-query embeddings for the 9 RAG-hit requests. No Learning prompt was used |
| Left behind | no running measurement process; no throwaway database; harness, observer launcher and raw outputs are in the session scratchpad, outside the repository; the long-running AI service on port 8000 and the dev backend were not touched |

Work stopped after this report; Workstream 3 was not started.

## Appendix: per-request measurements (50 real requests)

Provider attempt entries read "HTTP status / category, milliseconds" (`ok` = success). Gemini ms is the observer's duration of each SDK call; tokens are the SDK-reported counts for the successful call. Correlation ids are random uuids (first 8 characters shown).

| # | batch | UTC | category | scenario | RAG | correlation id | HTTP | Node total ms | provider attempts (status/category, ms) | Gemini ms | output tok | input tok | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 11:37:57 | A_normal | A1 | - | 3ddde31d… | 201 | 4236 | ok 3594 | 3593 | 773 | 4819 | success |
| 2 | 1 | 11:38:14 | B_rag_hit | E1 | hit | c1c107e4… | 201 | 5438 | ok 3844 | 3830 | 935 | 5368 | success |
| 3 | 1 | 11:38:32 | C_rag_miss | F1 | miss | ea5b765b… | 201 | 3752 | ok 3218 | 3223 | 659 | 4810 | success |
| 4 | 1 | 11:38:49 | D_contradiction | C1 | - | 80b135bd… | 201 | 5850 | ok 5359 | 5353 | 1085 | 4882 | success |
| 5 | 1 | 11:39:07 | E_injection | H1 | - | 5e34aef0… | 201 | 3997 | ok 3516 | 3514 | 730 | 4807 | success |
| 6 | 1 | 11:39:24 | F_safety | G1 | - | cbaa1353… | 201 | 5362 | ok 4828 | 4837 | 620 | 4781 | success |
| 7 | 1 | 11:39:42 | A_normal | A2 | - | 8bb2d158… | 201 | 6865 | ok 6375 | 6373 | 736 | 4781 | success |
| 8 | 1 | 11:40:02 | B_rag_hit | E2 | hit | cf8726a1… | 201 | 15415 | ok 13859 | 13866 | 961 | 5365 | success |
| 9 | 1 | 11:40:30 | C_rag_miss | F2 | miss | 63a4266c… | 504 | 17480 | 504/PROVIDER_504 16985 | 16996 | - | - | fail PROVIDER_TIMEOUT |
| 10 | 2 | 11:41:37 | A_normal | A1 | - | 885a4c44… | 201 | 17568 | ok 16969 | 16964 | 741 | 4853 | success |
| 11 | 2 | 11:42:07 | B_rag_hit | E1 | hit | 1a6041a3… | 201 | 15978 | ok 14422 | 14430 | 766 | 5383 | success |
| 12 | 2 | 11:42:36 | C_rag_miss | F1 | miss | e7cfa57e… | 201 | 12251 | ok 11719 | 11714 | 587 | 4815 | success |
| 13 | 2 | 11:43:01 | D_contradiction | C1 | - | a06c209e… | 201 | 16514 | ok 16031 | 16019 | 1223 | 4911 | success |
| 14 | 2 | 11:43:30 | E_injection | H1 | - | 729be199… | 201 | 19278 | ok 18797 | 18791 | 754 | 4850 | success |
| 15 | 2 | 11:44:03 | F_safety | G1 | - | 6c154272… | 201 | 17450 | ok 16969 | 16957 | 755 | 4843 | success |
| 16 | 2 | 11:44:33 | A_normal | A2 | - | c2778315… | 201 | 15164 | ok 14688 | 14680 | 657 | 4851 | success |
| 17 | 2 | 11:45:01 | B_rag_hit | E2 | hit | d728f3f1… | 201 | 19241 | ok 17735 | 17742 | 1064 | 5389 | success |
| 18 | 2 | 11:45:33 | C_rag_miss | F2 | miss | 215e48be… | 201 | 18060 | ok 17578 | 17579 | 778 | 4847 | success |
| 19 | 2 | 11:46:04 | D_contradiction | C2 | - | e4f0800b… | 201 | 18472 | ok 17985 | 17982 | 1130 | 4921 | success |
| 20 | 2 | 11:46:35 | E_injection | H2 | - | 9097d319… | 201 | 15035 | ok 14547 | 14553 | 719 | 4844 | success |
| 21 | 2 | 11:47:03 | F_safety | G2 | - | 8b7fa0a4… | 201 | 18352 | ok 17875 | 17875 | 770 | 4832 | success |
| 22 | 2 | 11:47:34 | A_normal | A4 | - | aa45fcdd… | 504 | 19887 | 504/PROVIDER_504 19406 | 19405 | - | - | fail PROVIDER_TIMEOUT |
| 23 | 2 | 11:48:06 | B_rag_hit | E3 | hit | 2fb01786… | 504 | 21240 | 504/PROVIDER_504 19750 | 19746 | - | - | fail PROVIDER_TIMEOUT |
| 24 | 2 | 11:48:40 | C_rag_miss | F3 | miss | bceeef08… | 504 | 20259 | 504/PROVIDER_504 19766 | 19775 | - | - | fail PROVIDER_TIMEOUT |
| 25 | 2 | 11:49:14 | D_contradiction | C3 | - | cbf7e368… | 504 | 20076 | 504/PROVIDER_504 19593 | 19601 | - | - | fail PROVIDER_TIMEOUT |
| 26 | 2 | 11:49:46 | E_injection | H3 | - | 84b01034… | 504 | 19951 | 504/PROVIDER_504 19469 | 19472 | - | - | fail PROVIDER_TIMEOUT |
| 27 | 2 | 11:50:19 | F_safety | G3 | - | 3aa7eb51… | 201 | 16335 | ok 15859 | 15855 | 704 | 4839 | success |
| 28 | 2 | 11:50:48 | A_normal | A5 | - | 3f30b621… | 201 | 13000 | ok 12531 | 12528 | 781 | 4850 | success |
| 29 | 2 | 11:51:14 | B_rag_hit | E1 | hit | 14e27e03… | 201 | 14035 | ok 12547 | 12545 | 957 | 5374 | success |
| 30 | 2 | 11:51:41 | C_rag_miss | F1 | miss | 8ea1c482… | 201 | 13512 | ok 13032 | 13036 | 789 | 4817 | success |
| 31 | 2 | 11:52:07 | D_contradiction | C1 | - | 26066766… | 504 | 20533 | -/PROVIDER_TIMEOUT 20047 | 20055 | - | - | fail PROVIDER_TIMEOUT |
| 32 | 2 | 11:52:40 | E_injection | H4 | - | b0b5e4d3… | 504 | 19914 | 504/PROVIDER_504 19438 | 19443 | - | - | fail PROVIDER_TIMEOUT |
| 33 | 2 | 11:53:13 | F_safety | G5 | - | 7a71b89a… | 504 | 20546 | -/PROVIDER_TIMEOUT 20062 | 20065 | - | - | fail PROVIDER_TIMEOUT |
| 34 | 2 | 11:53:46 | A_normal | A3 | - | 8030e99f… | 502 | 6654 | 503/PROVIDER_503 1719 > 503/PROVIDER_503 3437 | 1718+3432 | - | - | fail PROVIDER_UNAVAILABLE |
| 35 | 2 | 11:54:06 | B_rag_hit | E2 | hit | 6e3d4525… | 504 | 21182 | 504/PROVIDER_504 19703 | 19701 | - | - | fail PROVIDER_TIMEOUT |
| 36 | 2 | 11:54:40 | C_rag_miss | F2 | miss | 566dc150… | 504 | 20246 | 504/PROVIDER_504 19750 | 19758 | - | - | fail PROVIDER_TIMEOUT |
| 37 | 2 | 11:55:13 | D_contradiction | C2 | - | b69226c4… | 504 | 19938 | 504/PROVIDER_504 19453 | 19454 | - | - | fail PROVIDER_TIMEOUT |
| 38 | 2 | 11:55:46 | E_injection | H1 | - | 23f0e22e… | 504 | 19807 | 504/PROVIDER_504 19297 | 19294 | - | - | fail PROVIDER_TIMEOUT |
| 39 | 3 | 12:08:00 | A_normal | A1 | - | d84667c8… | 201 | 7212 | ok 6578 | 6586 | 680 | 4750 | success |
| 40 | 3 | 12:08:20 | B_rag_hit | E1 | hit | 6563ee03… | 201 | 16725 | ok 14734 | 14735 | 754 | 5286 | success |
| 41 | 3 | 12:08:50 | C_rag_miss | F1 | miss | 47a5db91… | 201 | 3861 | ok 3359 | 3361 | 713 | 4741 | success |
| 42 | 3 | 12:09:07 | D_contradiction | C1 | - | 2d66c022… | 201 | 4552 | ok 4015 | 4009 | 885 | 4811 | success |
| 43 | 3 | 12:09:24 | E_injection | H1 | - | dfe0c388… | 201 | 3826 | ok 3344 | 3345 | 667 | 4747 | success |
| 44 | 3 | 12:09:41 | F_safety | G1 | - | da2693d5… | 201 | 3860 | ok 3375 | 3373 | 664 | 4740 | success |
| 45 | 3 | 12:09:57 | A_normal | A2 | - | 75666428… | 201 | 4566 | ok 4078 | 4077 | 703 | 4751 | success |
| 46 | 3 | 12:10:14 | B_rag_hit | E2 | hit | ba99e809… | 201 | 5756 | ok 4110 | 4106 | 978 | 5292 | success |
| 47 | 3 | 12:10:33 | C_rag_miss | F2 | miss | 5638c3b8… | 201 | 3568 | ok 3078 | 3077 | 704 | 4750 | success |
| 48 | 3 | 12:10:49 | D_contradiction | C2 | - | b395484f… | 201 | 5594 | ok 5109 | 5109 | 855 | 4821 | success |
| 49 | 3 | 12:11:08 | E_injection | H2 | - | fb0af388… | 201 | 3242 | ok 2750 | 2755 | 522 | 4724 | success |
| 50 | 3 | 12:11:24 | F_safety | G2 | - | 42dd9638… | 201 | 3625 | ok 3141 | 3140 | 702 | 4726 | success |
