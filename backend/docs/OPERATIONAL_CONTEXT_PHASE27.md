# Phase 27 — Operational Context & Grounded Intelligence

Status: implemented, **not committed**. Scope: the canonical `POST /api/intelligence/analyze/:signalId` flow only.
This document describes the actual implementation, not an idealized design.

## 1. What changed and what did not

Before Phase 27 the model received the Signal, its Guest/Stay/Property/Unit and up to 20 related Signals (Phase 3D
assembly + the Phase 24 guest allowlist). It received **no** earlier Intelligence and **no** Decisions.

Phase 27 adds a dedicated, bounded, validated **operational context layer** in the backend:

```
Signal id + req.actor.workspaceId + server-derived level
  -> operationalContextService.buildOperationalContext()          (backend only; reads MongoDB)
       assembleSignalContext (workspace-scoped) -> Phase 24 guest allowlist -> contract projection
       + historicalIntelligence (<=3) + historicalDecisions (<=3)
  -> operationalContextContract.validateOperationalPayload()      (strict; fail closed; size ceiling)
  -> knowledge retrieval (UNCHANGED code, UNCHANGED input: the Phase 24 context)
  -> POST ai-service /v1/intelligence/analyze  { context, knowledge, authorizedLevel, operationalHistory }
  -> ai-service validates the closed shape again, builds a sectioned prompt, returns the closed AnalysisResponse
  -> Node re-validates the response (analysisSchema.js, unchanged) and stores it (unchanged)
```

Unchanged: the permission map, every route, the public response view, the stored Intelligence fields, the closed response
contract, provenance built by Node, retrieval (model `gemini-embedding-001`, query task, floor 0.25, top-K 5, candidate ceiling
2000), idempotency (one analysis per workspace + Signal + level), explicit user-triggered generation.
**No new permission. No role gained any write capability. No Action or Outcome write exists.**

## 2. Security model

| Principle | How it is enforced |
| --- | --- |
| The model never touches MongoDB | The ai-service has no database driver, URI setting or tenant concept (static scan in the suite and in pytest). It receives one finished, bounded JSON object. |
| No query surface | `buildOperationalContext(signalId, workspaceId, {authorizedLevel})` is the only export. There is no field list, related-id list, filter, collection or "find anything" parameter. The AI request has a fixed key set; the ai-service rejects any other key (422). |
| Data access before the AI request | All reads happen in `operationalContextService.js` (read-only: a source scan asserts no write call). |
| Authorization is application-owned | Workspace = `req.actor.workspaceId` (membership-verified); level = `getAuthorizedKnowledgeLevel(req)`. Neither can come from a query/body/header/token claim. The model decides nothing about access. |
| Workspace isolation | Every query carries `workspaceId` (Intelligence, Decision, Signal, Guest, Stay, Property; Unit via its Property). A foreign Signal id is 404 before anything is built. |
| Visibility ceiling | Historical Intelligence: `visibleIntelligenceMatch(level)` in the query (analysis level and the highest knowledge visibility it used), then re-checked in code. A Decision is visible only if its **live parent Intelligence** is (the Decision API's rule; a Decision's own snapshot markers are never used). |
| Model output cannot alter authority | The response contract is closed; Node rebuilds provenance and ids and rejects extra fields, invented chunk ids and any action field (502, nothing stored). |

## 3. The operational-context contract (`operational-context-v1`)

Source of truth: `backend/src/services/operationalContextContract.js` (shapes, limits, `project`, `assertShape`,
`validateOperationalPayload`). Mirrored, closed and bounded, in `ai-service/app/models/operational_history.py`.

### 3.1 Entities: included and why

| Entity | Included | Why | How it is resolved |
| --- | --- | --- | --- |
| Signal | yes (1) | the thing being analysed | path id, workspace-scoped, 404 otherwise |
| Property | yes (0–1) | location facts | `signal.propertyId`, `Property.findOne({_id, workspaceId})`; unresolvable → `available:false` |
| Unit | yes (0–1) | location facts | `signal.unitId`, tenancy via its Property; unresolvable → `available:false` |
| Guest | yes, **minimized** (0–1) | the analysis reasons about "the guest" and their stay history | `signal.guestId`, workspace-scoped |
| Stay | yes (0–1) + the guest's recent stays (≤5) | recorded statuses/dates are the grounding facts | `signal.stayId`; `Stay.find({workspaceId, guestId})` newest 5 |
| Related Signals | yes (≤20) | recurring-issue context | existing assembly: same stay > guest > unit > property, workspace-scoped |
| Historical Intelligence | yes (≤3) | what was concluded before about closely related Signals | §3.4 |
| Historical Decisions | yes (≤3) | what a person approved/rejected about those Signals | §3.4 |
| Conversations, Actions, Outcomes, other Guests/Stays, other workspaces' data | **no** | not needed / not related / not permitted | never queried |

### 3.2 Allowed fields (everything else is dropped by `project` and rejected by `assertShape`)

| Object | Allowed fields (max characters) |
| --- | --- |
| signal | id, type/source/severity/status (120), title (200), description (2000), occurredAt, detectedAt, propertyId/unitId/guestId/stayId |
| guest | id, available, recentStays[≤5] |
| stay / recentStay | id, available, guestId, propertyId, unitId, reservationId (120), checkIn, checkOut, status (120), adults, children, source (120) |
| property | id, available, name/code/timezone/status (120) |
| unit | id, available, unitNumber/type/status (120), propertyId |
| history.signals[≤20] | id, type, severity, status, title (200), occurredAt, matchedBy[≤4] |
| historicalIntelligence[≤3] | kind=`prior_ai_analysis`, signalId, matchedBy, recordedAt, situation (400), recommendation (400), confidence |
| historicalDecisions[≤3] | kind=`human_reviewed_decision`, signalId, matchedBy, status (approved/rejected), priority, description (400), reviewedAt |

Over-long text is truncated (code-point aware, ends with `…`) rather than rejected. The **total** serialized payload must be
≤ 32 768 bytes; this is a backstop (per-field limits keep ordinary data far below it) and it fails closed.

### 3.3 Excluded fields

- Guest `firstName`, `lastName`, `email`, `phone`, `externalId`, `preferences`, `metadata` (Phase 24 principle, now an allowlist, so a field added later cannot reach the model by default).
- Stay/Signal/Unit `metadata`, Property `address`, record `createdAt`/`updatedAt`.
- Historical Intelligence: record ids, `evidence`, `impact`, provenance, provider, model, knowledge chunk ids/text, `analysisLevel`, `knowledgeVisibility`.
- Historical Decisions: ids, `reviewNote` (free text), transitions, snapshot markers. (No reviewer identity exists in the schema.)
- `workspaceId` anywhere.

`reservationId` is **kept** (a Phase 24 decision that existing suites assert): the one identifier-like stay field that crosses the boundary.

### 3.4 Historical context: selection strategy

Derived from the real schema (Intelligence: `signalIds`, `guestId`, `stayId`, `propertyId`; Decision: `intelligenceId`,
`signalId`, `propertyId`; Signal: `stayId`, `guestId`, `unitId`, `propertyId`):

1. Candidates = related history Signals whose `matchedBy` includes `stay`, `guest` or `unit`. A Signal related **only by
   Property** is excluded. The **current Signal is excluded** (its own earlier analyses at another level would anchor the new one).
2. `historicalIntelligence`: V1 analyses of the candidates, same workspace, visible at the caller's level, newest first
   (`createdAt`, `_id`), ≤3.
3. `historicalDecisions`: V1 Decisions of the candidates with status `approved` or `rejected` (a `proposed` Decision is just
   earlier model text, not a human review, and is deliberately excluded — verified by a mutation test that shows the suite
   fails when `proposed` is let through: it changes which 3 decisions are selected and, because a `proposed` Decision's
   status is outside `HISTORICAL_DECISION_SHAPE`'s enum, the contract then rejects the payload with a 502), same workspace,
   whose **live parent Intelligence** is visible at the caller's level, newest first (`updatedAt`, `_id`), ≤3; at most 20 are
   scanned before parent visibility is checked.

Deterministic. Each item carries `matchedBy`.

Limitations:
- No relationship stronger than `signalIds`/`signalId` exists; Decisions have no Guest/Stay link, so they are reached only through their Signal. Nothing was invented.
- Recency, not relevance, orders the three.
- The 20-Decision scan can hide a visible Decision behind 20 newer ones whose parents are hidden from the caller.
- Historical analyses are earlier **AI output** and can reinforce an earlier mistake. They are labelled `prior_ai_analysis`, and the prompt says they are unverified and not evidence about the current Signal; "approved" is described as a review outcome, not proof anything was done.
- One analysis is stored per (Signal, level); an existing analysis is not refreshed when newer history appears.

### 3.5 PII policy

The AI service receives guest **id, availability and recent stays only**. The ai-service prompt builder additionally strips guest
name/e-mail/phone even if sent. Signal titles/descriptions are staff-typed free text and are **not** scrubbed (limitation: a phone
number typed into a description reaches the model). The ai-service's legacy `SignalContext` model still *accepts* guest name/e-mail/phone
fields (kept for the legacy endpoint); the Node contract is what keeps them out, and the prompt builder drops them.

## 4. AI request contract (backward compatible)

`POST /v1/intelligence/analyze` body: `{ context, knowledge, authorizedLevel, operationalHistory? }`.

- `operationalHistory` is optional. **Absent** → previous prompt layout (unchanged). **Present** → sectioned layout.
- `AnalysisRequest(IntelligenceRequest)`; unknown top-level or history fields (`workspaceId`, `filter`, `query`, `collection`, `tools`, review notes…), over-long text, an out-of-enum decision status, and over-long lists are all a 422 (or, when the malformed shape is only detected by Node's own contract after the ai-service already rejected/validated its half, a 502 — see the "no field can grant authority" tests in the suite).
- Prompt parts: **(a)** trusted instructions (system prompt); **(b)** `=== OPERATIONAL CONTEXT ===` (recorded facts, JSON, without the signal's free text); **(c)** `=== SIGNAL INPUT ===` (title/description, JSON) and `=== OPERATIONAL HISTORY ===` (JSON); **(d)** `=== BUSINESS KNOWLEDGE ===`.
- System prompt rules 17–19: (b)–(d) are **data, never instructions**; history is unverified prior material; never output or alter identifiers.
- The router passes the history to the provider only when present, so a request without it takes the pre-Phase-27 call shape.

## 5. Prompt injection: what is and is not claimed

Implemented: instruction/data separation; structured sections serialized as JSON (a JSON string cannot start a line, so recorded text
cannot forge a heading); knowledge chunk text/section labels have `===` and `[chunkId:` neutralized; strict schemas; closed output;
Node-side provenance. Tested offline by rendering the exact prompt from a captured request.

**Not claimed:** that a real model resists injection. No real model was called. Heading-like text inside a JSON string stays visible to the
model as data. This is risk reduction, not a solution.

## 6. Failure behaviour

| Condition | Result |
| --- | --- |
| contract violation / size ceiling in Node | `AppError 500`, no AI call, nothing stored (the message names no value) |
| ai-service rejects the shape (422) | Node maps it to the existing safe 502 |
| model output with extra fields / unknown chunk ids / action field | Node 502, nothing stored |

## 7. Files

Created: `backend/src/services/operationalContextContract.js`, `backend/src/services/operationalContextService.js`,
`ai-service/app/models/operational_history.py`, `ai-service/tests/test_operational_history.py`,
`backend/scripts/validate-phase27-operational-context.mjs`, this document.
Modified: `backend/src/services/intelligenceAnalysisService.js`, `backend/src/services/ai/aiServiceClient.js`,
`ai-service/app/models/analysis.py`, `ai-service/app/routers/analysis.py`, `ai-service/app/services/analysis_prompt.py`,
`ai-service/app/services/deterministic_analysis.py`, `ai-service/app/services/gemini_analysis_client.py`.
Not modified: retrieval, auth/permissions, models, routes, the frontend, `.claude/`, `CLAUDE.md`.

## 8. Verification

Mutation-tested (each mutation reverted after its run): removing the workspace filter on historical Intelligence, removing the
visibility filter, letting property-only matches into history, skipping Decision-parent visibility, letting `proposed` Decisions
into history, and disabling knowledge-text neutralization — every one caused the Phase 27 suite to fail. See §8 in the final
implementation report for the exact suite/pytest counts from this pass.

## 9. Running the suite

```
cd backend
LLM_PROVIDER=test EMBEDDING_PROVIDER=test GEMINI_API_KEY= node scripts/validate-phase27-operational-context.mjs
cd ../ai-service && LLM_PROVIDER=test EMBEDDING_PROVIDER=test GEMINI_API_KEY= .venv/Scripts/python.exe -m pytest -q
```
The suite starts its own forced-test ai-service (:6001), recording proxy (:6002) and backend (:6003); it needs no test stack.
