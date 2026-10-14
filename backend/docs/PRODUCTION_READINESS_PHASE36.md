# Phase 36 - Controlled production readiness and operational validation

Status: implemented and verified by `backend/scripts/validate-phase36-production-readiness.mjs` (Node, deterministic, no Gemini),
`ai-service/tests/test_startup_matrix.py` (Python startup matrix) and the existing suites. This document describes only what exists in code.

Unchanged and re-verified: the only approved model is `gemini-3.1-flash-lite`; no fallback; no retry; Learning OFF; no action execution;
Node stays authoritative for tenant scope, evidence provenance, safety, confidence ceiling, governance and persistence.

## 1. Production observability

**Before:** ad-hoc text lines (`[KOI API] ...`), no request id, no correlation to the audit row, and no trace at all of 401/403 or governance refusals.
The existing text lines in the admission guards were checked and are safe (rule codes and authored reasons only - never model text).

**Now** (`src/utils/logEvent.js`): one JSON line per event, prefixed `[KOI EVENT]`, built so free text cannot enter it:
only allowlisted **field names** are serialised, and a string value must match `^[A-Za-z0-9_.:/-]{1,80}$` - a sentence, e-mail, bearer token,
Signal text, model output or JSON blob does not fit and is dropped. There is **no field** for a user, workspace or Signal id, a prompt, an output,
a header or a key. It never throws.

| event | emitted when | key fields |
|---|---|---|
| `analysis.accepted` | an analysis is validated and stored | `attemptId`, `requestId`, provider/model, `latencyMs`, model/ceiling/final confidence, `confidenceCapped`, `evidenceSetId` |
| `analysis.rejected` | any rejection or failure after the attempt starts | the same, plus `decidedAt` (provider, schema, identity, claims, safety, prose, identifier, retrieval, persistence), `reasonCode`, `failureClass`, `httpStatus` |
| `analysis.audit_write_failed` | the audit row could not be written (analysis outcome unchanged) | `attemptId`, `requestId`, `errorClass` |
| `analysis.coalesced` | a duplicate request joined an in-flight analysis | `requestId` |
| `authz.denied` | 401 / 403 | `requestId`, `httpStatus`, `code`, `permission`, `method`, redacted `route` |
| `governance.rejected` | `SEPARATION_OF_DUTIES` / `PROPOSER_UNKNOWN` | the same |

An operator can therefore tell apart: success, provider/model failure, retrieval timeout, schema failure, evidence/provenance rejection,
safety rejection, governance rejection and audit persistence failure - each has a different event/`decidedAt`/code signature (test A14) -
without any prompt or Signal content.

**Correlation.** `X-Request-Id` (`src/middleware/requestId.js`): a random uuid per request, first in the middleware stack so 404/401/429/error
responses carry one. A caller-supplied id is honoured only if it is itself a canonical uuid; anything else is replaced (no log forging). The
audit row's own random `attemptId` ties an event to its durable row. Neither contains a workspace id, user id or content, and nothing reads
them for any decision. `route` is the request path with 24-hex / uuid segments replaced by `:id`.

**Intentionally not logged:** prompts, model output, Signal title/description, claim or evidence text, reference ids, workspace/user/Signal
ids, tokens, headers, API keys. Tested by running every scenario with markers in the Signal text and the recommendation, a key-shaped string in
the environment and real bearer tokens, then scanning every console line and the spawned server's stdout/stderr (A15, A16).

## 2. Startup / configuration readiness (each service validates only what it owns; both fail closed)

**Node** (`server.js`, `src/config/startupChecks.js`): database configuration (missing `MONGODB_URI` -> exit 1), authentication (production
requires a valid OIDC configuration - unchanged), the timeout budget (Phase 35), and **new**: outside an explicit development/test `NODE_ENV`
(production, staging, unset) the deterministic providers `test` / `test-python` are refused, the `gemini` route requires a valid http(s)
`AI_SERVICE_URL` without embedded credentials. An unrecognised provider and Learning-on are warnings. Messages are fixed and never echo a value.
Node has no model setting: the exact model is a code constant (`providerPolicy.js`), so there is nothing in Node's environment to validate or
to override. Harness note: five older suites started production/unknown-mode servers with the deterministic provider; they now name the real
route explicitly (`LLM_PROVIDER: APPROVED_PROVIDER`) - no bypass flag was added.

**Python** (`app/provider_policy.py` for the model and timeout; the new provider-configuration gate lives in `app/startup_validation.py` so the model-policy module stays free of any credential handling; both are called from `app/main.py`): exact model (no preview/alias/latest/other casing), Gemini timeout 1..20000 ms
(previous phase), and **new**: `LLM_PROVIDER` / `EMBEDDING_PROVIDER` must each be exactly `test` or `gemini` (a typo no longer starts a service
that can only answer 503), a non-blank `GEMINI_API_KEY` when either is Gemini, and `LLM_MAX_OUTPUT_TOKENS` 1..8192 for Gemini. The
deterministic `test` provider needs no key and is not governed by the Gemini gates. Messages never contain the key.

**Matrix** (deterministic, process level): `ai-service/tests/test_startup_matrix.py` (38 cases: correct production config; missing/blank key;
invalid, preview, alias, latest, wrongly-cased model; unsafe and non-integer timeouts; unknown providers; unbounded generation; the test
provider) and Node tests B1-B7 (pure matrix plus real spawned servers: a correct production configuration starts and answers `/api/health`;
a deterministic provider, a missing AI URL, a credentialed URL, no auth, an impossible timeout budget and a missing database are each refused).
Behaviour change to note: a Python service configured for Gemini without a key now refuses to start (it previously started and answered every
request 503). Local development with `LLM_PROVIDER=test` is unaffected.

## 3. Node <-> Python contract

Verified against the AI service's **real** pydantic models and deterministic generator (no Gemini), `validate-phase36...` section C:
request fields and the request Node actually sent in the run validate against Python's `AnalysisRequest` (extra fields forbidden); response fields
are the same 12 on both sides; a response from Python's real generator passes Node's strict validation end to end; provenance is exactly
`{provider, model}` and Node pins both; enumerations (confidence, claim types, urgency, action types, evidence vocabularies) and every shared size
limit are identical; every error code Python can return is mapped by Node to its own stable code and has a failure class; the claim shape is identical.

**Drift found and fixed:** Python answers a request that violates its schema with `VALIDATION_FAILED`; Node had no mapping, so it surfaced as a generic
"invalid response" (class `malformed_response`). It is now mapped explicitly (502, code kept) and classified `invalid_request`.

**Intentional gap, kept:** the contract carries no `model_version` and no token usage. Python's code states that `AnalysisResponse` "has no usage field
and never will" (usage is an evaluation-only channel), and adding a field needs both services and their tests to change in step. Judged acceptable:
Node records `provenance.model` (which Python cross-checks against the version the API reports, accepting only the exact id or a numeric revision),
its own measured latency and the failure class; token spend is visible in the provider's billing. A strict-schema test proves an extra field is rejected.

## 4. Failure and recovery (deterministic stubs; nothing real was broken)

| failure | result |
|---|---|
| MongoDB unavailable | `MongoNotConnectedError` -> 500 "Internal server error" (generic); the model is not called; no partial Intelligence or audit row; the next request after reconnect succeeds |
| database lost after the model call | one call, error surfaces, no partial Intelligence, audit row `decidedAt: persistence`; a later retry stores one analysis (a second paid call is the caller's cost) |
| AI service unreachable | 502 `AI_SERVICE_UNREACHABLE`, exactly one connection attempt, no fallback, no Intelligence, audited `provider_unavailable` |
| provider timeout (AI service reports `PROVIDER_TIMEOUT`) | 504, one call, no retry, no Intelligence, audited `provider_timeout` |
| a provider that never answers | Node gives up at its analysis timeout, 504 `AI_SERVICE_TIMEOUT`, one call |
| retrieval deadline exhausted | 504 within the request deadline, no model call, no Intelligence, audited `decidedAt: retrieval` |
| malformed model response | schema failure / malformed body, one call, no Intelligence, no Decision or Action |
| audit persistence failure | analysis succeeds, failure counted and evented, no false accepted row, no data in the event |

## 5. Concurrency / idempotency

Before: the unique `(workspace, Signal, level)` index kept a single stored analysis, but two simultaneous first requests both missed the
"already stored?" check and **both called the model** (duplicate provider spend). Now `analyzeSignal` is **single-flight per workspace + Signal +
level in the process**: followers wait for the leader and receive its record with `created:false` (or its rejection - no second call, no retry); a
failed leader leaves nothing registered. The key includes workspace and level, so nothing is shared across tenants or authorization levels.
**Limitation, stated:** the map is process-local. Two backend instances can still both call the model for the same Signal; the unique index then
guarantees one stored analysis (tested by two simultaneous persistence calls). No distributed lock was added.

## 6. Deployment-safe data / migration

* **Fresh database:** no migration step. Mongoose builds the indexes on first use: the audit collection gets unique `(workspace, attempt)`; `Decision`
  and `Action` get no new index. Verified on a throwaway database that was dropped afterwards. A governed record without a proposer is impossible.
* **Existing database:** no required field was added to existing documents (`proposedBy` is required only when `governanceVersion` is set).
  Pre-Phase-35 Decisions and Actions are read through the real API (detail, list, Action detail), and remain reviewable; their review records who reviewed.
* **No bypass from legacy:** the governance marker and proposer are written in the same insert as every new V1 record (static check); the API offers no
  way to create a V1 Decision without them or to remove them later.
* **Workspace deletion** removes every tenant-scoped Phase 35 collection (audit rows, governed Decisions/Actions with proposer/reviewer fields,
  analyses, Signals) and nothing of another workspace.
* No destructive migration and no rewrite of historical records was performed or is needed.

## Known limitations

* Audit rows and the failure counter are best-effort and process-local (Phase 35); events are the independent trace during an audit outage.
* Single-flight is process-local (section 5).
* No `model_version` / token usage in Node (section 3).
* Request ids are not stored on audit rows; events carry both ids.
* Database time is bounded only by the deadline margin (Phase 35.1).

## 7. Production-like smoke validation (real Gemini, small)

Run once, after sections 1-6 passed: exact model `gemini-3.1-flash-lite`, **6 provider calls** (3 scenarios x 2 runs), synthetic data only, no
production workspace or database, Learning OFF, no retry, no fallback. Raw prompts/outputs were not kept (the observer logs of these runs were
deleted after the metadata was read); only metadata is recorded here.

| scenario (synthetic case) | calls | provider success | admitted | confidence model -> ceiling -> final | safety / urgency / action | claim types |
|---|---|---|---|---|---|---|
| NORMAL (current fact + approved guidance) | 2 | 2/2 | 2/2 | high -> high -> high (x2) | no policy minimum / prompt / maintenance_dispatch | FACT, FACT, BUSINESS_GUIDANCE, RECOMMENDATION |
| SAFETY (critical gas smell, no guidance) | 2 | 2/2 | 2/2 | medium -> medium -> medium; low -> medium -> low | LIFE_SAFETY_HAZARD / immediate / escalation (x2) | FACT, RECOMMENDATION (+FACT) |
| ADVERSARIAL (override instructions in the untrusted Signal) | 2 | 2/2 at the provider, 1 contract rejection | 1/2 | medium -> medium -> medium (admitted run) | CRITICAL / immediate / maintenance_dispatch | FACT, FACT, RECOMMENDATION |

Every response carried `model_version` = `gemini-3.1-flash-lite` (observed in the harness; Node does not receive it - section 3), finish reason `STOP`,
0 retries, no fallback. Latency (client side) 3.5-17.4 s per call, all inside the 25 s analysis timeout; tokens 4,408-4,877 per call
(prompt 3,858-4,199, output 550-926). The injected text never changed the policy outcome in either adversarial run.

**One adversarial call was rejected, fail closed:** the model's RECOMMENDATION claim carried no source reference, which the contract forbids
(`sourceRefs` needs at least one); the AI service answered 502 `MALFORMED_RESPONSE`, nothing was stored, nothing was retried. It is a model-quality
event of the kind the contract exists to catch, not a guard defect, but it is 1 rejection in 6 calls in this small sample: a user who meets it
must repeat the request by hand. (Earlier evidence: 34C.1 0 of 18, 34D 1 of 18, both rejected for prose/claim reasons.)
