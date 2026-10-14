# Phase 37 - Reliability, calibration and deployment readiness gate

Verified by `backend/scripts/validate-phase37-reliability-gate.mjs` (deterministic, no Gemini), `backend/scripts/phase37/deployment-rehearsal.mjs`
(production-configuration rehearsal, no Gemini call) and `backend/scripts/phase37/real-sample.mjs` (12 real Gemini calls through the production
path, metadata only). Unchanged and re-verified: the only model is `gemini-3.1-flash-lite`; no fallback; no retry; Learning OFF; no action
execution; no tools; Node validates, the model never decides tenant scope, provenance, policy, confidence or authorization.

## 1. Deployment topology (the questions, answered from the repository)

Evidence: the repository contains **no deployment manifest of any kind** (no Dockerfile, compose file, process-manager, platform or orchestration
config, CI definition); the only statements about topology are in code and docs, and they all describe a multi-instance deployment as a *limitation*
(`rateLimit.js`: "NOT production-grade for a deployment with more than one instance"; `RUNTIME_HARDENING_PHASE21.md`; the production start-up warning).

1. **Is Node expected to run as one instance?** Yes - that is the only topology the code is built and tested for.
2. **Can deployment scale to multiple instances?** Technically yes: nothing refuses a second process, and shared state lives in MongoDB.
3. **Is horizontal scaling currently supported?** **No, not as a supported configuration.** With more than one instance, rate limits are per instance
   (the effective limit multiplies) and analysis single-flight is per instance. Both are reported by a production start-up warning.
4. **If multiple instances run, does the MongoDB schema give enough idempotency?** For *correctness*, yes: the unique `(workspace, Signal, level)`
   index guarantees one stored analysis, and a loser receives the winner's record (`created:false`). Proven with two real backend processes
   sharing one database (test C2: two model calls, one stored analysis, `201` + `200`).
5. **Would duplicate provider spend remain possible?** Yes, for two *simultaneous first* requests for the same Signal landing on different instances:
   both miss the "already stored?" check and both call the model (observed: 2 calls). The extra call is paid but not stored, and the loser writes **no
   accepted audit row** (one accepted row for two calls - a stated observability gap of that topology). Within one instance it is exactly one call.
6. **Is distributed locking necessary?** No. The exposure is bounded (one extra call per simultaneous first request per additional instance), cannot
   corrupt data, and a lock would add infrastructure (and a new failure mode: a stuck claim) that the evidence does not justify. If horizontal scaling
   is adopted later, the smallest MongoDB-native step is a short-lived claim document under a unique `(workspace, Signal, level)` key with an expiry
   (`expireAfterSeconds` set to the request deadline), checked before the model call; that is a design note, **not implemented**.

**Deployment invariant (documented and enforced as a warning):** run ONE backend instance. A production start emits
`Analysis single-flight is PROCESS-LOCAL: the supported topology is ONE backend instance ...` next to the existing rate-limit warning. No behaviour
changed; no infrastructure was added.

## 2. Observability review (Phase 36 events, re-verified)

* Events stay structured JSON, allowlisted, bounded (strings are short safe tokens, one line, no field for content or any person/tenant/Signal id).
  Test B1-B4: hostile values in every allowed field (newlines, instruction text, e-mail, bearer token, 500 characters, ids, JSON, markup, path
  traversal, control and non-ASCII characters) never produce anything but a single-line event of safe tokens; every `logEvent` call site in `src`
  uses only allowlisted fields. Phase 36 already scanned every console line and server output for markers, tokens and ids.
* **Request id on the audit row - implemented (smallest safe addition).** `AnalysisAdmission.requestId` (optional canonical uuid, partial index
  `(workspace, requestId)`; a value that is not a uuid is never stored). It materially improves incident correlation: a user or support ticket
  carries the `X-Request-Id` *response header*, and the durable row can now be found from it directly (`getAnalysisAdmissionByRequestId`, workspace-scoped,
  service level, no route) instead of depending on a log line that may not have been retained. A request that merely *joined* an in-flight analysis
  made no attempt, so it has no row (its event is `analysis.coalesced`).
* **Events -> operational rates (integration boundary, no platform).** The backend writes events to stdout; any collector of stdout can apply these
  counting rules, or pipe a log through `node scripts/phase37/summarize-events.mjs`:

| rate | rule (fields are guaranteed by the allowlist) |
|---|---|
| accepted rate | `analysis.accepted` / (`analysis.accepted` + `analysis.rejected`) |
| provider failure rate | `analysis.rejected` with `failureClass` in configuration, authentication, invalid_request, rate_limit, provider_unavailable, malformed_response, safety_block |
| timeout rate | `analysis.rejected` with `failureClass = provider_timeout` (provider, AI-service or retrieval-budget timeout) |
| validation rejection rate | `analysis.rejected` with `failureClass = validation_failure`; split by `decidedAt` (schema, identity, claims, safety, prose, identifier) |
| audit failure rate | `analysis.audit_write_failed` / attempts |
| coalescing rate | `analysis.coalesced` / (attempts + coalesced) |
| governance rejection | count of `governance.rejected`, by `code` (`SEPARATION_OF_DUTIES`, `PROPOSER_UNKNOWN`) |
| authorization denials | count of `authz.denied`, by `code` / `permission` |

  What is NOT in place: shipping, retention, dashboards and alerting - those belong to whatever platform hosts the service, which the repository does not name.

## 3. Startup tightening found by the rehearsal

Python already refused an unsupported provider; Node only warned on a typo such as `gemni`, silently disabling analysis until the first request.
A non-empty, unrecognised `LLM_PROVIDER` is now **fatal** outside development/test (an *unset* provider stays a warning: running without AI can be
deliberate). The Phase 36 matrix was updated for this and says so.

## 4. Confidence calibration

The Phase 34D/35 ceiling is unchanged. Deterministic proof (A1-A10): every model x ceiling combination yields `min`, end to end through the production
admission function on real evidence shapes; safety is rejected independently of confidence under every shape; Learning, history and untrusted text
cannot raise the ceiling; HIGH needs all four conditions (ablated one by one). **Investigation of the 34C.1 observation:** real Gemini answered HIGH on
18 of 18 responses, including 9 of 9 whose evidence only supported MEDIUM or less (no documented guidance). After the 34D prompt rule, the same
question across later real runs: 34D 0 of 9, Phase 37 0 of 8 admitted calls with a sub-HIGH ceiling said HIGH, and the model said HIGH on 3 of 3 where
the ceiling was HIGH - the ceiling never had to cap in those 30 calls, and remains the guarantee. Small samples; confidence is an evidence-quality
class, not a probability.
