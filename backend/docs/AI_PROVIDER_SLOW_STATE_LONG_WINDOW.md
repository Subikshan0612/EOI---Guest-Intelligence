# Gemini slow-state long-window observation (Workstream 3B)

Status: **observation only, scratchpad probe.** Nothing in the EOI production request path, configuration or repository was changed; this report is the only repository file written. Date: 2026-10-12, 12:48-13:56 UTC (18:18-19:26 IST).

## 1. Objective

Answer: **when Gemini enters the slow state, can a production-shaped request complete successfully after 20 seconds if the probe allows it up to 90 seconds?**

## 2. Relationship to Workstreams 2 and 3A

- **Workstream 2** (production boundary, 20 s provider deadline): 14 of 50 requests failed, 13 of them in one 8-minute slow window; provider 504s arrived at 19.3-19.8 s, so the true duration of those cut-off calls was unknown.
- **Workstream 3A** (this same direct probe, 29 requests, 12:21-12:42 UTC): no slow state occurred; all 2.7-5.1 s. It could not answer the question.
- **This observation** reuses the 3A probe at a low cadence over a longer window, so that it could meet a natural slow state. **A slow-state-like period did occur, and the question is answered (section 11).** The results here are direct scratchpad observations of Gemini; they are **not** production-boundary reliability measurements and are deliberately not combined with Workstream 2's statistics.

## 3. Exact model and configuration

| Item | Value |
|---|---|
| Model | `gemini-3.1-flash-lite` (the production model from `ai-service/.env`; `model_version` reported by the API on every response) |
| Prompt | built by the production `build_analysis_prompt` (read-only import) on synthetic production-shaped bodies; system prompt 15,737 characters; user prompt 3,754-5,391 characters; 4,777-5,374 input tokens |
| Generation config | production: JSON mime type, the production response schema, `max_output_tokens = 4096` (never approached: outputs 619-1,092 tokens) |
| Deadline | **90,000 ms** SDK timeout (sent to Gemini as `X-Server-Timeout: 90`), instead of the production 20,000 ms: the only intended difference |
| Retry | none: one attempt per request |
| Thinking tokens | none reported |

## 4. Test environment

The developer workstation (Windows 11, Python 3.12 venv, google-genai SDK 2.23.0), the production-staging API key and project, the real Gemini API. **Direct calls from a scratchpad Python script: no Node backend, no EOI AI-service request handling, no validation or persistence, no Workstream 1 retry layer or events.** Inputs: synthetic bodies captured from a throwaway Node backend (isolated local database, dropped afterwards; guests `Synthfirst Synthlast<n>`, `example.invalid` addresses, invented room numbers, the five synthetic guidance documents of the frozen Phase 53 dataset). Production Atlas was not contacted.

## 5. Sampling cadence

One request every 3.2-4.7 minutes, start to start (random 3-5 minute target; observed intervals 4.4, 4.0, 4.0, 4.1, 4.7, 3.4, 4.6, 3.5, 3.5, 4.4, 3.6, 3.2, 3.5, 4.6, 3.2, 3.6, 4.6 minutes). The cadence never changed with the provider's state; no request was sped up because the provider was fast, none was retried, no fault was injected. Stop rules (fixed in advance): about 10 slow-state-like calls (duration of at least 10 s), or 6 hours, or 8 consecutive errors; the first one triggered.

## 6. Observation window

12:48:12 to 13:56:04 UTC (67 minutes 52 seconds): **18 requests**. The run ended when the 10th slow-state-like call (the 52.9 s request) completed and the stop rule fired; the end of the slow period was **not** observed. The 6-hour maximum was not needed.

## 7. Scenario matrix

Round-robin over five categories (synthetic, from the frozen dataset; no scenario-specific additions beyond Workstream 3A):

| Category | Scenario ids | Requests |
|---|---|---|
| normal | A1, A2, A4, A5 | 4 |
| RAG-hit (five synthetic guidance items in the prompt) | E1, E2, E3, E1 | 4 |
| RAG-miss | F1, F2, F3, F1 | 4 |
| contradiction | C1, C2, C3 | 3 |
| safety | G1, G2, G3 | 3 |

## 8. Per-request safe metadata

The complete 18-row table (probe id, category, start/end, duration, state, status, finish reason, token counts, throughput) is in the appendix. It contains diagnostic metadata only: no prompt, output, key, header, production identifier or personal data.

## 9. Latency distribution

Classification (an experimental threshold only, not a statement about the provider): FAST = under 10 s, SLOW = 10 s or more. "Slow-state-like behaviour" is the term used throughout.

| Bucket | All (n = 18) | FAST (n = 8) | SLOW (n = 10) |
|---|---|---|---|
| < 5 s | 7 | 7 | - |
| 5-10 s | 1 (9.39 s) | 1 | - |
| 10-15 s | 5 | - | 5 |
| 15-20 s | 3 (16.4, 18.2, 19.0 s) | - | 3 |
| **20-30 s** | **1 (24.99 s)** | - | **1** |
| 30-45 s | 0 | - | 0 |
| **45-60 s** | **1 (52.93 s)** | - | **1** |
| 60-90 s | 0 | - | 0 |
| > 90 s / timeout | 0 | - | 0 |

| Set | n | min | p50 | p75 | p90 | max | mean |
|---|---|---|---|---|---|---|---|
| all requests (ms) | 18 | 2,876 | 12,341 | 15,996 | 20,800 | 52,929 | 12,944 |
| FAST | 8 | 2,876 | 3,653 | 3,971 | 5,597* | 9,390 | 4,263 |
| SLOW | 10 | 11,299 | 15,641 | 18,804 | 27,780 | 52,929 | 19,888 |

p95 is not reported (n below 20). *interpolated between 3.97 s and 9.39 s; with eight points it is shown only for completeness.

## 10. Slow-state analysis

| Measure | Value |
|---|---|
| Total requests | 18 |
| FAST | 8 (44%) |
| SLOW | 10 (56%) |
| Successful slow requests | 10 of 10 |
| Failed slow requests | 0 |
| Success rate by state | FAST 8 of 8; SLOW 10 of 10 (every request completed, every response ended with finish reason `STOP`) |
| Provider errors of any kind (503, 504, 499, timeout, other) | **0** in 18 requests |
| Requests that reached the 90 s observation limit | 0 |

Timeline: requests 1-7 (12:48-13:13 UTC) all fast, 2.9-4.0 s; the first slow-state-like call came at 13:17 (16.4 s); from 13:17:24 until the stop at about 13:56, 9 of the 10 following requests took 11-53 s and one (13:28:48) took 9.4 s at an output rate of 68 tokens/s, i.e. slow-state-like throughput that the 10 s threshold classifies as FAST. The change from fast to slow happened between two consecutive requests (13:12:46 and 13:17:24, under 5 minutes apart); the observed slow period lasted at least 38 minutes and had not ended when the run stopped. Earlier slow periods seen today (in the health-check and Workstream 2 runs) lasted roughly 15-25 minutes each (approximate, from request timestamps).

## 11. Successful requests beyond 20 seconds

**The experiment observed production-shaped Gemini requests completing successfully beyond the current approximately 20-second provider deadline.** Two of the 18 requests (2 of the 10 slow-state-like calls) did:

| # | Category | Scenario | Duration | Output tokens | Throughput | Finish |
|---|---|---|---|---|---|---|
| 13 | RAG-miss | F3 | **24,986 ms** | 661 | 26.5 tok/s | `STOP` (complete) |
| 18 | RAG-miss | F1 | **52,929 ms** | 813 | 15.4 tok/s | `STOP` (complete) |

Neither output was unusually long (661 and 813 tokens, within the 619-1,092 range of all requests). A 20 s deadline would not have allowed either call to finish. Two more successes finished within about two seconds of 20 s (18.2 s and 19.0 s).

## 12. Successful requests beyond 30, 45 and 60 seconds

| Threshold | Successful requests beyond it |
|---|---|
| > 20 s | 2 (25.0 s, 52.9 s) |
| > 30 s | 1 (52.9 s) |
| > 45 s | 1 (52.9 s) |
| > 60 s | 0 |

Descriptive coverage of the 18 observed calls if the provider had been allowed a given time (this sample only; it ignores any other limit in the application): within 20 s: 16 of 18 (8 of the 10 slow calls); within 25 s: 17 of 18 (the 24.99 s call only just, 9 of 10 slow); within 30 s: 17 of 18; within 45 s: 17 of 18; within 60 s: 18 of 18 (10 of 10 slow). The longest observed completion was 52.9 s; nothing approached 90 s. With only 10 slow-state calls and one beyond 30 s, **the tail beyond 53 s cannot be estimated from this sample (insufficient sample size to determine)**: a longer or heavier tail is neither shown nor excluded.

## 13. Output throughput analysis

| State | n | Output tokens/s: min / median / max | ms per output token (median) | Output tokens (median, range) |
|---|---|---|---|---|
| FAST | 8 | 68 / 226 / 275 | 4.4 | 718 (639-1,092) |
| SLOW | 10 | 15 / 42 / 92 | 23.7 (11-65) | 777 (619-1,035) |
| SLOW and over 20 s | 2 | 15 and 26 | - | 661 and 813 |

- Throughput in the slow-state-like calls fell to about one fifth of the fast-state median (42 vs 226 tokens/s), the same direction as Workstream 2 (about 50 vs about 204) but with a wider and lower spread (15-92 tokens/s).
- **Output size does not explain the duration:** the correlation of output tokens with duration was -0.08 over all 18 (-0.24 among FAST, -0.09 among SLOW). The two longest calls produced 661 and 813 tokens, while a 1,035-token output took 11.3 s and a 1,092-token output 4.0 s. Slow-state-like calls had the same output sizes as fast ones (median 777 vs 718).
- Input size did not distinguish them either (4.8-5.4k tokens in both states).

## 14. Scenario analysis

| Category | n | durations (s) in time order | FAST / SLOW | median tok/s |
|---|---|---|---|---|
| normal | 4 | 3.4, 3.4, 9.4, 18.2 | 3 / 1 | 137 |
| RAG-hit | 4 | 3.2, 4.0, 13.9, 19.0 | 2 / 2 | 141 |
| RAG-miss | 4 | 2.9, 16.4, 25.0, 52.9 | 1 / 3 | 33 |
| contradiction | 3 | 3.9, 11.3, 13.4 | 1 / 2 | 92 |
| safety | 3 | 3.9, 13.9, 14.9 | 1 / 2 | 51 |

- **All five categories experienced slow-state-like calls.** In each category the early requests (before about 13:15 UTC) were fast and the later ones slow, which suggests the state followed time, not category.
- Both calls beyond 20 s were RAG-miss requests (F3, F1), which have the smallest prompts (4,823 and 4,789 input tokens) and the shortest outputs. With two such calls and 3-4 requests per category, **insufficient sample size to determine** any category effect, and nothing here suggests content as the cause (the same F1 prompt took 2.9 s at 12:56 and 52.9 s at 13:55).

## 15. Comparison with Workstream 2

Two different methods; compared qualitatively, **not pooled into one statistic**.

| | Workstream 2 (production boundary: Node -> Python -> Gemini -> validation -> persistence; 20 s provider deadline; 50 requests) | This observation (direct probe; 90 s deadline; 18 requests) |
|---|---|---|
| Fast calls | about 2.8-6.4 s (median about 4 s); about 204 tokens/s | 2.9-4.0 s (one 9.4 s at 68 tok/s); median 226 tokens/s |
| Slow-state-like calls | successful 11.7-18.8 s; about 50 tokens/s; 13 of 29 requests in the slow window ended at the deadline | 11.3-19.0 s for 8 of 10, **25.0 s and 52.9 s for 2 of 10**; median 42 tokens/s (15-92) |
| Failures in the slow state | 11 provider 504 at 19.3-19.8 s, 2 client read timeouts at 20 s, 1 503+503 | **none**: all 10 slow-state-like requests completed |
| Same slow state appeared? | - | **Yes, qualitatively**: a period of 11-53 s calls with roughly one fifth of the fast throughput appeared at 13:17 UTC (how often such periods recur is not determined by this observation) |

Answers to the ten comparison questions: (1) a similar slow state appeared, from about 13:17 UTC for at least 38 minutes; (2) 10 of 18 requests (56%) in this window, 10 of the 11 requests after its onset; (3) yes, 2 requests completed successfully beyond 20 s; (4) yes, 1 beyond 30 s; (5) yes, 1 beyond 45 s (52.9 s); (6) none beyond 60 s; (7) yes, throughput fell to about one fifth of the fast level (42 vs 226 tokens/s median, in line with Workstream 2); (8) yes, all five categories; (9) the state appears to follow time rather than category, within the sample's limits; (10) every slow request eventually completed (none terminated or errored within the 90 s window).

## 16. Interpretation

- **Observed:** a period of "slow-state-like behaviour" (calls of 11-53 s at about 15-92 output tokens per second, against 3-4 s at about 230 in the fast period) beginning between two consecutive requests and lasting at least 38 minutes, affecting every category, with no change in prompt or output size. No provider error response was received at any time, so **no provider-reported cause is available**; this report does not attribute the slow state to demand, overload or any internal Gemini condition.
- **The key finding:** in this slow-state-like period, 2 of 10 production-shaped calls completed successfully after 20 s (25.0 s and 52.9 s) and 8 of 10 within 20 s. Therefore the current approximately 20-second provider deadline can truncate requests that Gemini would otherwise have completed. Combined with Workstream 2 (provider 504s at 19.3-19.8 s in the slow window), a plausible reading is that those 504s were calls that would have needed about as long as the deadline or longer (in this run, 8 of 10 slow-state-like calls finished at 11-19 s and 2 needed 25-53 s); this is an inference from two separate runs, not an observation of the same calls.
- In the slow-state-like period 8 of 10 calls finished within 20 s, with 3 of them at 16-19 s. The margin below the deadline was small; calls near 19-20 s were within roughly a second of being cut off.
- The longest completion (52.9 s) means that raising the timeout only slightly would not capture every slow request; at the same time no request needed more than 60 s in this sample. Whether the tail extends beyond that is unknown (section 12).
- **This observation does not itself change any production setting and does not decide how to respond.** It shows only that completion beyond 20 s occurs, not how often it matters in production, what it would cost in waiting time for people, or what limits (Node, browser, rate-limit windows, single-flight) would also have to move.

## 17. Limitations

- **A small slow sample:** 10 slow-state-like calls, 2 beyond 20 s, 1 beyond 30 s; the run stopped on its target, so the end of the slow period and any longer-lived tail were not observed. No tail percentile beyond p90 of the slow set (and even that from 10 points) is reliable.
- One machine, one API key/project, one model, one afternoon window (68 minutes); the slow state occurred at 13:17 UTC, not in the earlier 10:30-12:00 UTC window.
- Direct calls: none of the production layers (Node, Python handling, validation, persistence, retry) were involved; production-boundary behaviour was measured separately in Workstream 2. Total production request time adds about 0.5 s of overhead to the provider time.
- Synthetic production-shaped prompts without operational history; real prompts could be somewhat larger.
- The 10 s threshold is an experimental label; one 9.4 s call had slow-state-like throughput.
- A low load (one request per 3-5 minutes) was deliberate; behaviour under higher load was not examined.
- The slow-state-like durations seem to lengthen toward the end of the run (11-19 s, then 25.0 s, 19.0 s, 52.9 s); with so few points this trend is not claimed.

## 18. Recommendation for the next workstream

1. **No production change follows automatically from this report.** It is the evidence a timeout decision needed, not the decision.
2. **Next workstream: a design-only analysis of the timeout/deadline decision**, using this observation and Workstream 2, covering: (a) what share of slow-state requests different provider deadlines would have captured (this sample: 20 s: 8 of 10 slow calls; 30 s: 9 of 10; 60 s: 10 of 10); (b) what would have to move together (the Gemini SDK/server deadline, Node's analysis wait, the browser's 30 s, the cross-service ceiling, the Node socket and request deadlines, retry budget, single-flight and rate-limit windows); (c) the user experience of waiting 25-55 s for an assessment versus failing at 20 s (for example a clear in-progress state, or an asynchronous pattern where the request returns at once and the result is fetched), including for safety-hazard reports; (d) the retry rule for 503 under any new deadline (the 3 s first-attempt rule assumes a 25 s Node wait).
3. **Optionally, before choosing a number, tighten the tail estimate with another low-rate window of the same probe**, targeting about 20 more slow-state-like calls, since the current sample has one call beyond 30 s and none beyond 60 s. The observation can start at any time; slow periods occurred today at about 10:27-10:53, 11:41-12:00 and 13:17 UTC onward.
4. The safety-failure experience (a hazard report must not receive the neutral "try again" message) remains a separate decision and is more important if any deadline is lengthened.
5. Not recommended on this evidence: changing the output limit (output size did not explain latency) or the 503 retry.

## 19. Cleanup and change boundary

- **Retained in the scratchpad (outside the repository, clearly non-production, no secrets):** the probe (`probe_long.py`), the input-capture script and the analysis script, because they are directly reusable.
- **Removed:** the captured synthetic request bodies, the raw per-request results, the logs and the aggregates file; the throwaway database was dropped by the capture script.
- **Processes:** the probe, capture proxy and throwaway backend have exited. The long-running AI service on port 8000 and the dev backend were not started by this work and were not touched.
- **Verified:** no production source, test, `.env`, `.claude` or `CLAUDE.md` change; `git status` is identical to its state before this workstream apart from this report; no Atlas writes (not contacted); no commits, pushes or deployments; Learning not used or enabled.
- **Gemini usage:** 18 generation calls (the observation) plus the embedding calls for ingesting five synthetic documents and the five retrieval-query embeddings for the RAG-hit input capture.

Work stopped after this report. No production fix was started.

## Appendix: per-request safe metadata (18 requests)

Probe ids are random uuids (first 8 characters shown). Times are UTC on 2026-10-12. `state` is the experimental FAST (< 10 s) / SLOW (>= 10 s) label.

| # | probe id | category | scenario | start (UTC) | end (UTC) | duration ms | state | status | finish | input tok | output tok | tok/s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 41ac3fdc… | normal | A1 | 12:48:12.348 | 12:48:15.736 | 3387 | FAST | ok | STOP | 4790 | 797 | 235.3 |
| 2 | b92a4702… | rag_hit | E1 | 12:52:35.333 | 12:52:38.567 | 3233 | FAST | ok | STOP | 5332 | 728 | 225.1 |
| 3 | 88d53916… | rag_miss | F1 | 12:56:36.619 | 12:56:39.495 | 2876 | FAST | ok | STOP | 4809 | 654 | 227.4 |
| 4 | b18af43e… | contradiction | C1 | 13:00:36.505 | 13:00:40.363 | 3858 | FAST | ok | STOP | 4859 | 1017 | 263.6 |
| 5 | 1206fbbc… | safety | G1 | 13:04:43.314 | 13:04:47.258 | 3944 | FAST | ok | STOP | 4777 | 680 | 172.4 |
| 6 | 9327252d… | normal | A2 | 13:09:24.315 | 13:09:27.764 | 3449 | FAST | ok | STOP | 4788 | 708 | 205.3 |
| 7 | 83447605… | rag_hit | E2 | 13:12:46.487 | 13:12:50.458 | 3971 | FAST | ok | STOP | 5364 | 1092 | 275 |
| 8 | 12c74571… | rag_miss | F2 | 13:17:24.677 | 13:17:41.028 | 16351 | SLOW | ok | STOP | 4815 | 640 | 39.1 |
| 9 | d4b6adfe… | contradiction | C2 | 13:20:53.365 | 13:21:04.664 | 11299 | SLOW | ok | STOP | 4867 | 1035 | 91.6 |
| 10 | 54ca6391… | safety | G2 | 13:24:25.808 | 13:24:39.727 | 13919 | SLOW | ok | STOP | 4789 | 705 | 50.6 |
| 11 | 8ded2dc1… | normal | A4 | 13:28:48.376 | 13:28:57.766 | 9390 | FAST | ok | STOP | 4785 | 639 | 68.1 |
| 12 | 70d71402… | rag_hit | E3 | 13:32:23.891 | 13:32:37.774 | 13882 | SLOW | ok | STOP | 5374 | 793 | 57.1 |
| 13 | ff076a9d… | rag_miss | F3 | 13:35:37.977 | 13:36:02.964 | 24986 | SLOW | ok | STOP | 4823 | 661 | 26.5 |
| 14 | 7dd85798… | contradiction | C3 | 13:39:07.122 | 13:39:20.505 | 13383 | SLOW | ok | STOP | 4809 | 973 | 72.7 |
| 15 | 5645282f… | safety | G3 | 13:43:44.329 | 13:43:59.260 | 14931 | SLOW | ok | STOP | 4789 | 619 | 41.5 |
| 16 | 46eec398… | normal | A5 | 13:46:57.632 | 13:47:15.830 | 18198 | SLOW | ok | STOP | 4791 | 760 | 41.8 |
| 17 | 6d1d135a… | rag_hit | E1 | 13:50:34.571 | 13:50:53.577 | 19006 | SLOW | ok | STOP | 5360 | 809 | 42.6 |
| 18 | b7373cf9… | rag_miss | F1 | 13:55:11.580 | 13:56:04.508 | 52929 | SLOW | ok | STOP | 4789 | 813 | 15.4 |
