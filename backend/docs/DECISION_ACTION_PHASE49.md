# Decision -> Action (Phase 49): an approved Decision may produce a governed, INERT Action proposal

Scope: the step after a person has approved a Decision. **Nothing is carried out.** There is no execution, no Outcome and no Learning here, and no model call: Action operations are database and governance operations only.

```
Signal -> Context -> Intelligence -> Decision (approved by a person) -> Action PROPOSAL -> (a person confirms it) -> [later phases: execution? Outcome -> Learning]
```

## Audit: what already existed (and was reused, not replaced)

**Action V1** (`models/Action.js`, `services/actionService.js`, `controllers/actionController.js`, `routes/actionRoutes.js`, permissions in `auth/roles.js`), built in Phase 29 and hardened in Phase 35:

* **An Action is a proposal, not an operation.** `POST /api/actions/propose/:decisionId` derives it entirely server-side from ONE stored, APPROVED Decision V1. The closed type list (`maintenance_dispatch`, `guest_communication`, `escalation`, `inspection`, `other`) is a label for a person to read: the contract has no field for a URL, command, tool, message body or any executable payload.
* **State machine:** `proposed -> approved | rejected`, both terminal (the legacy `pending / in_progress / completed / cancelled / failed` states exist only for pre-V1 records, which V1 never writes). `approved` means "ready", **not executed**.
* **Nothing can execute one.** The only write endpoints that could (`POST /actions`, `PATCH /actions/:id`) require `action:execute`, which no role holds, and refuse any V1 record. `action:execute` is in the vocabulary only.
* **Derivation:** workspace, Intelligence, Signal, property, description (a snapshot of the approved recommendation), risk and proposer are server-set. The client's only input was `actionType` (and an optional `target.note`); `riskLevel` was never accepted from it.
* **Idempotency:** a partial unique index `(workspaceId, decisionId, actionVersion)` makes proposing idempotent and race-safe; a rejected Action keeps its slot.
* **Review:** status-guarded atomic update (one winner), idempotent repeat, opposite transition refused (409). Permissions: `action:propose` (operator, reviewer, admin), `action:review` (reviewer, admin). A normal signed-up user is the admin of their own workspace and holds both.
* **No side effects:** creating or reviewing an Action writes only the Action. No Gemini / AI-service call anywhere in the path (it is deterministic).
* **Gap found by the audit:** the client chose the Action type and nothing tied it to the Intelligence's validated safety result - a life-safety recommendation could be proposed as an "inspection". And `GET /actions` returned raw documents (including the proposer's and reviewer's user ids).

## What Phase 49 added (all additive)

| Change | Why |
|---|---|
| Action type / risk / urgency are **derived from the parent Intelligence's structured safety result** | `CRITICAL` / `LIFE_SAFETY_HAZARD`: the Action type IS the validated `recommendedActionType`; a request naming another is refused (409 `ACTION_TYPE_CONFLICTS_WITH_SAFETY`). If the analysis recorded none (the deterministic test provider), a hazard defaults to `escalation` and may only be `escalation` or `maintenance_dispatch`. Risk is only ever RAISED (hazard -> critical, critical -> at least high). `urgency` (new, optional) is copied from the stored safety result (`immediate` for CRITICAL / HAZARD). Prose is never read. |
| `actionType` is optional | The page names only the Decision. With no type requested the server uses the recorded one (else `other`). An unknown type is still refused (422). |
| Rejecting a safety-constrained Action needs a reason (400 `ACTION_REASON_REQUIRED`) | A safety requirement is not set aside silently. |
| One Action view shape (`toActionView`), also for `GET /actions` and `GET /actions/:id` | No actor identity: the caller's relation is two booleans (`review.you`), exactly like the Decision view. Legacy records keep their shape. |
| Single-user review policy (below) | A one-person workspace could never confirm an Action otherwise. |
| Chat declines "create / run / confirm an action" | Declined even if the message also names a room and an event. Chat only ever records Signals. |
| UI: Action section, `ActionPanel`, `useCaseAction`, `actionMapping`; Action live in the strip and per-case progress | See below. |

## Review policy for Actions (the one governance change)

Phase 35 required an Action's reviewer to be a different user than its proposer, mirroring Decision V1. **Why it existed:** four-eyes on a proposal - a business-process control, not an authentication, tenant or authorization control (the reviewer is the authenticated actor either way, and the permission, workspace membership, state machine and idempotency are enforced regardless). **Why it is adapted:** EOI is currently a single-user product, and Phase 48.1 already relaxed the same rule for Decisions.

`GOVERNANCE_POLICY.Action.selfReviewAllowed` (`services/governance.js`) is therefore *computed*:

* it is `true` **only while no role holds `action:execute`** - i.e. while an Action can only be a record. The moment any role is granted `action:execute`, the policy returns to "a different person must review" **by itself**, with no code change;
* `KOI_ACTION_REVIEW_REQUIRES_SECOND_PERSON=true` (server configuration only, never a request field) restores the second-person rule today. It can only make the rule stricter.

The proposer and the reviewer are both still recorded (`proposedBy`, `review.reviewedBy`) and are the same user when one person did both.

## The Decision -> Action relationship

`Action.decisionId` -> `Decision` -> `Decision.intelligenceId` -> `Intelligence` -> `Intelligence.signalIds`; the Action also stores `intelligenceId`, `signalId` and `propertyId`, all copied by the server from the stored Decision. The client cannot name any of them (an `intelligenceId`, `workspaceId`, `decisionId`, `signalId`, `status`, `riskLevel`, `proposedBy`, `description` or `role` in the body is refused, 400). Only an approved Decision V1 produces an Action (rejected and proposed ones are 409). The Intelligence and the Decision are never modified by an Action step.

## UI (`/assistant`)

Under each case, after Decision: **ACTION**. With no approved Decision it says a proposal becomes available once the decision is approved; for a rejected Decision it says no action proposal is made (no button). With an approved Decision: *Create action proposal* (no input). A proposal shows its plain-text type, risk and urgency and the approved recommendation, labelled **Ready for review** and **Not executed**; the person may *Approve action proposal* (explicit confirmation: "nothing is carried out") or *Reject* (a reason, required under a safety requirement). A reviewed proposal reads **Action approved** / **Action proposal rejected**, always **Not executed**. The strip: Signal, Context, Intelligence, Decision, Action done / next / in review; Outcome and Learning stay *Later*. Failures are fixed sentences (no code, id, status or server text). Loading is a GET; there is no polling and no regeneration; the buttons also have a one-request-at-a-time guard, but the server's unique index is what prevents a duplicate.

## Honest limits

* Approving an Action means "ready for a future phase", **not executed**: there is no execution mechanism and none is added here.
* The Action's description is the approved recommendation's text; a person cannot edit it (an edit would be a new decision).
* A role that may propose but not review cannot list Actions (`GET /actions` needs `decision:review`); the page treats that as "no proposal visible" and a repeated proposal is idempotent.
* An admin-generated (restricted-level) analysis is invisible to staff-level roles, as before.
