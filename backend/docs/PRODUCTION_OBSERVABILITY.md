# Production observability and alerting (Phase 38)

Status labels: **CODE VERIFIED** = the event/field exists and a test proves it. **NOT VERIFIED - EXTERNAL OPERATIONAL REQUIREMENT** = needs log shipping, a metrics
system or an alert router that this repository does not contain. Every threshold below is **INITIAL / TUNING REQUIRED**: there is no production traffic and no
evidence from which to derive a defensible number (Phase 37 sampled 12 real calls only; that is a smoke signal, not a rate).

## 1. Integration boundary (what the repository does and does not do)

* The backend writes **one JSON line per event to stdout**, prefixed `[KOI EVENT]` (`src/utils/logEvent.js`). Nothing ships, stores, indexes or alerts on them.
  **No log shipper, metrics endpoint, dashboard or alert rule exists in this repository, and none is claimed.** The hosting platform (or an agent such as a log
  forwarder) must collect stdout, parse the `[KOI EVENT]` JSON, and create the metrics/alerts below. Until that is done there is **no production alerting**.
* The durable record is the `AnalysisAdmission` collection (metadata only, workspace-scoped, one row per analysis attempt). It is read through
  `analysisAdmissionService.listAnalysisAdmissions` only; there is no HTTP route for it yet.
* `node scripts/phase37/summarize-events.mjs <logfile>` turns a captured log into counts by event, outcome, `decidedAt`, `reasonCode`, `ruleCode`, failure class and
  status. It is an offline helper for tuning thresholds, not a monitor.
* Allowed event fields (and nothing else) are fixed in `ALLOWED_FIELDS`: `requestId, attemptId, outcome, decidedAt, stage, code, reasonCode, ruleCode, failureClass,
  httpStatus, provider, model, latencyMs, modelConfidence, confidenceCeiling, finalConfidence, confidenceCapped, learningUsed, evidenceSetId, method, route,
  permission, resource, errorClass`. **There is no field for prompts, model output, Signal/evidence/claim text, user, workspace or Signal ids, tokens or keys.**
* Correlation: `X-Request-Id` (a canonical uuid; a caller-supplied non-uuid is replaced) -> `requestId` on the event -> the same `requestId` on the audit row;
  `attemptId` ties an event to its audit row. `ruleCode` (Phase 38) names the exact claim-validation rule that rejected an analysis.

## 2. Events, meaning, metric, alert, response

Windows are initial. "Baseline" means: compare against the same hour of the previous week once enough traffic exists.

| EVENT | WHAT IT MEANS | METRIC (derive from the log) | ALERT CONDITION (INITIAL / TUNING REQUIRED) | OPERATOR RESPONSE |
|---|---|---|---|---|
| `analysis.accepted` | an analysis passed every admission stage and was stored | count; `latencyMs` p50/p95; share with `confidenceCapped=true` | no events at all for 30 min while `analysis.rejected` or requests continue (a dead pipeline looks like silence) | check the AI service and Gemini quota; check stdout is still being collected |
| `analysis.rejected` | an attempt failed or was refused after it began; `decidedAt` says where (`provider, schema, identity, claims, safety, prose, identifier, retrieval, persistence`) | rejection ratio = rejected / (accepted + rejected); count by `decidedAt`, `reasonCode`, `ruleCode`, `failureClass` | ratio above 25% over 30 min with at least 20 attempts. Phase 37's real sample rejected 1 of 12 for a claim-stage reason, so 25% is roughly three times that - a guess, not a measurement | group by `decidedAt`: provider/retrieval -> infrastructure; claims/safety/prose/identifier -> model quality or a prompt/policy change; see the sub-rows below |
| `analysis.rejected` with `failureClass=provider_unavailable` or `provider_timeout` or `decidedAt=provider` | Gemini or the AI service is failing or slow | count by `failureClass`; `httpStatus` 502/503/504 | 5 or more in 10 min, or any burst of 3 consecutive | check AI-service health and logs, Gemini status and key/quota; do **not** add retries - the design has none |
| `analysis.rejected` with `reasonCode=AI_SERVICE_TIMEOUT` / `PROVIDER_TIMEOUT` | an AI timeout (Node 25 s analysis, AI service 20 s provider ceiling) | count of timeouts; `latencyMs` of accepted calls | 3 or more in 10 min, or accepted p95 above 15 s | same as above; compare latency before timeouts began |
| `analysis.rejected` with `decidedAt=retrieval` | the knowledge-retrieval deadline was exhausted | count | any sustained rate (5 in 10 min) | check embedding service latency and knowledge volume (`SIMILARITY_MAX_CANDIDATES`) |
| `analysis.rejected` with `reasonCode=CLAIM_VALIDATION_FAILED` and a `ruleCode` | the model's claims violated an evidence/provenance rule (see section 3) | count by `ruleCode` | any single `ruleCode` above 10% of attempts in 1 h; any **new** `ruleCode` appearing | read the rule in section 3; a rise in `CLAIM_UNKNOWN_REF` / `CLAIM_FOREIGN_REF` can indicate a prompt/context regression; **do not weaken the validator** |
| `analysis.rejected` with `decidedAt=safety` / `prose` / `identifier` | a safety-policy, prose-consistency or identifier guard refused the output | count by `decidedAt` | any non-zero rate over a day deserves a look; sustained above 5% | review the rule code in the audit row; these are working guards - a rise means model drift or a changed Signal mix |
| `analysis.audit_write_failed` | the audit row could not be written; the analysis outcome was unaffected | count (the process also keeps a counter) | **any occurrence** pages: audit trail has a gap | check MongoDB health and permissions; the missing row is unrecoverable (the log line is the only trace); investigate before it repeats |
| `analysis.attempt_succeeded` | (Workstream 5A) the durable attempt marker of an analysis was finished `succeeded` | count; ratio to `analysis.accepted` (should match) | none by itself | a persistent gap against `analysis.accepted` means marker writes are failing: see `analysis.attempt_write_failed` |
| `analysis.attempt_failed` | the attempt marker was finished `failed` (its failure class is in the marker and in the matching `analysis.rejected`) | count; ratio to `analysis.rejected` | same thresholds as `analysis.rejected` | read the matching `analysis.rejected` event for the class and stage |
| `analysis.attempt_interrupted` | graceful shutdown marked the attempts this process owned as interrupted (`ATTEMPT_INTERRUPTED`) | count per deploy | more than the number of requests in flight at a deploy | none; a person may ask again |
| `analysis.attempt_expired` | a request found an in-progress marker older than the staleness horizon (140 s by default: its process ended without finishing) and expired it | count | any sustained rate: processes are dying mid-analysis (crash, OOM, hard kill) | check deploys and process health; the analysis was not stored and was not retried automatically |
| `analysis.attempt_elsewhere` | a request found a FRESH in-progress marker owned by another process (or by one that died moments ago) and answered 202 without starting a provider call | count | none | none; expected with more than one instance or shortly after a restart |
| `analysis.attempt_write_failed` | a marker update failed (error class only); the analysis outcome was NOT changed | count | any | check MongoDB health; the analysis result itself is unaffected, but its marker may stay `in_progress` until the staleness horizon |
| `analysis.coalesced` | a duplicate request joined an analysis already running for the same (workspace, Signal, level) | count; ratio to accepted | ratio above 20% over 1 h (unusual: clients retrying or double-submitting) | look for a client retry loop or a double-click; in production with more than one Node instance this event under-reports (single-flight is process-local) |
| `governance.rejected` | `SEPARATION_OF_DUTIES` or `PROPOSER_UNKNOWN` refused a review | count | 5 or more in 1 h from the same `route` | expected occasionally (a person reviewing their own proposal); a burst suggests a workflow or training problem, or a probe |
| `authz.denied` | a 401 or 403 | count by `httpStatus`, `code`, `permission`, `route` | 401 above 50/min sustained (credential stuffing or an expired IdP key set); 403 above 20/min on one `permission` | 401 burst: check the IdP/JWKS and clock skew first; 403 burst: a role mapping error or a probe |
| (absence) process start with a `Refusing to start` line | the process refused unsafe configuration | the process exits with code 1 and a fixed message | any restart loop (3 starts in 10 min) | read the message; it never contains a value; fix configuration per `PRODUCTION_ENVIRONMENT_CONTRACT.md` |
| (platform) health | `GET /api/health` | HTTP 200 | 2 consecutive failures | check the process, MongoDB and the platform; the endpoint does not exercise Gemini |

## 3. Claim-validation reason codes (`ruleCode`)

Stable, deterministic identifiers of **which** claim rule rejected an analysis. Carried as `details.rule` in the 502 error body, as `ruleCode` on the audit row and
on `analysis.rejected`. They contain no claim text, evidence text or identifier. They are produced by the existing validator at the existing reject sites; no rule
was added, removed or relaxed, and nothing is repaired automatically. The HTTP status and `reasonCode` (`CLAIM_VALIDATION_FAILED`) are unchanged.

| ruleCode | Meaning |
|---|---|
| `CLAIM_MALFORMED` | a claim is not an object / has the wrong shape or field types |
| `CLAIM_TOO_MANY` | more claims than the cap |
| `CLAIM_MISSING_REQUIRED_EVIDENCE` | no claims at all where claims are required |
| `CLAIM_UNKNOWN_TYPE` | a claim type outside the catalogue |
| `CLAIM_MISSING_SOURCE_REFS` | a claim cites no source, or more than the maximum |
| `CLAIM_DUPLICATE_REF` | a claim cites the same source twice |
| `CLAIM_UNKNOWN_REF` | a claim cites a reference that is not in THIS request's evidence set (invented, malformed, or another tenant's - indistinguishable by design) |
| `CLAIM_FOREIGN_REF` | the evidence envelope or an item in it belongs to a different workspace (tenant-boundary guard) |
| `CLAIM_EVIDENCE_TYPE_MISMATCH` | the cited evidence class cannot support this claim type |
| `CLAIM_INVALID_FACT_SUPPORT` | a FACT claim with no current operational fact behind it |
| `CLAIM_INVALID_HISTORICAL_PATTERN` | a HISTORICAL_PATTERN claim with no operational history behind it |
| `CLAIM_INVALID_BUSINESS_GUIDANCE` | a BUSINESS_GUIDANCE claim with no business knowledge behind it |
| `CLAIM_INVALID_LEARNING_OBSERVATION` | RESERVED: a LEARNING_OBSERVATION claim with no Learning context behind it. Under the current rules it cannot be reached (a wrong class is `CLAIM_EVIDENCE_TYPE_MISMATCH` first); kept so a future rule change can never emit an unlisted code |
| `CLAIM_UNSUPPORTED_RECOMMENDATION` | a RECOMMENDATION claim with neither a current fact nor business knowledge behind it |
| `CLAIM_NO_RECOMMENDATION` | no RECOMMENDATION claim among the claims |

The AI service attaches the same style of code (`rule`) when Gemini's own output fails its contract on claims (a claim with no `sourceRefs`, an unknown
`claimType`, a malformed claim), derived from the **location** of the failure only, never from the content. Node accepts a `rule` only if it matches
`^[A-Z][A-Z_]{2,47}$`; anything else is dropped.

## 4. What is not verified

NOT VERIFIED - EXTERNAL OPERATIONAL REQUIREMENT: log collection from the hosting platform; parsing and indexing of `[KOI EVENT]` lines; creation of the metrics and alerts above;
an on-call route; a dashboard; retention of logs (note: log retention is also the only record for the rare audit-write failure); synthetic probes. None of these exist in
the repository.
