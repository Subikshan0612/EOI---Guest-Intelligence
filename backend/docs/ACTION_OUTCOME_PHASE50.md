# Action -> Outcome (Phase 50): a person records what actually happened

**An Outcome is a human-recorded observed result.** It is not an AI prediction, recommendation, classification or summary; it is not inferred from anything; and recording one executes nothing, calls no model, changes no other record and feeds nothing into Learning.

```
Signal -> Context -> Intelligence -> Decision (a person) -> Action PROPOSAL (approved = ready, NOT executed) -> Outcome (a person reports what happened) -> [Learning: not active]
```

The chain keeps four different things apart: the AI **recommended** (Intelligence), a person **decided** (Decision), the system **recorded what should be done** (Action proposal), and a person **reported what actually happened** (Outcome).

## Audit: what already existed (and was reused, not replaced)

**Outcome V1** (`models/Outcome.js`, `services/outcomeService.js`, `controllers/outcomeController.js`, `routes/outcomeRoutes.js`), built in Phase 30:

* `recordOutcome(actionId, workspaceId, payload)` already derived an Outcome entirely from a stored **approved Action V1**: workspace, intelligence, decision, signal, property and action version are copied from the Action; the payload is the closed shape `{ status, result: { summary, notes } }`; `recordedAt` is server-set. It was **wired to no route** - it was the shape a future "trusted execution boundary" would call, so no Outcome V1 could be created through the API.
* **States/vocabulary:** `success | partial | failed | unknown`. No lifecycle: an Outcome is a single, immutable record (no PATCH; the service refuses to change a V1 record).
* **One Outcome per Action**, enforced by a partial unique index `(workspaceId, actionId, outcomeVersion)` and a pre-check; a second attempt is a **409 conflict** (not an idempotent return): it would be a conflicting claim about an already-observed fact.
* **Eligibility:** only an **approved** Action V1 (a proposed, rejected or legacy Action produces none).
* The legacy generic `POST /api/outcomes` and `PATCH /api/outcomes/:id` need `action:execute`, which no role holds: closed.
* No Outcome operation calls an AI service. Outcome does not trigger Learning: Learning (Phases 31-33) is a separate, read-only aggregation over stored Outcomes, and its use as Intelligence context is behind `KOI_LEARNING_CONTEXT_ENABLED`, which is off.
* `GET /api/outcomes` and `GET /api/outcomes/:id` returned raw documents.

## What Phase 50 added (all additive)

| Change | Why |
|---|---|
| `POST /api/outcomes/record/:actionId` (body `{ status, result: { summary } }`) | The one authenticated way a person records what happened. The Action is named by the route; the workspace and the actor come from the session; decision / intelligence / signal / property come from the stored Action. Nothing about ownership is accepted from the request (a `workspaceId`, `actionId`, `decisionId`, `intelligenceId`, `signalId`, `propertyId`, `outcomeVersion`, `recordedBy`, `recordedAt`, `actionVersion` or `role` in the body is refused, 400). |
| Permission: the **existing** `operations:manage` | The permission that records a Signal (operator, reviewer, admin). No new permission and no new role; `action:execute` is still held by nobody. A viewer gets 403. |
| `recordedBy` (server-set from the authenticated user) and a boolean `recordedByYou` in the view | Who reported it, without exposing a user id. |
| `blocked` status (`OUTCOME_V1_STATUSES`) | "It could not be done (access refused, parts unavailable)" is neither a success nor a failure of the proposed work. It is **not** added to `OUTCOME_STATUSES`, the Phase 31 Learning vocabulary, so Learning code and tests are untouched (a `blocked` Outcome is simply not counted there). |
| A description is required on this route | A status alone says nothing about what was observed (`OUTCOME_DESCRIPTION_REQUIRED`, 400); at most 2000 characters. |
| One view shape (`toOutcomeView`) for V1 records in `GET /outcomes` and `/outcomes/:id` | No actor identity. Legacy records keep their shape. |
| Chat declines "record / log / save / create / mark ... outcome" | Chat only ever records Signals. A plain report ("the guest was moved successfully") may at most become a Signal; it never becomes an Outcome. |
| UI: Outcome section, `OutcomePanel`, `useCaseOutcome`, `outcomeMapping`; Outcome live in the strip and per-case progress | See below. |

## State and data model

`Outcome` (V1): `status` (`success | partial | failed | blocked | unknown`), `result.summary` (the person's own words), `recordedBy` (authenticated user, never exposed), `recordedAt` (server), the chain `actionId -> decisionId -> intelligenceId -> signalId` (+ `propertyId`, `actionVersion`), `workspaceId`. There is no state machine: an Outcome is recorded once.

## Immutability and history

* The Intelligence, the Decision and the Action are never touched by recording an Outcome (byte-identical in the tests). In particular the Action stays `approved` ("ready") with its one transition: **recording an Outcome does not mark an Action executed** - EOI never executed it; the Outcome is a person's report.
* An Outcome is **append-only and immutable**: no edit and no delete route exists, and the service refuses to change a V1 record. There is **no correction route in V1** - a wrong report is a documented limit, never a silent rewrite. (A later correction mechanism would add a new, linked record rather than overwrite this one.)
* One Outcome per Action. Duplicate and concurrent submissions: exactly one is stored; the rest are 409 and the original is unchanged.

## Safety

An Outcome never changes the safety picture: "guest refused entry" recorded against a life-safety Action leaves the Intelligence's safety state, the Decision and the Action byte-identical, and no safety logic reads the Outcome text. Nothing here parses prose for safety and no new safety policy was added.

## UI (`/assistant`)

Under each case with an approved Decision: **OUTCOME**. With no approved Action it says an outcome can be recorded once the action proposal is approved; for a rejected Action there is nothing to record. For an approved Action: *"Record what actually happened, in your own words"* with *Record outcome* -> a result (Success / Partial / Failed / Blocked / Unknown) and a required description -> *Review outcome* -> an explicit confirmation ("saved as your own report, not edited afterwards. Nothing is sent or carried out") -> *Confirm outcome*. A recorded Outcome shows the result, the person's words, "Recorded by you / by a colleague" and "Reported by a person. EOI did not observe or check this, and recording it changed nothing else." The strip: Outcome becomes available; Learning stays *Next* and inert; per case, Outcome is later -> next (approved Action) -> done. Loading is a GET (no polling, no retry, no model call); failures are fixed sentences.

## Honest limits

* There is no way to correct a recorded Outcome in V1.
* One Outcome per Action; a second observation (for example a later follow-up) cannot be added yet.
* EOI does not verify what a person reports.
* A role that may record but not read the list (`GET /outcomes` needs `decision:review`) sees no recorded Outcome after reload; a second attempt is refused (409), never duplicated.
* An admin-generated (restricted-level) analysis is invisible to staff-level roles, as before, so an operator gets the same 404 as for a missing Action.
* Learning is not active: nothing here creates Learning records, builds Learning context or feeds Outcome text anywhere. (The read-only Phase 31 report can now see real Outcomes, because they now exist; it is on-demand and does not feed the AI.)
