# Workstream 5D — Slow-state deadline decision measurement

Status: measurement only. **No repository production source, test, `.env`, `.claude` or `CLAUDE.md` change was made; this report is the only repository file written.** Not committed, not pushed, not deployed. Date: 2026-10-13.
Labels: **PROVEN** = directly observed in this workstream; **SUPPORTED** = strongly suggested (including by earlier workstreams, stated as such); **UNKNOWN** = not established by the sample.

**FINAL GATE: CONDITIONAL PASS** — the measurement ran correctly under pre-registered rules, but **Gemini stayed in its fast state for the whole 3 h 3 min window** (no provider call of 10 s or more), so the data **cannot distinguish 30 / 45 / 60 s**. The deadline stays at the provisional **60 s**; nothing changes.

## 1. Objective

For calls that actually enter Gemini's slow state, where do successful completions fall (≤20 / 20–30 / 30–45 / 45–60 / >60 s), and therefore should the provisional 60 s Gemini analysis deadline be kept or reduced to 45 s or 30 s? Plus three side checks: the retrieval budget (45 s after 5C), the 503 policy and the safety posture.

## 2. Current timeout chain (inspected before measuring; nothing changed)

| Layer | Value | Note |
|---|---|---|
| Browser analyze wait | 30 s | `frontend/src/services/api.js` |
| HTTP response window (then 202) | 25 s | `getAnalysisResponseWindowMs` |
| Attempt lifetime | ≤ 110 s (socket 120 s − 10 s); stale marker after 140 s | `getAnalysisTimeBudget`, `getAnalysisAttemptStaleAfterMs` |
| Node → AI service, analysis wait | 65 s = 60 s ceiling + 5 s | `getAiAnalysisTimeoutMs` |
| Node retrieval | 20 s per call; **45 s total** (110 − 65) | `nextRetrievalCallTimeoutMs` |
| AI service embedding / legacy | 20 s (ceiling 20 s) | `REQUEST_TIMEOUT_MS` |
| **Gemini analysis deadline** | **60 s (provisional default)**, ceiling 60 s; SDK sends it as `X-Server-Timeout` | `LLM_ANALYSIS_TIMEOUT_MS` |
| 503 retry | 2 attempts, 1 s delay, first attempt ≤ 3 s | unchanged |
| Hosting proxies | UNKNOWN (no deployment config in the repository) | — |

**Measurement-only deviation (not a repository change):** to be able to *observe* a completion beyond 60 s instead of cutting it at 60 s, the measurement stack ran with an **observation deadline of 100 s** (`LLM_ANALYSIS_TIMEOUT_MS=100000` via the process environment, the ceiling constant raised at runtime in a scratchpad launcher) and Node's analysis wait at 110 s (`KOI_AI_ANALYSIS_TIMEOUT_MS`, socket 300 s). This is the same device Workstream 3B used (90 s). The browser-facing response window was the production 25 s. No other value differed. Because nothing took longer than 9 s, this deviation never mattered to any result.

## 3. Measurement methodology

Pre-registered before the first call (rules below were fixed in advance, in a scratchpad file):

* **Real Gemini** `gemini-3.1-flash-lite`, the unmodified production prompts, the production output limit (4096), through the **real Node pipeline** (intake → analyze → retrieval → AI service → provider → validation → persistence) into an isolated local database (dropped afterwards). **No artificial delay of any kind.**
* **Cadence:** one request every 2.5–4.0 minutes (random, start to start), strictly sequential, round-robin over the six categories (normal, contradiction, prompt-injection, RAG-miss, safety/gas, RAG-hit), a fresh identically-shaped synthetic case per request. The cadence never adapted to provider state; nothing was retried, sped up or injected by the harness.
* **Stop rules fixed in advance:** S1 ≥ 50 analyses **and** ≥ 10 provider calls > 20 s; S2 ≥ 3 h elapsed with **no** call ≥ 10 s ("the provider stayed fast; stop and say so"); S3 6 h or 150 requests; S4 8 consecutive harness failures. **S2 fired** (183 minutes, 55 analyses, no call ≥ 10 s).
* **Recorded per request** (safe metadata only; no key, token, raw prompt, raw output or guest data): timestamp, category, correlation id (Node's request id, equal to the AI service's `correlationId`), provider attempt count, whether attempt 1 was a 503, whether the retry recovered, final HTTP result, provider duration, end-to-end duration, output tokens, finish reason, crossings of 20/30/45/60 s, validation result, persistence result.
* **Harness incident (disclosed):** the stub access tokens used by the harness expire after one hour, so requests #19–#20 of the first segment failed to authenticate (a harness error, not provider behaviour). The first segment's 18 valid requests (08:07–09:05 UTC) were preserved, the harness was fixed to mint a fresh token per request, and a second segment continued the **same session** (stop rules counted cumulatively, the 3 h clock from the original start). 09:05–09:13 UTC contains no requests.

## 4. Sample size

**55 analyses = 55 requests through the full pipeline, 58 provider calls** (three requests used a second attempt after a first-attempt 503; 53 requests received a provider response, 2 received only 503s), window 08:07–11:10 UTC (13:37–16:40 IST), 9–10 per category. 48 persisted. No request exceeded the 25 s window: **the 202 path was not reached (0 of 55)**.

## 5. Provider state observed

**Fast state throughout (PROVEN).** The 53 requests that received a provider response took **2.7–9.0 s (median 5.9 s)** for the call that answered; output throughput 69 / 135 / 295 tokens/s (min / median / max). **No call reached 10 s**, none reached 20 s. For comparison, Workstream 3B's fast state was 2.9–9.4 s at median 226 tokens/s. Provider errors: three first-attempt 503s (5.5% of requests; 3 of 55 — not a rate claim) and no 504, no timeout. The same clock window on 12 October (about 10:27–10:53 and 11:41–12:00 UTC) had slow periods; today's was fast, so **when slow periods occur is UNKNOWN** and not predictable from clock time.

## 6. Completion-band table

| Completion band | Successful provider completions | Persisted | Failed calls at that duration | Evidence |
|---|---|---|---|---|
| ≤ 20 s | 53 | 48 | 2 requests failed with 503 on both attempts (last attempt 0.7 s and 1.2 s); a third request's first attempt was a 503 and recovered (not slow-state events) | all 53 between 2.7 s and 9.0 s |
| > 20–30 s | **0** | 0 | 0 | none observed |
| > 30–45 s | **0** | 0 | 0 | none observed |
| > 45–60 s | **0** | 0 | 0 | none observed |
| > 60 s | **0** | 0 | 0 | none observed |

The five unpersisted successful completions are **Node output-guard rejections after Gemini answered normally** (not provider failures): `CLAIM_VALIDATION_FAILED` ×2, `PROSE_CONSISTENCY_VIOLATION` ×3 (section 15). Reference points from earlier workstreams, **not pooled** into the table: Workstream 3B (90 s deadline) observed completions at 25.0 s (>20–30 s) and 52.9 s (>45–60 s); Workstream 5C's 63 calls peaked at 19.6 s.

The questions the decision framework asks, answered literally:

1. *Would 30 s have preserved all observed legitimate completions?* In this sample, yes — vacuously: nothing exceeded 9.0 s. Against the earlier reference data, no (52.9 s).
2. *45 s?* Same as 30 s: yes here, no against 3B (52.9 s).
3. *60 s?* Yes here and against every observation to date (longest ever observed completion 52.9 s).
4. *Calls each candidate would have truncated:* 5D sample — 30 s: 0, 45 s: 0, 60 s: 0 (of 53). Earlier reference (3B, 18 calls) — 30 s: 1, 45 s: 1, 60 s: 0.
5. *Observed completions that demonstrate value in waiting beyond 30 s:* **0 in this workstream** (3B: 1, SUPPORTED).
6. *Beyond 45 s:* **0 in this workstream** (3B: 1, the 52.9 s call).
7. *Evidence that 60 s itself is insufficient:* **none** — no completion beyond 60 s has ever been observed, and no call has reached a 90–100 s observation limit.

## 7–9. 30 s, 45 s and 60 s analysis

* **30 s.** The framework allows choosing 30 s only if legitimate >30 s completions are absent or negligible *and* 30 s preserves the useful slow-state behaviour. **Not met:** absence is not shown (this sample simply had no slow calls), and the one observation in the relevant range (3B's 52.9 s) would be lost. Not selected.
* **45 s.** Would be right if completions occur >30 s but none beyond 45 s. **Not demonstrable:** zero completions beyond 30 s were observed here, and the only one known (52.9 s, 3B) is beyond 45 s. It remains the least supported candidate (it adds nothing observed over 30 s). Not selected.
* **60 s.** Would be right if completions occur >45 s and waiting preserves them. The one known observation (52.9 s) is consistent with it (**SUPPORTED, single point**); this workstream adds none. It is the only candidate with **no known truncation**; it is not shown to be *necessary*. Retained, provisionally.

## 10. Retrieval budget measurement (reported separately)

Real Node retrieval function against the real AI service with **real Gemini query embeddings** (`gemini-embedding-001`, 3072 dimensions), over a synthetic corpus in an isolated database, 4 repetitions per cell, no change to retrieval. One retrieval **page** = one Node → AI-service call that carries up to 200 candidate vectors and embeds the query once; the production ceiling is 2000 candidates = 10 pages.

| Corpus | Pages | Aggregate retrieval time (ms, min–max over 8 runs) | Share of the 45 s budget (max) | Per-page call (ms) | Gemini query-embedding part (ms) |
|---|---|---|---|---|---|
| 150 candidates | 1 | 1,767 – 2,041 | 5% | 1,403 – 1,601 | 507 – 744 |
| 1,000 | 5 | 9,843 – 10,289 | 23% | 1,458 – 1,694 | 459 – 633 |
| 2,000 (ceiling) | 10 | **19,779 – 21,365** | **47%** | 1,454 – 2,010 | 465 – 1,015 |

* The standalone query embedding (8 samples) took 503–902 ms at Gemini and 944–1,368 ms Node → AI service.
* **Real analyses with retrieval** (RAG-hit, one page, the five synthetic guidance documents): aggregate retrieval **954–1,168 ms** (9 requests, 2% of the budget). RAG-miss and normal cases in this dataset make **no** retrieval call (no eligible knowledge). At the scoring stage hit and miss take the same path (the relevance floor is applied afterwards), and their timings did not differ beyond noise (2,000-candidate runs: hit 19.8–20.9 s, miss 20.1–21.4 s).
* **Headroom (PROVEN, fast state):** the worst case the system allows (10 pages) used under half of the 45 s budget (about 2.1× headroom); a per-page call would have to average **4.5 s** (2.2–3× today's, and still within the 20 s per-call timeout) before the 45 s budget fails at the ceiling; typical corpora (one page) use about 2–5% of it.
* **UNKNOWN:** retrieval/embedding behaviour during a Gemini slow state (none occurred) — if the embedding endpoint slowed like generation did (3–10×), a 10-page corpus would exceed 45 s and fail closed; a 1–5 page corpus would not. There is **no evidence that 45 s is inadequate**, so it was not restored to 85 s.

## 11. Real slow-path E2E evidence

**No naturally slow real end-to-end example occurred** (no request reached the 25 s window; 0 of 55 used HTTP 202). Documented as required. The 202 → in-progress UI → same attempt continues → persisted → polling discovers success → Decision gated sequence therefore rests on Workstream 5C's evidence (two real-stack browser runs with a disclosed one-shot hold of the real response, one provider call and one attempt each, plus the 40 s controlled run), which was **not repeated**. It is re-verified as a regression through the 5C suite (section 14).

## 12. 503 retry regression

* **Observed on the real provider (new data):** 3 first-attempt 503s in 55 requests: **1 recovered on the single retry** (request #17, persisted at provider time 6.5 s after the 503), **2 failed 503 → 503** (requests #9 and #50); in all three exactly **two** provider calls were made, never a third. Recovery rate is **1 of 3 here (UNKNOWN beyond that: insufficient sample)**; earlier real observations were 0 of 1.
* **Deterministic fault-injection regression** (5C suite sections B, real Node → real AI service → local fake Gemini): 503 → success = 2 calls and persisted; 503 → 503 = 2 calls then failure; 504 = 1; timeout = 1; 400 / 401 / 403 / 429 = 1 each; the spare success queued behind each case was never consumed (no third attempt); 503 + slow success = 2 calls inside Node's wait. Pytest (30/45/60 s deadlines): same counts, plus 500 = 1.

## 13. Safety regression

No safety policy was changed. The 5C suite section D (real Node + real AI service + controllable provider) was re-run: gas, smoke, fire, carbon monoxide and access refusal + hazard are all classified `LIFE_SAFETY_HAZARD` (minimum urgency `immediate`) by the deterministic policy and stored as `safety_hazard` by the server-derived structured issue **before and independent of the analysis**; the classification is unchanged while the analysis is in progress, after it succeeds and after it fails; in-progress shows the hazard sentence and never says it can wait; a failed analysis (provider 504 after the window) leaves the hazard classification and the explicit retry; Decision/Action are refused while in progress and after failure and available only after a stored analysis; a model answer below the minimum is rejected by the unchanged enforcement; nothing in any path invents an instruction. Real-provider safety sample: 9 gas-hazard requests, 2.8–6.6 s, all persisted.

## 14. Test / regression comparison

No repository code, test or configuration was changed in 5D, so this is a **baseline-still-holds** regression (focused set, run sequentially in the default environment, isolated local databases, after the measurement finished). The "5D suite" is the Workstream 5C suite, whose sections B (503 / 504 / timeout / 4xx counts) and D (safety) are exactly the focused 503 and safety regressions requested; no new repository test was added because nothing in the repository changed.

| Check | 5C baseline | 5D result | Class of any difference |
|---|---|---|---|
| `validate-hybrid-5c-deadline` | 46 / 0 | **46 / 0** | none |
| `validate-analysis-attempt-5a` | 46 / 0 | **46 / 0** | none |
| `validate-hybrid-5b-status-ux` | 72 / 0 | **72 / 0** | none |
| phase 21 runtime hardening | 248 / 0 | **248 / 0** | none |
| phase 34 provider policy | 55 / 0 | **55 / 0** | none |
| phase 35 audit / governance | 101 / 0 | **101 / 0** | none |
| phase 36 production readiness | 68 / 0 | **68 / 0** | none |
| phase 37 reliability gate | 40 / 0 | **40 / 0** | none |
| phase 39 preflight | 58 / 0 | **58 / 0** | none |
| AI provider observability | 29 / 0 | **29 / 0** | none |
| Learning L1.3 structured intake | 61 / 0 | **61 / 0** | none |
| phase 43b2 / 43c / 43d / 47 (safety, persisted intelligence, error presentation, conversational signal) | 48 / 48 / 39 / 60 | **48 / 48 / 39 / 60** | none |
| phase 34c evidence guardrails | 58 / 0 | **58 / 0** | none |
| AI-service pytest | 531 passed | **531 passed** | none |
| Frontend `npm run build` | bundle `index-CZlkw-I4.js` | **identical bundle hash** | none |

No failures, no regressions, nothing to classify as environment-dependent, stale or unrelated in this focused set. Not re-run in 5D: the full backend sweep and the legacy-stack runner (unchanged code; their 5C results — including the nine environment-sensitive suites that depend on a service on `localhost:8000` that this work did not start — stand as the baseline). The measurement stack never touched Atlas, `.env` files or any repository file.

## 15. Proven / supported / unknown

**PROVEN**
* In a 3 h 3 min window the provider stayed in its fast state: 53 completions in 2.7–9.0 s, none ≥ 10 s.
* Under the production boundary the 202 path was not triggered by any natural request in this window.
* The retrieval budget at the 2000-candidate ceiling used 44–47% of 45 s in the fast state; one-page retrieval for a real analysis took about 1 s.
* The 503 policy behaved as specified on real 503s (3 of 3 had exactly two provider calls).
* Five of 55 successful provider responses were rejected by Node's output guards (`CLAIM_VALIDATION_FAILED` ×2 — both contradiction; `PROSE_CONSISTENCY_VIOLATION` ×3 — all prompt-injection): 5 of 18 requests in those two categories, 0 of the other 37 non-503 requests. Together with Workstream 5C's 3 of 63, that is 8 of 118 requests across both samples (cause and base rate UNKNOWN; unrelated to timeouts; unchanged code).

**SUPPORTED** (from earlier workstreams, not re-observed)
* In a slow-state period calls can complete at 25.0 s and 52.9 s, and slow calls complete rather than hang (10 of 10 at a 90 s deadline, 3B).
* A 20 s deadline truncates completable work (3B; Workstream 2).

**UNKNOWN**
* Where completions fall in the 20–60 s bands, whether any completion exceeds 53 s, and how often slow periods occur — **not established by this workstream**.
* Retrieval/embedding behaviour in a slow state; behaviour under concurrency; hosting-proxy limits.
* Any percentile (none is claimed).

## 16. Final deadline recommendation

**Keep the provisional 60 s Gemini analysis deadline unchanged** (Node wait 65 s, window 25 s, embedding 20 s, retrieval calls 20 s, retrieval budget 45 s). **Do not reduce it on this evidence:** reducing needs observed absence of legitimate completions beyond 30 or 45 s, and this sample contained no slow calls at all; the only known completion in that range (52.9 s, 3B) argues against reducing. This is a **non-decision, not a confirmation**: 60 s is retained because nothing here contradicts it and the cost of waiting is invisible under the 202 design, not because it was shown necessary.

**What evidence is missing, precisely:** successful completions *during a slow-state period* — at least **10 calls longer than 20 s, including at least 3 longer than 30 s** — in any one session; the retrieval-embedding timing during the same period. Recommended way to get it without sampling blind for hours: (a) run the retained collector as a **sentinel** (one call per ~5 minutes, no more) over days and switch to the same low-rate dense cadence for the following ~2 hours once two consecutive calls reach ≥ 10 s; or (b) read the `provider.attempt` durations the system already logs in real use (Workstream 1 events) and evaluate the same bands there. Decision rule to pre-register: no completion in 30–60 s over those ≥ 10 slow calls → reduce to 30 s; completions in 30–45 s only → 45 s; any in 45–60 s → keep 60 s; any beyond 60 s → 60 s is not demonstrated sufficient (do not simply raise it; reconsider the failure UX).

## 17. Remaining risks

* A slow state heavier than anything observed (calls beyond 60 s) would still be truncated; a stuck call holds a thread and an attempt marker for up to 60 s.
* Retrieval budget in a slow state is unmeasured (section 10); a corpus near the 2000-chunk ceiling would be the first to fail closed.
* The Node output-guard rejection rate (8 of 118 across 5C + 5D) is a separate source of failed analyses worth its own investigation; it clusters in contradiction and prompt-injection cases here.
* Concurrency and hosting-proxy behaviour remain unmeasured.
* The measurement covers one machine, one key/project, one afternoon (13:37–16:40 IST).

## 18. Exact change required

**None.** No code, configuration or documentation change is required by this workstream. Next step: **another measurement** (the sentinel plan above), not an implementation.

## Cleanup and verification

* Removed (scratchpad, outside the repository): the per-request results, probe logs, AI-service and backend logs, retrieval results, regression logs and the temporary runners. Throwaway databases were dropped; **no 5D process remains** (ports 5490 / 8140 / 8141 closed; no collector or probe process).
* **Retained in the scratchpad, outside the repository, no secrets** (they read the service token from `ai-service/.env` at run time and never print it): the pre-registration, the sentinel/collector (`collect5d.mjs`), the instrumented probe launcher (`ai_probe_d5.py`), the retrieval measurement and the analysis script — directly reusable for the follow-up measurement in section 16.
* **Verified:** the only repository file modified during 5D is this report (checked by modification time across the repository, excluding dependencies and build output); `.claude/`, `CLAUDE.md` and all `.env` files untouched; no production source change (none was needed, not even test instrumentation — all instrumentation lived in the scratchpad launcher); no Atlas contact (every database used was an isolated local throwaway); no commit, push or deployment; Learning off.
* **Gemini usage:** 58 generation calls (55 requests, three with a retried 503) plus the embedding calls of the knowledge-document setup and of the retrieval measurement (8 standalone and 128 page-embeddings).

---

## Appendix A — the 55 requests (safe metadata only)

Columns: # · start (UTC) · category · provider time (s; for a 503-failed call, time of the last attempt) · provider attempts · result.

| # | Start (UTC) | Category | Provider (s) | Attempts | Result |
|---|---|---|---|---|---|
| 1 | 08:07:50 | normal | 3.0 | 1 | persisted |
| 2 | 08:10:31 | contradiction | 7.1 | 1 | persisted |
| 3 | 08:14:31 | prompt-injection | 2.8 | 1 | persisted |
| 4 | 08:17:36 | rag-miss | 2.7 | 1 | persisted |
| 5 | 08:21:25 | safety-hazard (gas) | 2.8 | 1 | persisted |
| 6 | 08:25:15 | rag-hit | 6.5 | 1 | persisted |
| 7 | 08:29:13 | normal | 6.2 | 1 | persisted |
| 8 | 08:31:57 | contradiction | 3.8 | 1 | persisted |
| 9 | 08:35:14 | prompt-injection | 0.7 | 2 (first 503, then 503) | failed: PROVIDER_UNAVAILABLE |
| 10 | 08:38:33 | rag-miss | 7.3 | 1 | persisted |
| 11 | 08:41:11 | safety-hazard (gas) | 6.6 | 1 | persisted |
| 12 | 08:44:44 | rag-hit | 4.1 | 1 | persisted |
| 13 | 08:48:27 | normal | 5.9 | 1 | persisted |
| 14 | 08:51:43 | contradiction | 6.9 | 1 | failed: CLAIM_VALIDATION_FAILED |
| 15 | 08:54:44 | prompt-injection | 4.8 | 1 | failed: PROSE_CONSISTENCY_VIOLATION |
| 16 | 08:58:44 | rag-miss | 7.6 | 1 | persisted |
| 17 | 09:02:38 | safety-hazard (gas) | 6.5 | 2 (first 503, recovered) | persisted |
| 18 | 09:05:25 | rag-hit | 4.7 | 1 | persisted |
| 19 | 09:13:16 | normal | 6.6 | 1 | persisted |
| 20 | 09:15:50 | contradiction | 8.6 | 1 | persisted |
| 21 | 09:18:23 | prompt-injection | 7.5 | 1 | persisted |
| 22 | 09:21:22 | rag-miss | 7.5 | 1 | persisted |
| 23 | 09:25:19 | safety-hazard (gas) | 5.4 | 1 | persisted |
| 24 | 09:28:34 | rag-hit | 6.6 | 1 | persisted |
| 25 | 09:32:11 | normal | 5.6 | 1 | persisted |
| 26 | 09:35:49 | contradiction | 9.0 | 1 | persisted |
| 27 | 09:38:58 | prompt-injection | 7.3 | 1 | failed: PROSE_CONSISTENCY_VIOLATION |
| 28 | 09:42:24 | rag-miss | 5.6 | 1 | persisted |
| 29 | 09:45:30 | safety-hazard (gas) | 6.6 | 1 | persisted |
| 30 | 09:49:16 | rag-hit | 8.5 | 1 | persisted |
| 31 | 09:53:01 | normal | 3.9 | 1 | persisted |
| 32 | 09:55:43 | contradiction | 3.7 | 1 | persisted |
| 33 | 09:58:36 | prompt-injection | 2.7 | 1 | persisted |
| 34 | 10:01:53 | rag-miss | 6.8 | 1 | persisted |
| 35 | 10:05:00 | safety-hazard (gas) | 5.3 | 1 | persisted |
| 36 | 10:08:42 | rag-hit | 6.0 | 1 | persisted |
| 37 | 10:11:15 | normal | 8.6 | 1 | persisted |
| 38 | 10:14:22 | contradiction | 6.9 | 1 | failed: CLAIM_VALIDATION_FAILED |
| 39 | 10:17:50 | prompt-injection | 5.9 | 1 | failed: PROSE_CONSISTENCY_VIOLATION |
| 40 | 10:21:44 | rag-miss | 4.1 | 1 | persisted |
| 41 | 10:25:00 | safety-hazard (gas) | 5.8 | 1 | persisted |
| 42 | 10:28:08 | rag-hit | 6.3 | 1 | persisted |
| 43 | 10:30:46 | normal | 4.9 | 1 | persisted |
| 44 | 10:34:03 | contradiction | 6.3 | 1 | persisted |
| 45 | 10:37:58 | prompt-injection | 5.4 | 1 | persisted |
| 46 | 10:40:46 | rag-miss | 6.2 | 1 | persisted |
| 47 | 10:44:43 | safety-hazard (gas) | 4.9 | 1 | persisted |
| 48 | 10:47:27 | rag-hit | 8.1 | 1 | persisted |
| 49 | 10:50:29 | normal | 7.7 | 1 | persisted |
| 50 | 10:54:04 | contradiction | 1.2 | 2 (first 503, then 503) | failed: PROVIDER_UNAVAILABLE |
| 51 | 10:57:34 | prompt-injection | 4.8 | 1 | persisted |
| 52 | 11:01:15 | rag-miss | 5.7 | 1 | persisted |
| 53 | 11:04:23 | safety-hazard (gas) | 5.0 | 1 | persisted |
| 54 | 11:07:17 | rag-hit | 3.7 | 1 | persisted |
| 55 | 11:10:42 | normal | 5.3 | 1 | persisted |
