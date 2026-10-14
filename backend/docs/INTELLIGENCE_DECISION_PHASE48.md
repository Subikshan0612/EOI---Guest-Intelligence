# Intelligence -> Decision (Phase 48): the AI recommends, a person decides, the system records it

Scope: the human governance step between a stored Intelligence and anything that might later happen because of it. **Nothing is carried out.** There is no Action,
Outcome or Learning here, and no model call: Decision operations are database and governance operations only.

```
Signal -> Context -> Intelligence (immutable evidence of what the AI recommended) -> Decision (the human governance record) -> [later phases: Action -> Outcome -> Learning]
```

## What already existed (and was reused, not replaced)

**Decision V1** (`models/Decision.js`, `services/decisionService.js`, `services/governance.js`, `routes/decisionRoutes.js`, permissions in `auth/roles.js`):

* A Decision is a **governed proposal** derived entirely server-side from ONE stored Intelligence V1 (`POST /api/decisions/propose/:intelligenceId`, no body). It copies the AI recommendation as a snapshot (`description`), the confidence, a priority from the Signal's severity, and the workspace / signal / intelligence references.
* **State machine (unchanged):** `proposed -> approved | rejected`, both terminal. (`completed` exists only for pre-V1 records; V1 never writes it.) At most one V1 Decision per (workspace, Intelligence), enforced by a partial unique index, so a rejected Decision keeps its slot.
* **Governance (Phase 35):** the proposer is the authenticated actor and is stored by the server (`proposedBy`); the reviewer is the authenticated actor (`review.reviewedBy`). Phase 35 also required the reviewer to be a *different* user (403 `SEPARATION_OF_DUTIES`). **Phase 48.1 relaxes that for a Decision only** (see "Phase 48.1" below): EOI is currently a single-user product, so the person who asked may confirm their own Decision; both identities are still recorded. An Action proposal keeps the strict rule.
* **RBAC:** `decision:propose` = operator, reviewer, admin. `decision:review` = reviewer, admin. Viewers hold neither (they may read, within their knowledge ceiling). The role always comes from the verified membership; no body, query or header field is read.
* Visibility follows the **live parent Intelligence** (a Decision is only as visible as its Intelligence); another workspace's Decision is the same 404 as a missing one.

## What Phase 48 added (all additive)

| Change | Why |
|---|---|
| `review.alternative` (optional string, only on a **rejection**, only by a reviewer) | The human must be able to disagree and record their own decision **beside** the AI recommendation: `description` stays the AI snapshot, `review.alternative` is the human decision, and the Intelligence is never modified. No new state was invented: it is a recorded field of a rejection. It is a record, not an instruction - nothing reads it to act. |
| Safety rules on **rejection** from the parent Intelligence's **structured** safety state | `CRITICAL` or `LIFE_SAFETY_HAZARD`: a reason is required (400 `DECISION_REASON_REQUIRED`). `LIFE_SAFETY_HAZARD`: what will be done instead is also required (400 `DECISION_ALTERNATIVE_REQUIRED`). A hazard cannot simply be set aside. Approval is never blocked by these rules; a normal-state rejection needs nothing extra. Prose is never read. |
| Priority honours `LIFE_SAFETY_HAZARD` | A life-safety Intelligence is filed `critical` whatever severity the Signal was recorded with. It can only raise the priority. |
| `review.you = { proposed, reviewed }` in the view | The caller's **relation** to the record (two booleans; no id, name or email) so the UI never offers a submitter a review the server will refuse. Nested under `review` to keep the public view's key set and the "no actor identity" guards intact. |
| Chat cannot decide | The conversational intake declines "approve / reject / authorise this/that/the decision/recommendation..." and "for workspace X" with one fixed sentence (nothing created or changed). Decisions are made on the case, never in chat. |

## Review request bodies

`POST /api/decisions/:id/approve` accepts only `{ note? }`. `POST /api/decisions/:id/reject` accepts `{ note?, alternative? }`. Anything else (`reviewerId`, `workspaceId`, `status`, `intelligenceId`, `role`, `userId`, `description`, ...) is refused (400) and nothing changes.

## Duplicates and races

Proposing is idempotent (unique index): ten simultaneous submissions create one Decision (one 201, the rest 200). Reviewing uses a status-guarded atomic update: simultaneous approvals leave one transition; an approve/reject race has one winner and the loser sees 200 (same outcome) or 409.

## UI (`/assistant`)

Under each case: SIGNAL, CONTEXT, INTELLIGENCE, then **DECISION**, with a per-case progress strip (Done / In review / Next / Later, in text). The Decision section shows the AI recommendation "under review (unchanged)" and the next possible step:

* nothing yet: **Submit for review** (roles that may propose);
* submitted **by you**: "waiting for someone else with review permission - you can't review your own submission" (no buttons);
* submitted by someone else, you may review: **Approve recommendation** (with an explicit confirmation: "no action is taken") or **Reject / decide differently** (reason; what will be done instead - both required for a life-safety recommendation);
* reviewed: **Human decision** (Approved / Rejected, reason, "Decided instead", who in terms of you / a colleague) beside the unchanged AI recommendation, and a plain statement that nothing was carried out.

The role shown by the session only chooses which buttons to show; every request is authorized by the server. Failures are fixed sentences (no code, id or server text). Action, Outcome and Learning are named and inert.

## Honest limits

* **Approve was two people in Phase 48; since Phase 48.1 it is one** (see below). The two-person rule still exists, as a one-line policy (`GOVERNANCE_POLICY.Decision.selfReviewAllowed` in `services/governance.js`), for when multi-user governance returns.
* There is no "modified approval" state: a human who wants something different **rejects and records their alternative**.
* The human alternative is free text; EOI does not validate it semantically or act on it.
* A viewer's guest-level ceiling hides decisions whose Intelligence was generated at a higher knowledge level.
* Reviewer identity is shown to the UI only as "you" / "a colleague"; names are not exposed.

## Phase 48.1 - the person who asked may decide (single-user product)

EOI is a normal authenticated-user application today; requiring a second reviewer account made a Decision impossible to confirm in a one-person workspace. So:

* `services/governance.js` now holds the separation rule as a **policy per record kind**: `GOVERNANCE_POLICY = { Decision: { selfReviewAllowed: true }, Action: { selfReviewAllowed: false } }`. Flipping `Decision.selfReviewAllowed` back to `false` restores multi-user governance with no other change (model, data, routes and services are untouched).
* **Unchanged:** authentication; workspace membership and tenant isolation (a member of another workspace gets the same 404); the permission check (`decision:propose` / `decision:review`, from the verified membership - a viewer still cannot propose or review, an operator cannot review); the state machine (`proposed -> approved | rejected`, terminal); the structured safety rules on rejection; Intelligence immutability; idempotent proposing and single-winner review; the Decision records `proposedBy` and `review.reviewedBy` separately (they are the same user when one person did both); approving executes nothing.
* **UI:** a person who may review sees *Approve recommendation* / *Reject / decide differently* directly; confirming records the Decision first (the same idempotent propose call) and then reviews it - two ordinary server calls, never a shortcut. A member who may only propose still sees *Submit for review*. The "you can't review your own submission" wording is gone.
* **Action proposals** still require a different reviewer (nothing in this phase touches them); that decision belongs to the phase that introduces Action proposals from the UI.
