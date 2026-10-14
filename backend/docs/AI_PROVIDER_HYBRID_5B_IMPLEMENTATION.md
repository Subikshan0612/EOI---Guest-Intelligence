# Workstream 5B — Hybrid Analysis Status & UX

Status: implemented and tested locally. **Not committed, not pushed, not deployed.** The provider deadline is unchanged (about 20 s); raising it is Workstream 5C.

5B makes the frontend represent the 5A backend lifecycle: `POST /analyze` → a fast result, **or** `202 in_progress` → the state is read until it ends → a stored result or a terminal failure. The person is never told an analysis has permanently failed merely because the original HTTP response ended.

## 1. UX / state lifecycle

The backend is authoritative. The page keeps no record of its own about whether an analysis exists or is running; it asks, and shows what the server says.

| Phase | Meaning | What the person sees |
|---|---|---|
| `idle` | nothing known / nothing attempted | the normal "There is no assessment for this report yet" + **Assess this** |
| `checking` | one state read on re-entry | "Checking for a saved assessment…" (no flash of an action that may not apply) |
| `starting` | the explicit POST is in flight | "Assessing this against your records and guidance…" (existing line) |
| `in_progress` | server says the attempt is running | restrained block: **Still preparing this assessment**; "This request is still being worked on, so you don't need to send it again. This page will show the assessment as soon as it is ready." No button, no percentage, no estimate, no provider detail |
| `stalled` / state unreadable | the page stopped following (backstop) | still not a failure: "taking longer than expected" / "couldn't be checked"; one **Check again** (a read) |
| `succeeded` | server says it finished | the page reads the stored analysis and renders the normal assessment (nothing is rendered from the POST response) |
| `failed` | server says the attempt ended in failure | the existing fixed failure block + the existing **Try again** |

The case-progress strip shows the Assessment stage as **In progress** (in words, not colour alone) while running; Decision / Action / Outcome stay "Later".

Logic lives in a pure, React-free controller (`analysisAttemptController.js`) with injected API / timers / clock, so it is tested deterministically. The hook (`useCaseGeneration.js`) only wires it to React.

## 2. API interaction

* `startAnalysis` (`services/api.js`): `POST /intelligence/analyze/:signalId`. HTTP **202** with `status:"in_progress"` → `{kind:"in_progress"}`; 200/201 → `{kind:"analysis"}`. A 202 without that state is a malformed-response error, never an analysis. `analyzeSignal` is unchanged.
* `getAnalysisStatus`: `GET /intelligence/analysis-status/:signalId` (existing 5A endpoint, `intelligence:view`). The response is mapped through `analysisAttemptMapping.js` — a closed vocabulary (`not_started | in_progress | succeeded | failed`); anything else is an error, never guessed. A failure carries only a validated `^[A-Z0-9_]{1,64}$` code and HTTP status; free text from the server is never carried.
* A browser-side timeout or lost connection (`CLIENT_TIMEOUT` / `CLIENT_NETWORK`) is **not** the attempt's outcome: the state is read first. A running attempt is shown as in progress; a finished one as the analysis; only "nothing was started" is shown as the (fixed-wording) timeout.
* The `GET` never creates an attempt. `api.start` is called from exactly one place (`start()`), guarded by a test.

## 3. Polling behavior

* Polls **only** while `in_progress`.
* Schedule: first read after **2 s**, then **3 s**, **3 s**, then every **5 s**.
* Why: the attempt has already run for the whole backend response window (25 s) before the 202, so a quick first look is likely to be useful; after that a result is expected to arrive in seconds-to-tens-of-seconds. 5 s steady is prompt enough for the person and costs at most 12 cheap indexed GETs per minute for one open report — negligible next to an analysis, and not aggressive. No countdown or estimate is ever shown.
* One read at a time (never overlapping); a read that has not returned is never joined by another.
* Stops at once on `succeeded` / `failed`, on release (report leaves the screen), on dispose (page unmount), after a **180 s** stall backstop (the backend itself marks an abandoned attempt failed at ~140 s staleness), and after **3** consecutive failed reads (then "couldn't be checked" + **Check again**, not a failure).
* A stale answer (the report was released or restarted while a read was in flight) is discarded via a per-report ticket.

## 4. Refresh / re-entry

`observe()` runs when a report has no assessment shown (one effect in the case card). It does **one** state read and never starts anything:

* `in_progress` → shows the in-progress block and follows it (no second POST);
* `succeeded` (finished while away) → the existing read loads the stored analysis; no provider call;
* `failed` → fixed failure wording + the existing explicit retry;
* `not_started` / unreadable → back to `idle`, exactly the pre-5B behaviour.

If the person's own request overtakes a pending re-entry read, the request wins and the late answer is discarded.

## 5. Retry ("Try again")

Backend remains authoritative; there is no second frontend-side dedupe.

* A. in progress → no new attempt (the controller turns a start into a state read; the page offers no Try again at all while running);
* B. succeeded → the backend returns the stored result without a provider call;
* C. failed → an explicit retry starts a new attempt (only after the previous one is terminal — enforced by the backend);
* D. none → a normal request.

The only local guard is the pre-existing one: one POST in flight per report.

## 6. Safety-critical presentation

Classification: **only** the existing server-derived one — `Signal.issue.problemFamily === "safety_hazard"` with `issue.source === "SERVER_DERIVED"` (set only when the server safety policy says LIFE_SAFETY_HAZARD), mapped to a boolean `serverHazard` in `operationsMapping.js`. No keyword matching or new rule exists in the frontend. No safety policy was changed.

Wording added (one sentence, `HAZARD_NOTE`, shown in the in-progress and failure blocks of a hazard-classified report only):

> This report is marked as a safety hazard. The hazard needs immediate attention either way, whether or not the assessment has arrived.

Why: while waiting, the page otherwise said only that the assessment is being prepared, which could be read as "wait". The sentence reuses the posture the Decision panel already states ("needs immediate attention either way"), so no new instruction is introduced. It names no procedure, role, contact, deadline, or escalation path (asserted by test A7). The in-progress title/body are unchanged for hazard reports; only this sentence is added.

Also changed (all non-hazard): new `interrupted` failure wording for `ATTEMPT_INTERRUPTED` ("The analysis was interrupted before it finished. No analysis was saved. Please try again.").

## 7. Decision / Action gating

The card renders `DecisionPanel`, `ActionPanel` and `OutcomePanel` only inside `intel.status === "ready" && intel.intelligence`. Hence none exists while not-started / in-progress / stalled / failed; no attempt state, role or flag can open them (static test C13). There is no frontend-only authorization (test C15). Backend refusal while in progress was also exercised against the real backend (D10); after success the existing Decision → Action → Outcome flow was run through unchanged (D11: 201, 200, 201, 200, 201).

## 8. Navigation / unmount

* The report leaving the screen → `release()`: polling stops; an in-flight POST is left to finish but its 202 is not followed; the backend attempt is **not** cancelled (no call of any kind is made).
* Coming back → `observe()` reads the state again; no new analysis is created.
* Page unmount → `dispose()` clears every timer; nothing in flight can change state afterwards.
* (A design bug found and fixed before testing: a release during an in-flight POST could orphan its result or start polling for a gone report — fixed with a `released` flag.)

## 9. Security / error boundaries

* Backend error taxonomy untouched. The UI shows only the existing fixed wording; never provider/Gemini text, raw exceptions, DB errors, workspace/request/attempt IDs, secrets, prompts, or unvalidated model output (tests A3, A4, A9, B4, B24, C17).
* Workspace isolation: another workspace's page learns nothing from the state read (refused → stays `idle`), and cannot start or attach to an analysis of another workspace's report — zero provider calls, no attempt row (D15, D16).
* No new dependency, no localStorage, no `setInterval`.

## 10. Test results

New suite `backend/scripts/validate-hybrid-5b-status-ux.mjs`: **72 passed, 0 failed** (isolated DB dropped; deterministic test AI service; no Gemini; no external network).

* A (9) mapping + fixed wording; B (29) state machine with fake clock; C (17) real component rendered to markup in every state; D (17) the real controller against the real spawned backend with a scripted proxy and a 1.2 s response window.
* Mapping of the requested scenarios A–R: fast success (B1, D1); 202 (B2, D2); in-progress→succeeded (B3, D3); →failed (B4, D4); refresh during in-progress (B5/B6, D8/D9); re-entry after success (B7, D7); after failure (B8, D5); repeated Try again while in progress (B11/B12, D8); explicit retry after terminal failure (B9, D6); no duplicate analysis/provider call (D3, D8, D9); Decision / Action unavailable while in progress (C13, D10); existing flow after success (D11); safety-critical in progress / failure (C3, C6, D13, D14); polling stops on terminal state (B3, B4); on unmount / navigation (B13, B15); workspace isolation (D15, D16).

Existing static guards updated to the new card/controller structure (they still forbid any effect from starting an analysis): 43c (48/0), 43d (39/0), 47 (60/0).

Frontend `npm run build`: succeeds.

Full backend regression: see section 12.

## 11. Provider-call counts (deterministic test provider behind a counting proxy)

| Scenario | Provider calls | Attempt rows | Analyses stored |
|---|---|---|---|
| fast success (D1) | 1 | 1 | 1 |
| 202 → succeeded (D3) | 1 | 1 | 1 |
| 202 → failed (D4) | 1 | 1 | 0 |
| re-entry after failure (D5) | +0 | — | — |
| explicit retry after failure (D6) | 2 total | 2 (failed one kept) | 1 |
| re-entry after success (D7) | +0 | no new | 1 |
| refresh + 4 repeated starts + 3 direct POSTs while running (D8/D9) | 1 | 1 | 1 |
| foreign workspace start (D16) | 0 | 0 | — |

## 12. Regression results

Full backend sweep (`backend/scripts/validate-*.mjs`, default environment, run sequentially, compared with the 5A-final baseline): every suite has the same result as the baseline, except the differences below.

* New: `validate-hybrid-5b-status-ux` — 72 passed, 0 failed.
* `validate-learning-l1-3-structured-intake` **F6** failed once, **because of 5B**: it asserted that no frontend source names `problemFamily` / `SERVER_DERIVED`, and the hazard flag in `operationsMapping.js` now reads exactly that (deliberately: the brief requires the existing server-derived classification). Resolution: F6 now allows that one mapping file (and still requires that nothing else, including `services/api.js`, names them); a comment elsewhere in the frontend was reworded so only the mapping boundary names the fields. Re-run: 61 passed, 0 failed.
* `validate-phase45c-account-onboarding` **C6** failed in the first full sweep and in two immediate re-runs, then passed 37/0 in three consecutive re-runs. It is a backend-only suite and 5B changed no backend code; I did not find the cause. Treat it as an intermittent, pre-existing timing/environment flake (a debug copy showed the check's own expressions returning the expected 401s and `IDENTITY_NOT_REGISTERED`). Not fixed; flagged.
* Suites that were already failing at the 5A baseline fail identically (they need the HTTP test stack or are pre-existing failures): `validate-ai-service`, `validate-api`, `validate-dashboard` (1), `validate-dev-token`, `validate-import`, `validate-intelligence-analysis-api`, `validate-intelligence-persistence`, `validate-knowledge-*` (several), `validate-phase24`, `26`, `26_5`, `27`, `29`–`33`, `38` (1), `41` (2), `45a` (6), `45b22` (1), `validate-provision-dev-identity`. None of these is touched by 5B.

Legacy HTTP-dependent suites against a throwaway test stack (ai-service test providers on 8001, backend on 5002, local DB): `validate-knowledge-embedding` 42/0, `validate-knowledge-visibility-api` 144/0, `validate-intelligence-analysis-api` 81/0, `validate-phase24-canonical-intelligence` 60/0; `validate-phase26-evaluation` and `validate-phase26_5-real-embedding` fail exactly as at the 5A baseline.

Existing frontend-related suites: 43a 39/0, 43b 34/0, 43b.2 48/0, 43c 48/0, 43d 39/0, 47 60/0, 52 39/0, 53d 38/0, 49 49/0, 50 44/0, 48 45/0, 5A lifecycle suite 46/0.

AI-service pytest: not run (AI-service code was not touched). Frontend `npm run build`: succeeds.

Two of my own mistakes while verifying, for the record: my first two attempts at running the sweep overlapped each other (a background wrapper did not stop when I thought it had), which mixed their outputs; I discarded both and re-ran once, alone.

## 13. Known limitations

* No real-browser (click-through) verification and no frontend test runner exist in the repo; the UI is verified by rendering the real component to markup (Vite SSR) plus the real controller against the real backend. Visual layout of the new block was not inspected in a browser.
* The 202 path is dormant against real traffic until 5C: with the provider deadline at ~20 s and the response window at 25 s, a real analysis normally ends inside the window. The 202 path was exercised with a shortened window and scripted delays.
* No queue/worker: continuation is the same user-triggered call; an attempt abandoned by a process restart is marked interrupted by the 5A staleness rule (~140 s).
* Windows signal limits apply to the harness's process kill, not to product behaviour.
* Existing pre-5B failures in other suites are unchanged (see section 12).

## 14. Explicitly deferred to 5C

Raising the provider deadline (~60 s) and its ceilings; decoupling the Node→AI-service timeout from the retrieval timeout; re-deriving the 503 retry budget; validating on real traffic. Nothing in these was changed.

## 15. Change boundary

Changed (5B): `frontend/src/services/api.js`; `frontend/src/features/assistant/{analysisAttemptMapping.js, analysisAttemptPresentation.js, analysisAttemptController.js}` (new), `useCaseGeneration.js` (rewritten), `SignalCaseCard.jsx`, `CaseProgress.jsx`, `decisionMapping.js`; `frontend/src/pages/AssistantPage.jsx`; `frontend/src/features/operations/operationsMapping.js`; `frontend/src/features/intelligence/intelligenceErrorPresentation.js`; `frontend/src/styles/assistant.css`; static guards in `backend/scripts/validate-phase43c-…`, `-43d-…`, `-47-…` and `validate-learning-l1-3-structured-intake.mjs` (F6, see section 12); new `backend/scripts/validate-hybrid-5b-status-ux.mjs`; this document.

Not modified: Gemini model, prompt, output limits, provider deadline, 503 retry policy, provider timeout policy, RAG, Learning, safety policy, Decision/Action business rules, AI-service code, deployment configuration, `.env` files, `.claude`, `CLAUDE.md`. No backend production code was changed in 5B.

---

## 16. Closing verification (two focused checks)

### Check 1 — L1.3 guard review (F6)

One correction to the brief's wording: the exception is in **`frontend/src/features/operations/operationsMapping.js`** (the Signal mapping boundary), not `analysisAttemptMapping.js`. `analysisAttemptMapping.js` does not contain either term (verified by search; the only frontend occurrence is one line in `operationsMapping.js`).

1. **What the original guard protects.** `F6` ("NO FRONTEND CHANGE needed or made for the contract") is a tripwire: no frontend source may name `problemFamily` / `SERVER_DERIVED` / `structuredIssue`, so the browser can never become a writer or asserter of the structured issue. The actual integrity guarantees are on the backend and are separate checks: `B4`/`B5`/`B6` (a client-supplied `issue`, source or dotted key is ignored and the schema refuses `CLIENT` / `MODEL` / `LEARNING` sources), `F2` (only `signalService` writes `Signal.issue`; not in the update or create whitelist), `F3` (safety policy does not import it), `F4` (the model context does not contain it).
2. **Why `operationsMapping.js` needs the terms.** 5B must show the added safety sentence only for the report the *server* classified as a life-safety hazard. The one place API Signal shapes become frontend shapes is `mapSignalFromApi`; it reads `doc.issue?.source === "SERVER_DERIVED" && doc.issue?.problemFamily === "safety_hazard"` into a boolean `serverHazard`. Nothing else in the frontend sees the structured issue.
3. **What the exception permits (after review, tightened).** The first version matched the file by *basename* (`/operationsMapping\.js$/`) and only required that the file mention `problemFamily`. That was looser than intended: a different file with the same name in another directory would have been exempt, and the exempt file could have gained further mentions (e.g. a write path). **Corrected, smallest possible change** (test only; no product code): `F6` now exempts exactly `features/operations/operationsMapping.js` (full relative path), requires that file to have **exactly one** non-comment line naming the fields and that line to equal the single read expression above, and requires that the file contains no `issue:` key (no write/serialise shape). All other frontend files, including `services/api.js`, must still contain none of the terms.
4. **File-specific and narrow?** Yes, after the correction: one exact path, one exact line.
5. **Can another frontend file bypass it?** No. Negative tests run: (a) a same-named file at `frontend/src/zz_tmp/operationsMapping.js` naming `problemFamily` → F6 FAILED (as it should); (b) an extra `issue: { problemFamily }` export appended to the real `operationsMapping.js` → F6 FAILED. Both temporary edits were reverted (byte-for-byte identical to the pre-test file) and F6 passes again.
6. **Original intent intact?** Yes. The browser still never writes, asserts or sends the structured issue; the server still derives it and ignores any client value (B4–B6 pass), and the new use is a read of the server's classification into a display-only boolean.

L1.3 after the correction: **61 passed, 0 failed**. The 5B suite after the guard/comment changes: **72 passed, 0 failed**.

### Check 2 — real-browser 202 end-to-end

Setup (local only): isolated MongoDB database (dropped afterwards); the **deterministic test AI service** (no Gemini); a counting proxy in front of it (scripted delays/503); a spawned backend with `KOI_ANALYSIS_RESPONSE_WINDOW_MS=2500` (provider deadline untouched); the real Vite dev frontend (dev access token in the process environment only — `frontend/.env` not modified); driven in the in-app browser against the real Assistant page. One property and one unit were created through the API so the conversational intake could place "Room 204".

| # | Check | Result |
|---|---|---|
| 1 | User starts an analysis (sends a report in the Assistant) | PASS |
| 2 | Backend answers `202 Accepted` after the 2.5 s window (`POST /intelligence/analyze` took 2.53 s) | PASS |
| 3 | Real in-progress state in the browser: "Still preparing this assessment" + "This request is still being worked on, so you don't need to send it again…"; progress strip "Assessment IN PROGRESS" | PASS |
| 4 | No "Try again" while running (also no "Assess this", no failure wording) | PASS |
| 5 | Reload during in-progress: the reloaded page made **0** analyze POSTs, only status reads; provider calls unchanged | PASS |
| 6 | Re-entry read the existing attempt: first read immediately on load, still in progress; no new attempt | PASS |
| 7 | Polling reached `succeeded` on its own (no refresh); cadence in the browser: reads at +0 (re-entry), +2.0, +3.0, +3.0, +5.0 s, matching the schedule | PASS |
| 8 | The persisted analysis rendered in the browser (validated safety assessment, evidence, confidence, recommendation) | PASS |
| 9 | One provider call per report: 3 reports → 3 calls, +1 for the explicit retry = 4 total | PASS |
| 10 | Decision gated: "YOUR DECISION" absent while in progress and while failed; appeared only after the analysis was persisted. (The backend refusal of a Decision/Action proposal during in-progress is covered against the real backend by suite checks D10/D11.) | PASS |
| 11 | Polling stopped after success: status-read count unchanged over a further 10–20 s window (after the first success, after the reload success, after the failure, after the retry success) | PASS |
| 12 | in_progress → failed (scripted 503 after 6 s): in progress first (no failure shown while it ran), then the failure block "Analysis couldn't be completed — The AI analysis service is temporarily unavailable. Please try again." | PASS |
| 13 | UI showed the failure, not "still running"; no raw text (`scripted`, `PROVIDER_UNAVAILABLE`, `503`, `Gemini` absent from the page); polling stopped (2 reads before, 2 after 10 s) | PASS |
| 14 | Explicit "Try again": failure cleared → in-progress → succeeded; database shows exactly **2** attempt rows for that report (`failed`, then `succeeded`), the other two reports 1 each; 3 analyses stored | PASS |

**Provider calls:** 4 total in the browser run = 3 reports (1 call each) + 1 explicit retry after a terminal failure. No duplicate calls from reload, polling or re-entry. No Decision / Action / Outcome records were created by the browser run (nothing was approved).

**Cleanup:** all spawned processes stopped (ports 5199 / 5450 / 8097 / 8098 closed), throwaway database dropped, no leftover test databases.

**Remaining caveats**
* The in-app browser pane is narrow (phone-width); layout of the new block was seen at that width only (it is a restrained text block with the existing left-border style). Desktop-width visual review was not done.
* The 202 was reached with a deliberately shortened response window (2.5 s) and a scripted slow test provider; against real Gemini within the current ~20 s deadline the 202 path is rarely taken until 5C.
* The safety-classified (hazard) sentence was verified by the rendered-markup tests against real server classification (suite D12–D14) and not repeated in the browser (this run used non-hazard reports).
* Intermittent, unrelated: Phase 45C check C6 (see section 12).

**WORKSTREAM 5B CLOSED — READY FOR 5C**
