# Phase 35 - Production hardening: auditability, provider reliability, human governance

Status: implemented and verified by `backend/scripts/validate-phase35-audit-governance.mjs` (deterministic; no Gemini call, no key).
This document describes only what exists in the code. Anything not listed here was **not** done (see "Known limitations").

Principle (unchanged): Node determines facts, trust, policy, admissibility and tenant boundaries. Gemini interprets the supplied
evidence and recommends. Node validates deterministically before persistence. The model is never the authority for tenant scope,
provenance, policy, confidence, or authorization.

Fixed by this phase and still true: the only approved model is `gemini-3.1-flash-lite` (provider `gemini`); no alias, preview, `latest`,
3.6, fallback or automatic substitution. **Learning stays OFF** (`KOI_LEARNING_CONTEXT_ENABLED` unset/false). **No action-execution
capability exists** (`action:execute` is held by no role).

## 1. Audit / admission record (`AnalysisAdmission`)

**What was persisted before:** the accepted analysis (`Intelligence`: situation, evidence, impact, recommendation, *final* confidence,
provider, model, evidence refs, knowledge provenance). **Not persisted anywhere:** a rejected attempt (no trace at all), the model's own
confidence, the server ceiling and the cap, claim types, which stage decided, the safety/prose/identifier results, latency.

**What is persisted now** (new collection `analysisadmissions`, model `src/models/AnalysisAdmission.js`), one row per attempt that
reaches the model - accepted *or* rejected:

| field group | content |
|---|---|
| correlation | `workspaceId`, `signalId`, `attemptId` (random uuid, unique per workspace), `intelligenceId` when accepted, `analysisLevel` |
| decision | `outcome` accepted/rejected, `decidedAt` (`provider`, `schema`, `identity`, `claims`, `safety`, `prose`, `identifier`, `retrieval`, `persistence`, `admitted`), `reasonCode`, `failureClass`, `httpStatus`, per-stage `stages` (`passed`/`failed`/`not_run`) |
| identity | `provider`, `model` as reported by the AI service (bounded printable string). Accepted rows are exactly `gemini` / `gemini-3.1-flash-lite` |
| evidence | `evidenceSetId` (SHA-256 over the sorted `ref|class` lines + `chunkId@version`, mixed with the workspace id; one-way), counts per evidence class, counts of cited classes, `knowledgeRetrieved`, `knowledgeRelevant`, `relevanceFloor` |
| confidence | `modelConfidence`, `confidenceCeiling`, `finalConfidence`, `confidenceCapped`, `ceilingReasons`, `safetyState`, `safetyRules`, claim-type counts |
| other | `learningUsed` (always false while Learning is off), `latencyMs` (measured by Node around the AI-service call), `createdAt` |

**Deliberately not stored:** prompts, raw model output, Signal text, guest data, claim text, evidence text, **reference ids**, secrets,
headers. Evidence is summarised as a hash and counts, so the row cannot carry a foreign or invented reference and is not a second copy of
sensitive text. The accepted analysis already lives in `Intelligence`; it is referenced, not copied.

**Not available to Node (so not recorded):** `model_version` and token usage. The Python->Node contract carries only
`provenance: { provider, model }` (the AI service cross-checks the API-reported version before it will report the model). Adding them is a
two-service contract change and was out of scope.

**Workspace isolation:** `workspaceId` is required; the only read functions (`listAnalysisAdmissions`, `getAnalysisAdmissionByAttempt` in
`src/services/analysisAdmissionService.js`) always filter by it; another workspace's attempt id is a 404; a missing/invalid workspace is a 400,
never "all workspaces". **There is no HTTP route** for these records: exposing them needs a permission decision that does not exist yet.

**Persistence policy: best-effort, not fail-closed, not in the analysis write.** The analysis path is a single-document write with no transaction (the only transactional code, workspace
deletion, runs a transaction only when MongoDB is a replica set; the dev database is standalone, and the analysis path never used one). Making the
audit row atomic with the analysis would need a transaction redesign that is out of scope, so it is a second, independent write made after the
outcome is decided. Fail-closed was rejected:
it would make the audit store an availability dependency and report "analysis failed" for an analysis that was validated and stored (and a
retry could pay for the model call again). `recordAnalysisAdmission` never throws; a failed write is logged (error class only) and counted
(`getAdmissionAuditFailureCount`). A failed write means that attempt has **no audit row** - nothing claims otherwise. The counter is
process-local and resets on restart.

Attempts that never start are not audited: a Signal that is missing/in another workspace (404), and an idempotent repeat that returns the
stored analysis without a model call.

## 2. Provider reliability

**Failure taxonomy** (`src/services/ai/analysisFailureTaxonomy.js`): every stable `details.code` maps to exactly one class -
`configuration`, `authentication`, `invalid_request`, `rate_limit`, `provider_unavailable`, `provider_timeout`, `malformed_response`,
`validation_failure` (schema, identity, claims, safety, prose, identifier), `safety_block`, `internal`. Unknown code -> `internal`. Three
paths previously had no stable code and now do: `AI_SERVICE_NOT_CONFIGURED`, `AI_SERVICE_MALFORMED_RESPONSE`, `ANALYSIS_SCHEMA_INVALID`.
The class is stored on every rejected audit row so operations can alert on classes, not message text.

**Request deadline (Phase 35.1: enforced, not reported).** The enclosing limit is the idle-socket timeout (`KOI_SOCKET_TIMEOUT_MS`, 120 s;
the request/headers timeouts only bound how long the *client* takes to send). The internal budget of one analysis request is:

| part | default | rule |
|---|---|---|
| request deadline | 110 s | socket timeout minus a margin of min(10 s, socket/10) (headroom for the database reads, persistence and the response) |
| analysis call | 25 s | `KOI_AI_TIMEOUT_MS` + min(5 s, base/4); always reserved in full |
| retrieval, all calls together | 85 s | deadline minus the analysis timeout, measured from the **start of the request** (so the database reads before retrieval count) |

Retrieval can make up to 10 sequential AI-service calls (2000 eligible chunks / 200 per page). Each call now gets
`min(base timeout, time left in the retrieval budget)` (`nextRetrievalCallTimeoutMs`); when the budget is spent retrieval **fails closed**
(`504 KNOWLEDGE_RETRIEVAL_BUDGET_EXHAUSTED`, class `provider_timeout`), no model call is made and nothing is stored - the same policy already used for
a corpus that cannot be fully scored, so a half-scored corpus is never silently used. Therefore, by construction:
`retrieval time + analysis time <= deadline < socket timeout` (database time is not bounded by any timer here and is covered by the margin).
At the defaults the old 225 s worst case is cut to 4 full 20 s calls plus a 5th shortened to the 5 s that remain. The analysis flow passes its
own deadline; any other request-path caller of retrieval (the standalone retrieval endpoint) gets the same budget measured from the call; the
offline evaluation harness passes none and is uncapped, as before. A corpus that needs more than the budget is refused, not truncated.

**Start-up invariants** (`timeoutBudgetProblems`, called from `server.js`; the server refuses to start): the retrieval budget cannot fit even one
retrieval call (this also covers an analysis timeout that does not fit the deadline); and, on the real `gemini` route only, the analysis timeout
does not exceed the AI service's provider-timeout ceiling. There is no longer any "worst case exceeds the socket timeout" warning because that
case can no longer happen.

**Cross-service timeout contract.** The Gemini SDK timeout lives in the AI service (`REQUEST_TIMEOUT_MS`, default 20 s). Each side validates only
its own configuration against one documented number, `20000 ms` (`PROVIDER_TIMEOUT_CEILING_MS` in `ai-service/app/provider_policy.py`,
`AI_PROVIDER_TIMEOUT_CEILING_MS` in `backend/src/config/runtimeConfig.js`; a test asserts they are equal):
* **AI service** - `REQUEST_TIMEOUT_MS` must be a real integer from 1 to 20000 ms. Checked at start-up (the service refuses to start; it applies when the
  LLM *or* the embedding provider is Gemini, since both use the setting) and again immediately before every analysis call, because `settings` is a
  mutable singleton. A bad value never reaches a request (`PROVIDER_NOT_CONFIGURED`, 503).
* **Node** - on the real `gemini` route its analysis timeout must exceed that ceiling, so the AI service's own classified `PROVIDER_TIMEOUT` always
  fires before Node gives up on the call. Node does not read or own the AI service's settings.
Before this, the AI service accepted any value (`0` or `10**9` included).

**No retry.** Duplicate provider spend, rate-limit amplification and idempotency across the retrieval + model + persistence sequence cannot
currently be proven safe. The Gemini SDK is configured `attempts=1` and Node makes one `fetch` per call.

**No circuit breaker.** The application is process-local: a breaker would be per-instance state that resets on restart, adds a new failure mode
and would not give operators more than the failure classes already stored on each rejection. Nothing substitutes another model.

## 3. Human governance - proposer != reviewer

* New Decision V1 and Action V1 proposals store `proposedBy` (the authenticated actor, `req.actor.userId`) and `governanceVersion =
  "proposer-reviewer-v1"`. `proposedBy` is **required by the schema** whenever `governanceVersion` is set, and `proposeDecision` /
  `proposeAction` refuse a missing or malformed actor (401). A new record without a proposer cannot be stored.
* Approving or rejecting stores `review.reviewedBy` (again `req.actor.userId`). The backend refuses (403 `SEPARATION_OF_DUTIES`) a review by
  the proposer - *before* any outcome, including the idempotent "already approved" answer.
* Nothing comes from the client: a body `proposedBy`/`reviewedBy` is refused (400); query parameters and `x-user-id`-style headers are ignored.
* Role, permission and workspace checks run first and are unchanged (operator/viewer -> 403; admin of another workspace -> 404).
* The public Decision/Action views still publish **no** actor identity; proposer and reviewer are stored only.

**Legacy behaviour (documented, not migrated).** Records created before this phase have no `governanceVersion`/`proposedBy`. There is nothing to
compare with and guessing users would fabricate history, so they stay reviewable exactly as before (the review still records who reviewed). New
records cannot take that path: the marker and the proposer are written in the same insert. A governed record whose proposer is missing
(corruption) is refused (409 `PROPOSER_UNKNOWN`) - fail closed.

**Scope.** Enforced on the V1 AI -> Decision -> Action proposal flow, the only route from AI output to an approved Action (an Action can only be
proposed from a Decision V1). The legacy generic Decision endpoints are unchanged except that they refuse the new fields. Separation is between
the *proposer* and the *reviewer of that record*; a workspace with one eligible person cannot get a review done by design.

## 4. Knowledge relevance and confidence

The 34D confidence policy (evidence-quality class, not a probability) stays authoritative. A retrieved chunk now counts as grounding - for the
HIGH ceiling and for "a recommendation supported by knowledge" - only if its own retrieval metadata says it is relevant: a finite `similarityScore`
that meets the relevance floor. The floor is the server's retrieval floor **but never below the default 0.25**, so a disabled floor
(`-1`, test harnesses) cannot inflate confidence. No new threshold, classifier or model call. A chunk with no/invalid similarity grounds nothing.
Cap, not reject: the analysis is still admitted with a lower confidence, and the audit row records the floor and how many chunks were relevant.

**Honest limit.** Phase 26.5 measured the 0.25 floor as inert with the real embedding model (every query returns 5 chunks; relevant and
unrelated similarities overlap, 0.65-0.89 vs 0.51-0.84). In production this rule is defence in depth against missing/sub-floor metadata, not a
relevance judge, and there is one tier (the floor) - no "weak/strong" distinction exists to enforce. A calibrated, per-model/per-query-task
threshold is separate, measured work. Learning, history and the untrusted Signal text still cannot raise confidence (tested).

## 5. Test / database hygiene

**Cause of the Phase 27/32 residue:** suites that use `authFetch.mjs` create `authfetch-*` / `vis-nonadmin-*` stub users and memberships they
cannot delete; the existing sweeper skips rows younger than 15 minutes (a grace for concurrent suites) and nothing runs after the last suite, so
the next baseline-asserting suite saw 8 users / 6 memberships.

**Fix:** Phase 27, 29, 30, 31 and 32 (which assert an exact baseline and so need exclusive use of the dev DB) call the existing
`sweepStaleAuthFixtures(0)` before they snapshot (29-31 share the cause and were failing the same way when run after an authFetch suite). Scope is unchanged: stub issuer, subjects with the two synthetic prefixes only, and only the
memberships of those users. Nothing else is touched; the provisioned `eoi-dev-*` identity is not a target. Tested in the Phase 35 suite (a
non-prefixed control user survives).

**New collection, same hygiene problem:** analyses written by older suites left `AnalysisAdmission` rows because those suites delete their
throwaway workspaces by hand (120 rows in 33 deleted workspaces were found). `sweepOrphanAdmissions()` (in `scripts/lib/authFixtures.mjs`, run at the
start of suites via `sweepStaleAuthFixtures` and in `cleanupAuthFixtures`) deletes exactly the rows whose workspace no longer exists - such a row is
unreachable (reads are workspace-scoped) and cannot occur in production. A row of a workspace that still exists is never touched.

**Workspace deletion:** `AnalysisAdmission` is part of the workspace deletion order, the per-workspace inventory and the purge
(`workspaceLifecycleService.js`); the Phase 22 guard (DG1/DG4) failed until that was done. `WORKSPACE_LIFECYCLE_POLICY_PHASE22.md` was updated
(it said "no audit collection").

**Stale assertion:** `validate-intelligence-analysis-api` "B grounding" expected the AI-service request key set `{authorizedLevel, context,
knowledge}`; Phase 27 added `operationalHistory` (documented contract). Updated to the current contract and extended with "no `learning` key while
Learning is OFF". The production request was not changed.

Existing suites that proposed and reviewed with the same test user were updated to use a second actor for review (`validate-decision-v1`,
`validate-decision-authorization`, `validate-phase30-outcome-integrity`); `validate-decision-authorization` LC8 previously asserted that
self-approval is allowed and now asserts that it is refused.

## Known limitations

* Audit rows are best-effort: an audit-store outage loses rows for that period (counted in-process only).
* No `model_version` / token usage in the audit row (not carried by the Python->Node contract).
* No HTTP read path for audit rows.
* Database time (reads before retrieval, persistence after the model call) is not bounded by any timer; it is covered only by the deadline margin.
* A corpus that needs more retrieval time than the budget (more than ~4 slow pages at defaults) is refused (fail closed), not partially scored.
* Retrieval floor is inert with real embeddings; confidence relevance is therefore not a true relevance judgement.
* Legacy (pre-Phase-35) Decisions/Actions are reviewable without separation; legacy generic Decision endpoints are not governed.
* Node cannot observe the AI service's actual timeout at run time; the contract rests on each side validating its own configuration against the shared 20 s ceiling (and on the two constants staying equal, which a test checks).
* Rate limiting and the audit failure counter are process-local.
