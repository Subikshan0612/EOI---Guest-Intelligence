# Workstream 5C — Provider deadline increase and real slow-path validation

Status: implemented and measured locally. **Not committed, not pushed, not deployed.** Date: 2026-10-13.
Evidence labels: **PROVEN** = directly observed in this workstream; **SUPPORTED** = strongly suggested by collected evidence (this or earlier workstreams); **UNKNOWN** = not established by the sample.

## 1. Executive conclusion

1. **The timeout architecture is separated and works** (PROVEN: 46 suite checks, 13 + 531 pytest, the regression runs): browser, HTTP response window, attempt lifetime, retrieval, Node→AI-service wait and the Gemini analysis deadline are now six different numbers with different owners. A call that takes longer than the browser-facing 25 s window now answers HTTP 202, keeps running, persists and is discovered by the page — with the real Node → real AI service → real Gemini stack and the real frontend in a real browser (two runs, one provider call and one attempt each).
2. **The evidence does not establish which of 30 / 45 / 60 s is the right Gemini deadline.** In this workstream's real-provider sample (63 production-shaped analyses over six categories) Gemini was in its **fast state**: 62 of 63 calls took 2.2–8.7 s, one took 19.6 s, none exceeded 20 s, none produced a 503/504/timeout. The sample therefore contains **no observation that distinguishes the three candidates** (UNKNOWN). The only observations of completions beyond 20 s remain Workstream 3B's two calls (25.0 s and 52.9 s, SUPPORTED).
3. **Provisional selection: 60 s** (LLM_ANALYSIS_TIMEOUT_MS default 60000; also the configurable ceiling), with a defined follow-up measurement (section 18/19). It is chosen on cost-asymmetry under the new architecture, not on new evidence: a deadline above the 25 s window costs the person nothing visible (they see "in progress"), a truncated slow-but-completing call wastes the provider work and forces a retry into the same slow state, 45 s adds nothing observed over 30 s, and no observation (3B used a 90 s deadline; none of its 10 slow calls failed) shows hung calls. This is **not** a claim that 60 s guarantees completion, that 60 s is needed, or that 30 s would be unsafe.
4. **FINAL GATE: B — CONDITIONAL PASS.** The architecture and slow path are correct and tested; the final deadline value needs one specific further measurement (section 14/16/18): provider durations from real traffic that includes at least one slow-state period.

## 2. Previous evidence summary

| Source | Established | Label |
|---|---|---|
| Diagnostic / health check | failures originate at Gemini (503, 504 DEADLINE_EXCEEDED), none in Node/Python/retrieval/validation/persistence | PROVEN (earlier) |
| Workstream 1 | one 503 retry, 504/timeouts/4xx never retried; correlation id and provider events | PROVEN (earlier) |
| Workstream 2 (20 s deadline, 50 requests) | 36 ok, 14 failed (11 × 504 at 17.0–19.8 s, 2 client timeouts, 1 × 503+503); 13 of 14 in one 8-minute window | PROVEN for that window |
| Workstream 3B (90 s deadline, 18 calls) | a slow-state period (about 38+ min); 10 slow calls (11.3–52.9 s) **all completed**: 25.0 s and 52.9 s beyond 20 s; none beyond 60 s | PROVEN for those 18 calls |
| Workstream 4 | recommended the hybrid; 60 s as a *design target to validate* | design |
| 5A / 5B | AnalysisAttempt lifecycle, 202 + status read, page states | built and tested |

## 3. Actual timeout chain (read from code, before the change)

Browser → Node → AI service → Gemini, with what each number actually was:

| Layer | Value before 5C | Source | Note |
|---|---|---|---|
| Browser, analyze request | 30,000 ms | `frontend/src/services/api.js` | unchanged |
| Node HTTP response window | 25,000 ms | `getAnalysisResponseWindowMs` (5A) | unchanged; after it the request answers 202 |
| Node attempt lifetime | ≤ 110 s (socket 120 s − 10 s margin); stale marker after 140 s | `getAnalysisTimeBudget`, `getAnalysisAttemptStaleAfterMs` | unchanged |
| Node → AI service (analysis) | **25,000 ms = `KOI_AI_TIMEOUT_MS` 20 s + 5 s** | `getAiAnalysisTimeoutMs` | **coupled to the retrieval setting** |
| Node retrieval | each call min(20 s, remaining); total = deadline − analysis wait = **85 s** | `knowledgeRetrievalService`, `nextRetrievalCallTimeoutMs` | per-call value is the same `KOI_AI_TIMEOUT_MS` |
| Python embedding / legacy generate | `REQUEST_TIMEOUT_MS` 20 s (ceiling 20 s) | `gemini_embedding_client.py`, `gemini_client.py` | same setting as the analysis deadline |
| **Python → Gemini analysis** | **`REQUEST_TIMEOUT_MS` 20 s** (SDK read timeout; the SDK also sends `X-Server-Timeout`, so Gemini enforces the same value) | `gemini_analysis_client.py`, `provider_policy.py` | **the dominant deadline** |
| 503 retry | one retry, 1 s delay, first attempt ≤ 3 s | `provider_observability.py` | worst case 3 + 1 + 20 = 24 s ≤ 25 s wait |
| Node HTTP server | headers 15 s, request 60 s, socket idle 120 s, keep-alive 5 s | `getHttpTimeouts` | not binding for analysis |
| Hosting / proxy / load balancer | **UNKNOWN**: no deployment configuration exists in the repository; cannot be established locally | — | a synchronous response beyond the host's limit is cut regardless; the 202 design keeps each HTTP request at ~25 s |

**Which timeout dominated:** the Gemini/SDK 20 s deadline. **Hidden coupling found:** raising only that deadline would have made the **Node→Python wait (25 s)** the next binding timeout (a 504 `AI_SERVICE_TIMEOUT` at 25 s, losing the provider classification), and one setting (`REQUEST_TIMEOUT_MS`) governed both the slow analysis call and the embedding call that retrieval depends on; and one setting (`KOI_AI_TIMEOUT_MS`) governed both Node's wait for the analysis and each retrieval call.

## 4. Timeout separation changes

After 5C (all values are defaults; the first two are new settings, everything else existed):

| Boundary | Value | Setting / constant | Why separate |
|---|---|---|---|
| 1 Browser analyze wait | 30 s | `api.js` | unchanged; must exceed the response window |
| 2 HTTP response window | 25 s | `KOI_ANALYSIS_RESPONSE_WINDOW_MS` (optional) | the person's wait for ONE request; after it, 202 |
| 3 Attempt lifetime | ≤ 110 s; stale after 140 s | budget functions | the attempt continues after the 202 |
| 4 Retrieval per call / total | 20 s per call (`KOI_AI_TIMEOUT_MS`); **45 s total** | `getAnalysisTimeBudget` | stays short and independent of the Gemini deadline |
| 5 Node → AI-service analysis wait | **65 s = 60 s analysis ceiling + 5 s** | **`KOI_AI_ANALYSIS_TIMEOUT_MS` (new, optional)** | must outlive the Gemini deadline plus a 503 retry; no longer follows `KOI_AI_TIMEOUT_MS` |
| 6 Gemini analysis deadline | **60 s (provisional)**, ceiling 60 s | **`LLM_ANALYSIS_TIMEOUT_MS` (new)** in the AI service | its own setting and ceiling |
| (embedding / legacy) | 20 s, ceiling 20 s | `REQUEST_TIMEOUT_MS` (unchanged) | a longer analysis deadline never lengthens an embedding call |

Cross-service contract: two ceilings, mirrored and asserted equal (20 s embedding-side, 60 s analysis-side). Node's start-up check on the real route requires its analysis wait to **exceed 60 s**; the AI service validates its own value at start-up and again before every call. Retry arithmetic (3 s + 1 s + deadline ≤ Node wait − 1 s) is asserted for every permitted deadline (pytest `test_07`, suite `A2`).

**Side effect (honest):** because Node always reserves its full 65 s analysis wait inside the 110 s request deadline, the **total retrieval budget fell from 85 s to 45 s**. Each retrieval call is still 20 s; only a pathological corpus needing > 45 s of retrieval now fails closed (existing behaviour) sooner. In this workstream's sample, attempt wall time minus Gemini time was 0.5–1.9 s in total (retrieval, context assembly and persistence together). Raising `KOI_SOCKET_TIMEOUT_MS` would restore 85 s; not done (no evidence it is needed; flagged, section 17).

## 5. 30 s measurements, 6. 45 s measurements, 7. 60 s measurements

Method: three instrumented (observation-only) copies of the **unmodified** AI service, one per candidate deadline, each with its own Node backend (shipped defaults: 25 s window, 65 s wait), production Gemini model `gemini-3.1-flash-lite`, production prompts and 4096-token limit, **real Gemini**. Six categories (normal A1, contradiction C1, prompt-injection H1, RAG-miss F2, safety-critical gas G1, RAG-hit E2), fresh identically-shaped case per attempt, sequential, 3 s gap, order rotated across deadlines so each deadline saw the same provider state. Two runs: a full run of 54 attempts (3 rounds × 6 categories × 3 deadlines) and an **earlier partial run of 9 attempts** (a harness bug — room numbers grew to 5 digits and the intake could not parse them — stopped it after 3 categories; the 9 attempts are valid and included). Total **63 attempts, 63 provider calls: 3–4 per category per deadline** (4 for normal / contradiction / prompt-injection, 3 for RAG-miss / gas / RAG-hit). Individual observations and counts only — no percentiles.

| | 30 s | 45 s | 60 s |
|---|---|---|---|
| total attempts | 21 | 21 | 21 |
| successful completions (persisted) | 19 | 21 | 20 |
| provider 504 / deadline failures | 0 | 0 | 0 |
| provider 503s | 0 | 0 | 0 |
| 503 retry recoveries | 0 (none occurred) | 0 | 0 |
| client-timeout failures | 0 | 0 | 0 |
| validation failures (Gemini answered; Node's output guards rejected it) | 2 (`OUTPUT_GUARD_VIOLATION`, `PROSE_CONSISTENCY_VIOLATION`) | 0 | 1 (`PROSE_CONSISTENCY_VIOLATION`) |
| persistence failures | 0 | 0 | 0 |
| 202 path used (request exceeded the 25 s window) | 0 | 0 | 0 |
| final analysis persisted | 19 of 21 (the 2 not persisted are the validation rejections) | 21 of 21 | 20 of 21 |
| Gemini call duration, observed range (ms) | 2,227 – 8,658 | 2,592 – 6,844 | 2,516 – **19,647** |
| output tokens, observed range | 545 – 1,117 | 622 – 1,058 | 604 – 1,130 |
| attempt wall time, observed range (ms) | 2,713 – 9,134 | 3,085 – 7,352 | 2,993 – **21,192** |

All 63 individual Gemini durations (ms): 30 s — 2227 2543 2742 2960 2974 3162 3252 3465 3501 3538 3615 3825 3944 4417 4600 4739 4849 5177 5974 6320 8658; 45 s — 2592 3043 3094 3281 3508 3671 3808 4025 4489 4606 4745 4781 4826 4846 5058 5175 5603 6287 6449 6626 6844; 60 s — 2516 2657 2765 2936 3358 3572 3572 3699 3795 4185 4521 4578 4590 4623 4681 4814 5367 5401 5532 6996 19647. By category the observed Gemini ranges (ms) were: normal 2,960–6,287; contradiction 3,252–6,844; prompt-injection 2,227–6,626; RAG-miss 2,657–8,658; safety-critical (gas) 2,543–6,449; RAG-hit 2,742–19,647.

What this does and does not show:

* **PROVEN:** in this period, at every candidate deadline, every request that reached Gemini got an answer within 19.7 s; no candidate deadline truncated anything, and no provider error of any kind occurred.
* **PROVEN:** the one 19.6 s call (RAG-hit, 60 s configuration) would have survived the *old* 20 s deadline by 0.35 s; its wall time (21.2 s) was inside the 25 s window, so it was a normal 201.
* **UNKNOWN:** which deadline truncates legitimate slow calls — none of the 63 calls was slow enough to be affected by any of the three. The sample has no power to separate the candidates. It does **not** show the provider is stable: it shows that today, in this window, it was fast.
* The three validation rejections are **not timeout-related** (the provider answered successfully in 2.7–4.7 s; Node's existing output guards rejected the text). They are reported because they were observed (3 of 63; cause and base rate UNKNOWN — a separate matter from this workstream, unchanged code).
* No failure percentages are claimed, and none are comparable to Workstream 2's (that run was in a slow window).

## 8. Real slow-path browser E2E

Stack: real Vite frontend → real Node backend (shipped defaults) → real AI service (instrumented) → **real Gemini** (`gemini-3.1-flash-lite`), isolated local database. **Disclosure of the one artificial element:** Gemini was fast, so a natural 25 s+ call could not be waited for. For each of two reports a **one-shot hold** (scratchpad launcher only; not repository code) delayed *delivery of the real Gemini response* to Node by 32 s and 34 s. The Gemini call itself was real and completed inside its deadline (real provider time 2.5 s and 6.3 s). The deadline was **not shortened**.

| Step | Observed (report 1 / report 2) |
|---|---|
| User sends a report | recorded; `POST /intelligence/analyze` |
| Backend reaches the window | **HTTP 202 after 25.04 s** (both) |
| Browser shows the real in-progress state | page text "Still preparing this assessment — This request is still being worked on, so you don't need to send it again…" (sampled 28 s after sending); progress strip "Assessment IN PROGRESS" |
| No Try again / failure wording / Decision while running | confirmed (JS probe + page text) |
| Gemini continues; analysis completes; persisted | attempt rows `succeeded` after 35 s and 41 s; 2 stored analyses |
| Status reads discover success | browser status reads at ≈ +2.9 s, +7 s, +11 s, +17 s after the 202; the last found `succeeded` |
| Normal assessment appears | "Validated safety assessment" rendered; "YOUR DECISION" section appears only now, nothing approved |
| Polling stops | 4 reads, unchanged over a further 10 s |
| **Provider calls / attempts** | **2 provider calls for 2 reports (1 each); 2 attempt rows; 2 admissions (`accepted`, Learning false); 0 Decisions / Actions** |

(Report 1: in-progress was between the window and the result; my first sample bracketed it, so report 2 was sampled inside it; the 202 timing and status reads of report 1 are in the browser performance log.)

Also covered at the API level with a controllable provider (`validate-hybrid-5c-deadline.mjs`, section C): a provider that takes **40 s** → 202 at the 25 s window, same attempt continues, persisted after ≈ 40 s (Node did **not** cut at 25 s: that is the proof of the decoupled 65 s wait), exactly one provider call, one analysis, one attempt row; a repeat request returns the stored analysis with no provider call.

## 9. 503 retry verification

Real Node → real AI service (real SDK, real timeouts, real classification, real retry) → a **local fake Gemini** (no real provider; `GOOGLE_GEMINI_BASE_URL`), plus pytest at 30 / 45 / 60 s deadlines with a spare success queued to expose any third call:

| Case | Provider calls | Result |
|---|---|---|
| 503 → success | **2** | persisted (201) |
| 503 → 503 | **2** (spare success never consumed) | existing safe failure; nothing persisted |
| 503 → slow success (28 s, past the window) | **2** | 202 at the window, then persisted; fits inside Node's wait |
| 504 | **1** | classified timeout; no retry |
| timeout (AI service deadline 1.5 s vs a 6 s provider) | **1** | classified 504; late answer unused |
| 400 / 401 / 403 / 429 | **1** each | safe failure; no retry |
| 500 | **1** (pytest) | no retry |

The retry rule itself is unchanged (`MAX_PROVIDER_ATTEMPTS = 2`, 1 s delay, first attempt ≤ 3 s). With the analysis ceiling at 60 s the worst case is 3 + 1 + 60 = 64 s inside Node's 65 s wait (1 s headroom, asserted for every deadline 1–60 s). **Not tested:** a real Gemini 503 (none occurred) — recovery rate of the retry remains UNKNOWN (earlier: 0 of 1).

## 10. Safety-critical verification

No safety policy was created or modified. For gas, smoke, fire, carbon monoxide and access-refusal + hazard (suite section D, real Node + real AI service + controllable provider):

* **Classification is available before and independent of the analysis** (PROVEN): the unchanged deterministic policy returns `LIFE_SAFETY_HAZARD`, minimum urgency `immediate`, from the Signal alone for all five, with no attempt row and no analysis yet; the server-derived structured issue is stored on the Signal at intake and stays readable and unchanged while the analysis runs.
* **In-progress does not imply the hazard can wait** (PROVEN for the page logic): while the attempt runs the page shows the in-progress block plus the hazard sentence (5B) for server-classified reports; no "can wait / later / no rush" wording; no Try again.
* **Failure does not weaken the posture** (PROVEN): a provider 504 after the window leaves the attempt `failed` (one provider call, nothing stored, no Decision/Action); the page shows the existing failure wording **and** the hazard sentence, with the explicit retry offered.
* **Existing enforcement unchanged on the slow path** (PROVEN): an analysis below the minimum for a gas report (urgency `routine`) is rejected after the 202; nothing stored; stored analyses for the five categories meet the existing minimum (urgency `immediate`; for access refusal the action type is not an entry-requiring one).
* **No new AI-generated safety instruction is invented** (PROVEN structurally): no code path produces text for a hazard when the model has not answered; Decision/Action gating is unchanged (proposals refused while in progress and after failure).
* **Per-category classification observed** (policy / stored structured issue / hazard sentence shown): gas → `LIFE_SAFETY_HAZARD` / `gas_supply/safety_hazard` / yes; smoke → `smoke_fire/safety_hazard` / yes; fire → `smoke_fire/safety_hazard` / yes; carbon monoxide → `co_alarm/safety_hazard` / yes; access refusal + hazard → `gas_supply/safety_hazard` / yes. The page's hazard sentence follows the **server-derived structured issue** exactly (asserted). The two classifiers (text policy at analysis time, structured issue at intake) agree for these five; the earlier-noted gap for other cue words (e.g. sparks / burning smell) is a safety-policy matter, out of scope and unchanged.
* One real-Gemini safety request (gas) was part of the 63-call sample (9 attempts, 2.5–6.4 s, all persisted).

## 11. Provider-call counts

| Activity | Provider calls | Attempts |
|---|---|---|
| Deadline sample (real Gemini) | 63 (one per attempt; no retries needed, none duplicated) | 63 |
| Browser E2E (real Gemini + hold) | 2 | 2 |
| 5C suite (fake provider): B1–B5 / C / D | exact counts per case as in the tables (503→success 2; 503→503 2; 504 1; timeout 1; 4xx 1; slow success 1; 503 + slow success 2; each safety slow case 1) | one per case |
| pytest (mock SDK), 30/45/60 s | exact counts per case, never a third | — |

## 12. Persistence results

Real sample: 60 of 63 persisted (the 3 non-persisted are output-guard rejections of a successful provider answer; one of them was in the partial run). Real E2E: 2 of 2 persisted, attempts `succeeded`, one admission each, Learning false. Fake-provider suite: every success persisted exactly once; every failure persisted nothing; failed attempts stay as history; a retry after a terminal failure is a new attempt (5A semantics unchanged).

## 13. Regression results

Baselines: 5A-final / 5B full sweeps (`suites-5a-final`, `suites-5b`, same runner, default environment) and the legacy test-stack runner. Everything below was run after the final code.

| Check | Result |
|---|---|
| **5C suite** `validate-hybrid-5c-deadline` | **46 passed, 0 failed** (fake provider; real Node + real AI service) |
| **5C pytest** `test_analysis_deadline_5c.py` | 13 passed |
| **AI-service pytest, whole suite** | **531 passed, 0 failed** (baseline 518 + 13 new) |
| **5A suite** `validate-analysis-attempt-5a` | 46 passed, 0 failed (one assertion updated: the boundary values, section 20) |
| **5B suite** `validate-hybrid-5b-status-ux` | 72 passed, 0 failed |
| Related suites | phase 21 runtime hardening 248/0; 34 provider policy 55/0; 35 audit/governance 101/0; 36 production readiness 68/0; 37 reliability gate 40/0; 39 preflight 58/0 (57 + 1 new case); observability 29/0; L1.3 61/0 |
| Phase 37 deployment rehearsal (separate script, real processes, no Gemini) | 25 passed, 0 failed (includes the new analysis-deadline refusal cases) |
| Legacy HTTP suites against a throwaway test stack | knowledge-embedding 42/0, knowledge-visibility-api 144/0, intelligence-analysis-api 81/0, phase24 60/0; phase26-evaluation and phase26_5-real-embedding fail exactly as at baseline |
| Frontend `npm run build` | succeeds; **bundle hashes identical** to 5B (no frontend change) |
| Atlas / real Gemini in tests | none |

**Full sweep vs baseline.** Every suite has the baseline result **except**:

* the two new suites (5B, 5C) and phase 39 (+1 case);
* **`validate-ai-provider-observability`** failed 28/1 in the sweep because its check E4 asserted the old coupled values (analysis wait 25 s). This was a **legitimate assertion tied to the thing 5C changed**, not an accidental regression; E4 now asserts the separated values; re-run **29/0**.
* **Environment difference, not a regression:** nine baseline-failing suites that need a running AI service (`validate-ai-service`, `-intelligence-analysis-api`, `-intelligence-persistence`, `-knowledge-embedding/-grounding/-ingestion/-ingestion-upload/-retrieval/-visibility-api`) failed *differently* in this sweep (they got partway before failing) because a service **not started by this workstream** was listening on `localhost:8000` (a development AI service started at 12:13 by something else on this machine). Re-run with the AI-service endpoints pointed at an unreachable port they fail exactly as at baseline; with a proper test stack the HTTP-dependent ones pass (legacy row above). I did not stop that service.

**Known pre-existing / intermittent failures (unchanged, separate from 5C):** the baseline-failing set listed in the 5A/5B reports (`validate-api`, `-dashboard`, `-dev-token`, `-import`, `-knowledge-authoring/-chunking`, `-knowledge`, phase 24/26/26_5/27/29–33/38/41/45a/45b22, `-provision-dev-identity`, and the legacy-stack phase 26 suites) fail identically; Phase 45C check C6 is the intermittent one noted in 5B (did not recur in this sweep). No new failure remains after the E4 correction.


## 14. Selected provider deadline

**60 seconds, provisional** (`LLM_ANALYSIS_TIMEOUT_MS`, default 60000; the configurable ceiling is also 60,000 ms). Gate **B**.

**FINAL GATE: B — CONDITIONAL PASS.** The timeout architecture and slow-path behaviour are correct and verified; the final deadline value is **not** established by the evidence and needs the specific measurement in section 18. This is not a FAIL: nothing found is unsafe or incorrect.

## 15. Why that value was selected (candidate comparison)

| | 30 s | 45 s | 60 s |
|---|---|---|---|
| Known successful observations that fit | 17 of the 18 3B calls (25.0 s fits with 5 s margin); all 63 today | same as 30 s (no observed completion between 30 and 45 s) | all 18 of 3B (52.9 s fits with 7.1 s margin); all 63 today |
| Known successful observation truncated | 52.9 s | 52.9 s | none |
| Known failures that become eligible to complete | the 2 3B calls beyond 20 s (one); Workstream 2's 504s only to the extent they would have finished by 30 s (**UNKNOWN**) | as 30 s (UNKNOWN) | as above (UNKNOWN) |
| Node wait / headroom | 65 s wait, ample | 65 s | 65 s; retry worst case 64 s, 1 s headroom |
| Cost when the provider is stuck | terminal failure after 30 s | after 45 s | after 60 s (the page shows "in progress" meanwhile; a worker thread and an attempt marker are held that long) |
| Cost when the provider is slow but completing | a call between 30 s and its true end is wasted, the person retries into the same slow state | same for calls > 45 s | none for the observed calls |

Reasoning, kept separate from the single 52.9 s point:

* **Does the browser/HTTP architecture make 60 s technically possible?** PROVEN: yes — the 202 path holds each HTTP request at ~25 s regardless of the deadline, the attempt continues, the page reads status; verified end to end with 35–41 s real-stack runs and a 40 s controlled run.
* **Does Node → Python have headroom?** PROVEN: 65 s wait vs 60 s ceiling, retry worst case 64 s; the start-up check enforces ordering.
* **Is 60 s operationally justified by the evidence, or merely possible?** Justified only **provisionally**: the observed tail beyond 20 s is two calls from one earlier slow-state period, and none of 63 calls in this workstream's sample was slow. What the evidence *does* support is that (a) a 20 s deadline truncates completable work (PROVEN earlier) and (b) in the one slow period observed with a long deadline, slow calls completed rather than hung (SUPPORTED, 10 of 10). Neither supports a specific value between 30 and 60 s. 45 s is the least justified candidate (it adds nothing observed over 30 s). The choice of 60 over 30 rests on cost asymmetry under the hybrid UX, not on a measured need; if the follow-up measurement finds no completion beyond 30 s, the value should be reduced.
* The evidence does **not** justify one definitive value; this report says so and gates **B**.

## 16. Evidence limitations

* One provider state: the sample ran in a fast period; **no** call between 20 and 60 s occurred. Small cells (3–4 per category per deadline).
* No concurrency test (sequential, low rate); behaviour of many simultaneous long calls (worker-thread occupancy, rate limits) is UNKNOWN.
* The browser E2E used a disclosed hold of the real response; natural >25 s Gemini behaviour was not observed.
* Hosting/proxy timeouts cannot be established locally (UNKNOWN); the design keeps each HTTP request at ~25 s.
* No percentile is claimed anywhere; 3B's 18 calls and this 63 are not pooled into a distribution.

## 17. Remaining risks

* **A slow state longer or heavier than observed** (calls beyond 60 s) would still be truncated; a hung call holds a thread/marker for up to 60 s.
* **Worker-thread occupancy** (default 40 threads) with several stuck 60 s calls across tenants — arithmetic only, UNVALIDATED.
* **Retrieval budget** shrank from 85 s to 45 s total (per-call 20 s unchanged); restorable by raising `KOI_SOCKET_TIMEOUT_MS`; only pathological corpora are affected.
* **Output-guard rejections** (3 of 63) are a separate, unexplained source of failed analyses.
* Per-process single-flight plus the cross-process attempt marker (5A) remain the duplicate-call guards; a Node restart mid-call still ends in `ATTEMPT_INTERRUPTED` after the 140 s staleness horizon (5A, unchanged).
* The structured-issue vs policy classifier gap (section 10) is unchanged.

## 18. Deferred work and the minimum additional measurement

* **Minimum additional measurement (to turn B into A):** with the existing Workstream 1 `provider.attempt` events (no new instrumentation), collect provider durations from **at least 50 real production-shaped analyses that include at least one observed slow-state period (≥ 10 calls longer than 15 s)** at the 60 s deadline. Decision rule: if no completion lies between 30 s and 60 s and no call reaches the 60 s deadline → lower to 30 s (document why); if completions occur between 45 s and 60 s → keep 60 s; if calls hit the 60 s deadline (504 at ≈ 60 s) → hung calls exist: keep 60 s as the cap, do **not** raise it, and consider the failure UX instead. Do not keep changing the value without that data.
* Deferred, unchanged: 504 retry, a concurrency/load test of long calls, a queue/worker (not introduced), hosting-proxy verification, the structured-issue/policy classifier alignment, output-guard rejection analysis.

## 19. Exact configuration values

| Setting | Value | Owner |
|---|---|---|
| `LLM_ANALYSIS_TIMEOUT_MS` (new) | default **60000** (1..60000) | ai-service |
| `REQUEST_TIMEOUT_MS` | 20000 (1..20000), unchanged; embedding / legacy only | ai-service |
| `LLM_MAX_OUTPUT_TOKENS` | 4096, unchanged | ai-service |
| `KOI_AI_ANALYSIS_TIMEOUT_MS` (new, optional) | default **65000** = 60000 + 5000 | Node |
| `KOI_AI_TIMEOUT_MS` | 20000, unchanged; retrieval / embedding per call only | Node |
| `KOI_ANALYSIS_RESPONSE_WINDOW_MS` | default 25000 (shorter of 25 s and the deadline), unchanged | Node |
| `KOI_SOCKET_TIMEOUT_MS` | 120000, unchanged → request deadline 110 s, retrieval budget **45 s** (was 85 s) | Node |
| Attempt stale horizon | 140 s, unchanged | Node |
| Browser analyze timeout | 30000, unchanged | frontend |
| 503 retry | 2 attempts, 1 s delay, first attempt ≤ 3 s, unchanged | ai-service |
| Ceilings (mirrored, asserted equal) | 20000 (embedding side), 60000 (analysis side) | both |
| `ai-service/.env` | **not modified** (still `REQUEST_TIMEOUT_MS=20000`; the new default applies when the code is deployed) | — |

## 20. Change boundary

Changed (production): `ai-service/app/{provider_policy,config,main}.py`, `ai-service/app/services/gemini_analysis_client.py`, `ai-service/app/provider_observability.py` (comment only), `ai-service/.env.example`; `backend/src/config/{runtimeConfig,startupChecks}.js`, `backend/.env.example`, `backend/docs/PRODUCTION_ENVIRONMENT_CONTRACT.md`.
Changed (tests/tooling): new `ai-service/tests/test_analysis_deadline_5c.py` (13 tests) and `backend/scripts/validate-hybrid-5c-deadline.mjs`; updated assumptions in `ai-service/tests/{test_provider_policy,test_provider_observability}.py` and `backend/scripts/{validate-phase21-runtime-hardening,validate-phase34-provider-policy,validate-phase35-audit-governance,validate-phase36-production-readiness,validate-phase39-preflight,validate-analysis-attempt-5a,validate-ai-provider-observability}.mjs`, `backend/scripts/phase37/deployment-rehearsal.mjs`, `backend/scripts/phase39/env-preflight.mjs` (each only to express the separated timeouts; no assertion about behaviour was weakened).
**Not modified:** Gemini model, system/user prompt construction, output token limit, safety policy, Learning, RAG retrieval semantics, Decision/Action rules, frontend (bundle hashes identical), 5B polling, AnalysisAttempt semantics, the 503 retry policy, `.env` files, `.claude`, `CLAUDE.md`. No queue or background worker was introduced. Nothing committed, pushed or deployed. Historical docs (`PRODUCTION_HARDENING_PHASE35.md`, earlier workstream reports) still describe the pre-5C single 20 s timeout and are left as the record of their time.
