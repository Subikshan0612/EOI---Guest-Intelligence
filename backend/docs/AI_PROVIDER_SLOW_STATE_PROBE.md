# Gemini slow-state / deadline behaviour probe (Workstream 3A)

Status: **scratchpad-only diagnostic. It does not touch, and does not justify a change to, the EOI production request path.** Nothing in the repository was modified except this report. Date of the probe: 2026-10-12, 12:21-12:42 UTC (17:51-18:12 IST).

## 1. Objective

Answer one narrow question: **how long do representative Gemini requests take during slow provider conditions when they are allowed to continue beyond the production deadline of about 20 seconds?** Specifically: do slow requests complete after 20 s, and if so when (20-30 s, 30-45 s, 45-60 s, more than 60 s)?

**Outcome in one sentence: no slow provider state occurred during this probe, so the question was not answered. The probe did not capture a naturally occurring successful request beyond the production deadline.** All 29 requests completed in 2.7-5.1 s. Per the brief, this is reported as it is; no conclusion is manufactured from it, and it does **not** show that longer timeouts are unnecessary.

## 2. Relationship to Workstream 2

Workstream 2 (50 real requests through the production boundary, 11:37-12:11 UTC) found 14 failures, 13 of them clustered in an 8-minute slow window (about 4x lower output throughput), with provider 504s arriving at 19.3-19.8 s and two client read timeouts at about 20 s; the durations of those cut-off calls were unknown. This probe was designed to observe that unknown by lifting the deadline. It ran 10 minutes after Workstream 2's last request, after the provider had already returned to its fast state (Workstream 2's final 12 requests, 12:08-12:11 UTC, were fast). The provider therefore stayed fast for the whole 34 minutes from 12:08 to 12:42 UTC (41 consecutive requests across the two workstreams, all successful, 2.7-6.4 s of provider time apart from one 16 s RAG-hit call at 12:08, at the very edge of the recovery).

## 3. Exact model used

`gemini-3.1-flash-lite` (the production model from `ai-service/.env`; the API reported `model_version = gemini-3.1-flash-lite` on every response). Generation configuration identical to production: `response_mime_type=application/json`, the production response schema, `max_output_tokens = 4096`. No thinking tokens were reported on any call.

## 4. Exact distinction between the probe and the production path

| | Production path | This probe |
|---|---|---|
| Route | browser -> Node -> Python AI service -> Gemini -> Python validation -> Node validation -> persistence | a scratchpad Python script -> Gemini directly. **No Node, no AI-service request handling, no validation, no persistence, no retry layer, no Workstream 1 events** |
| Deadline | SDK timeout 20,000 ms (also sent to Gemini as `X-Server-Timeout: 20`) | **SDK timeout 90,000 ms** (sent as `X-Server-Timeout: 90`): the only intended behavioural difference |
| Retry | one retry for 503 only | none: one attempt per request, failures never repeated |
| Prompt | built by the production `build_analysis_prompt` | **the same function** (read-only import) on synthetic production-shaped bodies; system prompt 15,737 characters, user prompt 3,754-5,391 characters, 4,724-5,389 input tokens: the same size as the workload measured in Workstream 2 |
| Schema / config | production | the same objects (read-only import) |
| Output limit | 4,096 | 4,096 (not raised) |
| Extra | - | paired control only: a one-sentence length instruction appended to the user prompt (requests 11, 12, 23, 24) |
| Data | real workspace data | synthetic only: guests `Synthfirst Synthlast<n>`, `example.invalid` addresses, invented room numbers and the five synthetic guidance documents from the frozen Phase 53 dataset |

How the inputs were produced: a throwaway Node backend (isolated local database, stub authentication) built each operational context and ran retrieval exactly as production does; its AI-service URL pointed at a scratchpad capture proxy that recorded the analysis request body and answered 503 **without calling Gemini for it** (only the retrieval-related embedding calls for the RAG-hit cases were forwarded to the already-running AI service). The captured bodies (1.7 kB without knowledge, 4.4 kB with five guidance items) match the sizes seen in production-boundary runs.

## 5. Test environment

The developer workstation (Windows 11, Python 3.12 venv, google-genai SDK 2.23.0), the same API key and project as production staging, the real Gemini API. No EOI backend or AI-service process was in the path of the probe calls. The production Atlas database was not contacted. Pace: a random 30-50 s pause after each request completed (about 1.4 requests per minute); a stop rule would have ended the run after 5 consecutive errors (it was not needed).

## 6. Sample size

**29 probe requests** (the planned number), all executed once, in one session of 20 minutes 21 seconds: 25 across the five categories (5 each, interleaved) plus 4 control requests (two short/long pairs). Successes 29, failures 0. No request was repeated or retried and no additional batch was run after the planned 29 (an extra window was deliberately not added; see recommendation).

## 7. Scenario matrix

| Category | Description (synthetic) | Scenario ids (frozen dataset) | Requests |
|---|---|---|---|
| normal | routine operational fault | A1, A2, A4, A5, A3 | 5 |
| rag_hit | RAG-enriched context: five synthetic guidance items in the prompt | E1, E2, E3, E1, E2 | 5 |
| rag_miss | the same kind of reports, no guidance | F1, F2, F3, F1, F2 | 5 |
| contradiction | report conflicts with the stay record | C1, C2, C3, C1, C2 | 5 |
| safety | gas / smoke / CO / gas with access refused | G1, G2, G3, G5, G1 | 5 |
| control_short / control_long | the same normal context (A2, A5), with a "one short sentence" or a "be thorough" instruction appended | A2, A5 | 2 + 2 |

## 8. Per-request metadata

Metadata only: no prompt, no output, no key or header, no real identifier. `completed` means the response ended with finish reason `STOP` and non-empty text. `tok/s` is output tokens divided by the whole call duration.

(The table is at the end of this document, in the appendix.)

## 9. Duration distribution

| Bucket | All requests (n = 29) | Successful (n = 29) |
|---|---|---|
| < 5 s | 28 | 28 |
| 5-10 s | 1 (5.08 s) | 1 |
| 10-15 s | 0 | 0 |
| 15-20 s | 0 | 0 |
| 20-30 s | 0 | 0 |
| 30-45 s | 0 | 0 |
| 45-60 s | 0 | 0 |
| > 60 s | 0 | 0 |

## 10. Latency percentiles

| Set | n | min | p50 | p75 | p90 | p95 | max | mean |
|---|---|---|---|---|---|---|---|---|
| all calls (= successful) | 29 | 2,719 ms | 3,483 ms | 3,961 ms | 4,074 ms | 4,201 ms | 5,082 ms | 3,548 ms |
| failed | 0 | - | - | - | - | - | - | - |

Throughput (output tokens per second over the whole call): min 152, p50 229, p75 251, p90 268, max 304. In five-request windows the median stayed between 3.2 and 3.9 s and the median throughput between 218 and 252 tokens/s: no drift and no transition during the run.

## 11. Output-size / latency analysis

- Output tokens: min 500, p50 787, p90 1,039, max 1,107 (the 4,096 cap was never approached). Input tokens 4,724-5,389.
- Correlation of output tokens with duration: Pearson 0.57 over all 29 (0.48 over the 25 main requests). A descriptive straight-line fit in this fast state: about 2.1 s plus 1.8 s per 1,000 output tokens (R squared 0.32). This is a description of these 29 fast-state points only; it says nothing about the slow state.
- **Paired control** (both within the production ceiling): the requests asked for a short answer produced 500 and 502 tokens and took 2.72 s and 3.07 s; the same contexts asked for a thorough answer produced 750 and 819 tokens and took 3.25 s and 3.48 s. About 250-320 more tokens added about 0.4-0.5 s each time (a marginal rate of several hundred tokens per second). Two pairs only: the direction is consistent and the effect small; **insufficient sample size to determine more.**
- In the fast state, output length explains part of the variation (a few tenths of a second per 100-300 tokens) but nowhere near the 12-19 s successes or the 19-20 s cut-offs of Workstream 2.

## 12. Scenario / latency analysis

| Category | n | duration ms (min / median / max) | median output tokens | median input tokens | median tok/s |
|---|---|---|---|---|---|
| normal | 5 | 2,972 / 3,179 / 3,439 | 698 | 4,831 | 223 |
| rag_hit | 5 | 3,199 / 3,505 / 3,748 | 928 | 5,364 | 265 |
| rag_miss | 5 | 2,762 / 4,009 / 4,118 | 684 | 4,813 | 195 |
| contradiction | 5 | 3,637 / 3,961 / 5,082 | 1,069 | 4,884 | 258 |
| safety | 5 | 3,007 / 3,922 / 3,999 | 770 | 4,848 | 199 |
| control_short | 2 | 2,719 / 2,894 / 3,069 | 501 | 4,852 | 174 |
| control_long | 2 | 3,251 / 3,367 / 3,483 | 785 | 4,866 | 233 |

All categories ran within a 2.7-5.1 s range. The slightly higher medians for contradiction (longest outputs, about 1,070 tokens) and RAG-hit (largest input and about 930 output tokens) are in line with their longer outputs; with 5 requests per category, **insufficient sample size to determine** a category effect, and in a fast state it would in any case be a difference of about a second.

## 13. Successful requests beyond 20 seconds

**None.** The slowest request took 5.08 s. **The probe did not capture a naturally occurring successful request beyond the production deadline.** Questions A-F of the brief (do slow requests complete after 20 s; when; commonly 20-30 s, 30-45 s, 45-60 s, beyond 60 s) therefore remain **unanswered by this probe**: no slow state occurred, so there was nothing to let continue. This result must not be read as evidence that longer timeouts are unnecessary: it only says the provider was fast during these 21 minutes.

## 14. Failed requests and provider statuses

None: 0 of 29 requests failed; no 503, 504, 499, timeout or other provider status occurred; every response ended with finish reason `STOP`; no request used the stop rule or approached the 90 s observation limit.

## 15. Comparison with Workstream 2

| | Workstream 2 (production boundary) | This probe (direct, 90 s deadline) |
|---|---|---|
| Window (UTC) | 11:37-12:11 | 12:21-12:42 |
| Requests | 50 | 29 |
| Success | 36 (72%) | 29 (100%) |
| Fast state, successful provider-call time | about 2.8-6.4 s (median about 4 s) | 2.7-5.1 s (median 3.5 s) |
| Fast state, throughput (median) | about 204 tokens/s | 229 tokens/s |
| Slow state | 11:41-11:55: successes 11.7-18.8 s, about 50 tokens/s; 13 cut-offs at 19.3-20.1 s | **not observed** |
| 504 / timeouts / 503 | 11 / 2 / 1 request | 0 / 0 / 0 |
| Output tokens | 522-1,223 | 500-1,107 |
| Input tokens | 4,724-5,389 | 4,724-5,364 |

The fast state matches closely (same durations, throughput and token counts), which supports the probe being representative of the production workload when the provider is fast. It says nothing new about the slow state.

## 16. Interpretation

- **Observed:** the provider's fast state again (about 3.5 s median) with no failures, for 21 minutes and 29 requests across all five categories and the paired control. Combined with Workstream 2's last 12 requests, no slow behaviour was seen from 12:08 to 12:42 UTC apart from that single 16 s call at 12:08.
- **Question I (does the provider move between fast and slow states independent of request category?):** this probe cannot answer it, since it never saw a transition. What it adds is weak consistency with Workstream 2's reading: during a fast period every category was fast. It does not show that the slow state is independent of category.
- **Questions G and H:** in the fast state, output length explains a modest part of latency (r about 0.5; a small effect in the paired control) and scenario type shows no meaningful effect at this sample size. Whether either explains the 12-20 s calls of the slow state is **not determined**; this probe produced no slow-state data.
- The Workstream 2 hypothesis (an observed provider-side slow state producing deadline failures) is **neither confirmed nor refuted** here. No claim is made about a provider-side cause.
- By the rules of this workstream: the result **does not justify a production timeout change by itself**, in either direction.

## 17. Limitations

- **No slow state occurred**, so the primary objective was not met. Slow states in this environment appear intermittently (today at about 10:27-10:53 UTC, about 11:41-12:00 UTC, and in the staging history at about 06:00 UTC on 12 October); this probe's window did not coincide with one.
- One machine, one API key/project, one model, one 21-minute window; 29 requests; 5 per category; 2 control pairs.
- Synthetic production-shaped prompts without operational history; real prompts (with history items) can be somewhat larger.
- Direct calls: no Node/Python overhead (about 0.5 s in Workstream 2), no validation, no retry.
- Throughput figures divide output tokens by the whole call duration (including start-up), so they understate the pure generation rate.
- The pause between requests (30-50 s) and the load (about 1 request per minute) were deliberately low; behaviour under higher load was not examined and was not meant to be.

## 18. Recommendation for Workstream 3B

1. **Do not change any production timeout, retry or output limit on the basis of this probe.** It is evidence-neutral on the deadline question.
2. **Repeat the same scratchpad probe over a longer, low-rate window designed to span a slow state**, for example one request every 3-5 minutes for several hours (about 1.5-2 requests per 10 minutes, a fraction of production-like load), starting before the afternoon window in which slow states were observed (about 10:30-12:00 UTC today). Use the identical probe (90 s observation limit, same prompts, same stop rule) and add a stop condition so that once about 10 slow-state calls (for example any call over 10 s) have been observed, sampling ends. If a slow state occurs, the key outputs are the completion-time distribution above 20 s (20-30, 30-45, 45-60, more than 60 s) and whether outputs of about 800-1,000 tokens at the slow rate complete within 25-30 s; if it does not occur again, report that too.
3. If 3B finds slow-state completions mostly within 20-40 s, that would be evidence that the current 20 s provider deadline truncates completable requests, and the decision to raise the whole timeout chain together (Gemini deadline, Node 25 s, browser 30 s, cross-service ceiling) could then be made on evidence; if completions commonly exceed 60-90 s, raising the application timeout alone would not be sufficient. Neither is concluded here.
4. Independently of 3B, the safety-failure experience (a hazard report must not receive the neutral "try again" message) remains a separate decision.

## 19. Cleanup and change boundary

- Probe code (`probe.py`), the input-capture script and the analysis script live only in the session scratchpad, outside the repository, and are clearly marked non-production; they are retained there for Workstream 3B because they are directly reusable and contain no secret (the key is read from the existing `ai-service/.env` at run time and never printed or stored).
- Removed after the run: the captured synthetic request bodies, the raw per-request results file, intermediate logs and the aggregates file; the throwaway local database was dropped by the capture script; no process remains running (capture proxy, throwaway backend and probe have all exited; the long-running AI service on port 8000 and the dev backend were not started by this work and were not touched).
- Verified: no production source, test, `.env`, `.claude` or `CLAUDE.md` change; `git status` is identical to its state before the workstream apart from this report; no Atlas writes (not contacted); no commits, pushes or deployments; no Learning prompt or flag; no synthetic data left anywhere (all in the dropped local database and the deleted scratch files).
- Gemini usage: 29 generation calls (the probe), plus the embedding calls for ingesting five synthetic documents and the five retrieval-query embeddings for the RAG-hit captures.

Work stopped after this report; Workstream 3B was not started.

## Appendix: per-request metadata (29 requests)

Probe ids are random uuids (first 8 characters shown). Times are UTC on 2026-10-12.

| # | probe id | label | scenario | start (UTC) | end (UTC) | duration ms | status | completed | finish | input tok | output tok | tok/s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 4b128528… | normal | A1 | 12:21:34.907 | 12:21:38.086 | 3179 | ok | true | STOP | 4830 | 716 | 225.2 |
| 2 | 6d53ad4e… | rag_hit | E1 | 12:22:13.748 | 12:22:16.947 | 3199 | ok | true | STOP | 5378 | 830 | 259.5 |
| 3 | 5bd01308… | rag_miss | F1 | 12:23:05.580 | 12:23:09.589 | 4009 | ok | true | STOP | 4806 | 783 | 195.3 |
| 4 | 57e92d99… | contradiction | C1 | 12:23:58.778 | 12:24:03.034 | 4256 | ok | true | STOP | 4876 | 1031 | 242.2 |
| 5 | 87b18d6a… | safety | G1 | 12:24:43.639 | 12:24:46.646 | 3007 | ok | true | STOP | 4848 | 754 | 250.7 |
| 6 | 2b0c4ea7… | normal | A2 | 12:25:26.507 | 12:25:29.496 | 2989 | ok | true | STOP | 4828 | 628 | 210.1 |
| 7 | 40e4c05f… | rag_hit | E2 | 12:26:15.524 | 12:26:19.029 | 3505 | ok | true | STOP | 5364 | 1026 | 292.8 |
| 8 | ce7c8cf8… | rag_miss | F2 | 12:27:00.052 | 12:27:02.813 | 2762 | ok | true | STOP | 4812 | 623 | 225.6 |
| 9 | 78d73c70… | contradiction | C2 | 12:27:38.718 | 12:27:43.800 | 5082 | ok | true | STOP | 4884 | 1069 | 210.4 |
| 10 | 39bb1ddc… | safety | G2 | 12:28:14.762 | 12:28:17.984 | 3221 | ok | true | STOP | 4846 | 808 | 250.8 |
| 11 | a5730adc… | control_short | A2 | 12:29:01.892 | 12:29:04.611 | 2719 | ok | true | STOP | 4850 | 500 | 183.9 |
| 12 | 87b3eb2d… | control_long | A2 | 12:29:46.716 | 12:29:49.966 | 3251 | ok | true | STOP | 4864 | 750 | 230.7 |
| 13 | d92dfb29… | normal | A4 | 12:30:26.170 | 12:30:29.142 | 2972 | ok | true | STOP | 4831 | 664 | 223.4 |
| 14 | fc123fd5… | rag_hit | E3 | 12:31:12.400 | 12:31:16.147 | 3748 | ok | true | STOP | 5374 | 928 | 247.6 |
| 15 | 6966d9b6… | rag_miss | F3 | 12:31:51.464 | 12:31:55.582 | 4118 | ok | true | STOP | 4824 | 684 | 166.1 |
| 16 | 2b6f9a0b… | contradiction | C3 | 12:32:26.947 | 12:32:30.862 | 3915 | ok | true | STOP | 4828 | 1009 | 257.7 |
| 17 | cc51c98d… | safety | G3 | 12:33:06.448 | 12:33:10.448 | 3999 | ok | true | STOP | 4843 | 742 | 185.5 |
| 18 | 4826a9b3… | normal | A5 | 12:33:42.596 | 12:33:46.035 | 3439 | ok | true | STOP | 4831 | 788 | 229.1 |
| 19 | 68bc377d… | rag_hit | E1 | 12:34:21.150 | 12:34:24.407 | 3258 | ok | true | STOP | 5360 | 867 | 266.1 |
| 20 | 0bc5a5e2… | rag_miss | F1 | 12:35:13.963 | 12:35:18.025 | 4063 | ok | true | STOP | 4823 | 617 | 151.9 |
| 21 | 3c8a3f87… | contradiction | C1 | 12:36:02.209 | 12:36:06.170 | 3961 | ok | true | STOP | 4913 | 1093 | 275.9 |
| 22 | 453c829e… | safety | G5 | 12:36:53.798 | 12:36:57.720 | 3922 | ok | true | STOP | 4853 | 770 | 196.3 |
| 23 | d21f9018… | control_short | A5 | 12:37:43.898 | 12:37:46.967 | 3069 | ok | true | STOP | 4853 | 502 | 163.6 |
| 24 | c7f1527c… | control_long | A5 | 12:38:22.027 | 12:38:25.511 | 3483 | ok | true | STOP | 4867 | 819 | 235.1 |
| 25 | 4dda4007… | normal | A3 | 12:39:09.751 | 12:39:12.956 | 3205 | ok | true | STOP | 4832 | 698 | 217.8 |
| 26 | 050a8fee… | rag_hit | E2 | 12:39:55.397 | 12:39:59.035 | 3638 | ok | true | STOP | 5344 | 965 | 265.2 |
| 27 | b2355f9c… | rag_miss | F2 | 12:40:30.078 | 12:40:33.387 | 3309 | ok | true | STOP | 4813 | 790 | 238.7 |
| 28 | 6a40b94a… | contradiction | C2 | 12:41:07.455 | 12:41:11.092 | 3637 | ok | true | STOP | 4924 | 1107 | 304.3 |
| 29 | 2b11a4cb… | safety | G1 | 12:41:51.746 | 12:41:55.711 | 3965 | ok | true | STOP | 4848 | 787 | 198.5 |
