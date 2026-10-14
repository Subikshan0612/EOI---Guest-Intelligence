# Phase 30 — Outcome Recording & Outcome Integrity

Status: implemented, **not committed**. Scope: the Outcome domain and its integrity rules only.
**No execution engine exists after this phase.** Nothing here makes an Action executable.

## 1. What an Outcome means

> An Outcome represents the observed result of an Action **after an execution attempt**.

It is **not**: an Action proposal, an Action approval, an Intelligence recommendation, a Decision, a model
prediction, a hypothetical/expected result, or an LLM-generated claim. An approved Action with no execution
result has `Action.status === "approved"` and **no Outcome** — nothing in this codebase changes that
automatically, and this phase adds no code path that could.

## 2. Why Outcome creation stays unreachable

There is no execution engine and no trusted execution-service identity in EOI's auth model (which is entirely
human/workspace-membership based: viewer/operator/reviewer/admin). Given that, the smallest secure design is
the one Phase 17 already chose for Action: **Outcome creation stays reachable by nobody.**

- `POST /api/outcomes` and `PATCH /api/outcomes/:id` are **unchanged**: still gated by `action:execute`, which
  no role holds (Phase 17). No permission was added or loosened.
- `outcome:record` **was not created.** Phase 17's assertion that it does not exist remains true and
  unmodified. Creating it now, with nothing trustworthy to attach it to, would be exactly the "permission for
  convenience" the phase explicitly warns against.
- The one new write path, `recordOutcome()` (`backend/src/services/outcomeService.js`), is **wired to no
  route and no controller** — grep the repository: nothing under `src/routes` or `src/controllers` imports it.
  It exists only so the invariants below are real, tested code today rather than a promise for later, and so
  a future phase has an exact, already-hardened contract to wire up rather than inventing one under pressure.

This is not a stub pretending to be the execution service — it is an ordinary internal service function, the
same shape as any other in this codebase, that simply has no caller yet.

## 3. Action → Outcome invariant

`recordOutcome(actionId, workspaceId, payload)`:

```
actionId -> Action exists, workspace-scoped (fail closed, no existence oracle)
         -> Action.actionVersion === "action-v1"           (422 otherwise - V1 only)
         -> Action.status === "approved"                   (409 otherwise - proposed/rejected/legacy refused)
         -> payload is exactly {status, result?:{summary?, notes?}}
         -> no existing Outcome V1 for this Action          (409 otherwise - see "duplicates" below)
         -> Outcome created, workspace/intelligenceId/decisionId/signalId/propertyId inherited from the Action
```

The same rule is additionally enforced, defense-in-depth, inside the **legacy** `createOutcome`/`updateOutcome`
functions for any Action that happens to be a V1 Action (`assertActionUsableForOutcome`): even though those
functions are also unreachable over HTTP today, they no longer silently accept an Outcome for an unapproved or
rejected Action V1. Legacy (pre-V1) Action behavior is completely unchanged (Phase 7C's original, intentional
"no status check" rule still applies to legacy Actions only).

## 4. Outcome V1 contract

| Field | Source | Notes |
| --- | --- | --- |
| `status` | caller (trusted boundary) | one of `success \| failure("failed") \| partial \| unknown` — the model's existing enum, unchanged |
| `result.summary`, `result.notes` | caller, optional | plain strings, ≤2000 characters each |
| `workspaceId`, `intelligenceId`, `decisionId`, `signalId`, `propertyId` | **inherited from the Action**, never the caller | |
| `outcomeVersion`, `actionVersion` | server | `"outcome-v1"`, snapshot of the Action's own version |
| `recordedAt` | server (`new Date()`) | never accepted from a caller |
| `createdAt`/`updatedAt` | server (Mongoose timestamps) | |

Nothing else can reach a stored Outcome: no actor id, execution identity, tool/function name, URL, HTTP
method, shell command, database query, credential, or arbitrary metadata field exists anywhere in the V1
contract (`parseRecordPayload` is a closed allowlist — an unrecognized key is a 400, not a silently-dropped
field).

### Status semantics

- **success** — execution completed with the intended result.
- **failure** (stored as `"failed"`, the existing enum value) — execution occurred but did not achieve the
  intended result.
- **partial** — execution occurred and produced a bounded partial result.
- **unknown** — execution occurred or was reported, but the final result cannot be determined reliably. This
  is **not** a bypass for "no execution happened": `recordOutcome` still requires a real, approved Action and
  a real call from the (future) trusted boundary — `unknown` only describes the *result*, never substitutes
  for the *attempt*.

## 5. One Outcome per Action, and why duplicates fail closed

Phase 7D's Learning report and the existing domain give no reason to model multiple execution attempts per
Action in this phase, so Outcome V1 is **one Outcome per Action** (a partial unique index on
`{workspaceId, actionId, outcomeVersion}`), not an event-sourced history.

Unlike Decision/Action V1 (where re-proposing returns the existing record), a **second** `recordOutcome` call
for the same Action is **always a conflict (409)**, whether or not its content matches the first — Outcome
represents an already-observed fact, and a second claim about it (even an identical one) is not a safe no-op
to silently accept. There is no "success → overwrite with failure" path, and none is added in this phase; a
genuine correction mechanism (if ever needed) is explicitly out of scope here, consistent with "do not build a
correction/audit subsystem unless necessary for this phase."

## 6. Immutability

An Outcome V1 cannot be changed once recorded. `updateOutcome` refuses (409) any write to a record whose
`outcomeVersion === "outcome-v1"`, independent of the `action:execute` permission gate that already blocks it.
Legacy Outcomes keep their existing free-form PATCH behavior, unchanged.

## 7. Actor / execution identity

EOI's current actors (viewer/operator/reviewer/admin, resolved from `req.actor`) are **proposal and review**
identities — they are not, and must never be treated as, an **execution** identity. `recordOutcome` takes no
actor parameter at all: `req.body.actorId` (or any other client-asserted identity) is never read for
authorization or attribution anywhere in this phase. A future execution service's own trusted identity
(however it authenticates — not designed here) is what a future route would need to supply, and that identity
would need its own, separate authentication, independent of the human role system above.

## 8. Timestamps

`recordedAt` is always `new Date()` set inside `recordOutcome` — never accepted from a payload. Because it is
set at call time, it is trivially always at or after `Action.createdAt` (the Action must already exist to be
loaded); no additional chronology check was needed beyond refusing a client-supplied value in the first place.

## 9. Payload bounds

The entire payload shape is a two-key allowlist (`status`, `result`) with `result` itself a two-key allowlist
(`summary`, `notes`), each a bounded plain string. There is no nested object, array, or `Mixed` field in the V1
path, so there is no depth/key-count/array-size surface to bound separately, and no `$`-prefixed or dotted key
can ever reach a Mongo write through it — the allowlist rejects any key it doesn't name, including both of
those shapes, before any value is even inspected.

## 10. LLM isolation

No code in `ai-service/` or `backend/src/services/ai/` reads, writes, or references `Outcome`, `actionId`, or
`recordOutcome` anywhere (grepped). The AI service's response contract (`AnalysisResponse`, Phase 24/28) has no
`outcome` field and would reject one as an unexpected key even if a provider emitted it. Historical Intelligence
(Phase 27) and Decision recommendations (Phase 29) stay exactly what they already were — recorded text — and
cannot become an Outcome through any code path.

## 11. No automatic Outcome creation

Proposing, approving, or rejecting an Action (Phase 29); generating Intelligence (Phase 24/27/28); and
creating/approving/rejecting a Decision (Phase 29) are not changed by this phase and do not call
`outcomeService.js` anywhere. Verified by both a static repo scan and explicit regression tests (letters
AG–AJ in the Phase 30 suite).

## 12. Future execution boundary — the exact contract

Documented, **not implemented**:

```
Future execution service (its own trusted identity - not designed here)
  -> authenticate that trusted identity (NOT a workspace-member role)
  -> load the approved Action it is about to execute
  -> re-verify the Action is still "approved" (not since rejected/expired/cancelled)
  -> execute the exact approved operation (outside this codebase's current scope entirely)
  -> call outcomeService.recordOutcome(actionId, workspaceId, { status, result })
       - recordOutcome re-derives workspace scope, Action V1-ness and approval state itself;
         it does not trust the caller's own re-verification
  -> an immutable Outcome V1 is created, or the call fails closed (never partially)
```

Nothing above is implemented in Phase 30. No fake internal endpoint was created to pretend it is. The
contract exists so that when a real execution layer is built, it has one pre-hardened function to call rather
than a permission and a route to design under time pressure.

## 13. Files

Modified: `backend/src/models/Outcome.js`, `backend/src/services/outcomeService.js`.
Created: `backend/scripts/validate-phase30-outcome-integrity.mjs`, this document.
Not modified: `backend/src/routes/outcomeRoutes.js`, `backend/src/controllers/outcomeController.js`,
`backend/src/auth/roles.js` (no permission added or granted), Action/Decision/Intelligence code, retrieval,
evidence validation, the frontend, `.claude/`, `CLAUDE.md`.
