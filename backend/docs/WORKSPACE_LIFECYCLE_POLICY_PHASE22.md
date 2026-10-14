# Workspace lifecycle policy - Phase 22

Implemented in `src/services/workspaceLifecycleService.js` and `workspaceService.js`; operator tool
`scripts/workspace-lifecycle.mjs`; validated by `scripts/validate-phase22-workspace-lifecycle.mjs`.

## 1. What `suspended` means today (audited)

`Workspace.status` is `active | inactive | suspended`. Membership resolution (`auth/membership.js`) requires an **active**
workspace, so a workspace that is `inactive` or `suspended` is **"not found" (404) for every member, administrators
included**, and there is no API route that can reactivate it (every admin route resolves the workspace first). The two
statuses behave identically. Memberships have `active | revoked`; there is no route that changes a membership or a user.

## 2. Suspension / last-admin policy

* An administrator **cannot** suspend or deactivate a workspace through the API. Any status other than the current one is
  refused with **409 `WORKSPACE_LOCKOUT_PREVENTED`** (nothing applied, even if other fields were sent with it).
  Reason: whatever the number of administrators, a non-active workspace is unreachable for all of them, so "at least one active
  administrator who can still access it" can never hold afterwards. Re-stating the current status (`active`) is a harmless no-op.
* Suspending/reactivating a tenant is an **operator** action: `node scripts/workspace-lifecycle.mjs set-status --workspace <id|slug> --status ...`.
  There is no platform-admin role in the model and none was invented.
* Memberships/roles/users: no route changes them, so there is no other path to a workspace without an administrator. For
  the future, `countActiveAdmins` / `assertWorkspaceKeepsAdmin` (unit-tested) define the exact rule: an `admin` membership with
  status `active` whose `User` is `active`; a future membership/role/user-disable route must call it before committing
  (`409 LAST_ADMIN_REQUIRED`). **Limitation:** on a standalone MongoDB two concurrent removals could each see the other admin;
  a transaction (replica set) closes that window.
* `name` (<= 200), `slug` (lowercase letters, digits, hyphen; <= 100) and `settings` (bounded JSON: 8 KB, depth 4, 50 keys) are validated.

## 3. Dependency graph (every workspace-owned record)

```
Workspace
 |- WorkspaceMembership (workspaceId) ---> User  (GLOBAL identity; never workspace-owned)
 |- Property (workspaceId) --- Unit (propertyId; no workspaceId)
 |- Guest (workspaceId, PII) ; Stay (workspaceId; guestId, propertyId, unitId)
 |- Signal (workspaceId; propertyId, unitId, guestId, stayId)
 |- Conversation (workspaceId; guestId, stayId, signalIds) --- Message (conversationId; no workspaceId)
 |- Intelligence (workspaceId; signalIds, conversationId, guestId, stayId, propertyId)   [derived AI artifact]
 |     |- Decision (workspaceId, intelligenceId)
 |     |- Action   (workspaceId, intelligenceId, decisionId)
 |     '- Outcome  (workspaceId, intelligenceId, actionId)
 |- KnowledgeDocument (workspaceId; propertyId, unitId, supersedesId) --- KnowledgeChunk (workspaceId, documentId; embeddings)
 '- ImportBatch (workspaceId, propertyId)
```
Learning/pattern data is computed on demand from Decision/Action/Outcome (no collection). There is **no** shared/global knowledge,
**no** analytics store, and (Phase 35) exactly one metadata-only audit collection, `AnalysisAdmission`, which is deleted with its workspace. Suite test `DG1` fails if a model with a `workspaceId` is ever added without
being added to the deletion order.

## 4. Deletion policy (decided from the existing semantics; no assumption about retention)

* **Hard delete, no soft-delete state.** Every existing delete in the application is a hard delete (Guest, Stay, Property,
  Conversation ...), no model has a "deleted" marker, and the existing `DELETE /workspaces/:id` was already a hard delete of the
  root. The policy extends that meaning to the whole tenant: deleting a workspace **erases** it. There is no undo and no retention copy
  inside EOI (backups are outside the application).
* **PII (Guest, Stay, conversations):** deleted. **Historical intelligence, decisions, actions, outcomes, knowledge (text and
  embedding vectors), imports (counts/errors only, never the file):** deleted with the tenant. Nothing is anonymised or retained.
* **Users:** never deleted (a User is a global identity that may belong to other workspaces). A user left without any membership
  simply has no workspace. **Memberships:** the workspace's own membership rows are deleted.
* **Shared/global knowledge:** none exists. **Audit/security records:** none exist.
* **Orphan messages:** a Message has no `workspaceId`; it is reachable only through its Conversation. Deletion removes only the
  Messages of **this workspace's own Conversations**. The 2 pre-existing orphan Messages in the real data have no Conversation, so
  no workspace can be attributed to them: they are **not touched** (asserted). Cleaning them needs a separate, explicit decision.
* **Guard:** `DELETE /api/workspaces/:id` requires `workspace:admin` (unchanged), the caller's active membership in that workspace
  (foreign/nonexistent/suspended -> the same 404), and a body `{ "confirm": "<the workspace slug>" }` (else 400
  `WORKSPACE_DELETE_CONFIRMATION_REQUIRED`). The confirmation prevents an accidental single request from erasing a tenant.

## 5. Deletion algorithm and MongoDB behavior

1. **Quiesce** - `status: inactive` (guarded, idempotent). Members immediately get 404, so nothing can be written meanwhile.
2. **Purge** - leaf first: Message, Conversation, Outcome, Action, Decision, Intelligence, KnowledgeChunk, KnowledgeDocument, ImportBatch,
   Signal, Stay, Guest, Unit, Property, WorkspaceMembership. Every statement is a `deleteMany` scoped by this workspace's own ids
   (Messages via its Conversations in batches of 500, Units via its Properties): **idempotent**, so a retry deletes nothing twice.
3. **Remove** - the Workspace document, last.

* **Replica set / sharded:** steps 2-3 run in **one transaction** (all or nothing).
* **Standalone MongoDB (the development setup; verified `topology = Single`):** no transactions. The ordered, idempotent steps are
  the safeguard. If the process dies midway the workspace stays `inactive` with partial data - unreachable to members and safe -
  and the operator finishes it with `scripts/workspace-lifecycle.mjs delete --workspace <id|slug> --confirm <slug> --resume`
  (the HTTP route cannot, because an inactive workspace resolves to 404). Repeating a completed deletion is a 404, identical to a
  nonexistent workspace.
* **Not atomic on standalone:** during the purge the workspace is inactive, so no request can observe or extend the half-deleted state.
* The route returns the deleted workspace (the existing response shape); per-collection counts are logged server-side only.

## 6. Operator tool

`inventory` (dry-run counts, no content printed), `set-status` (suspend/reactivate), `delete --confirm <slug> [--resume]`.

## 7. Not in this phase

Soft-delete/restore and retention windows, per-tenant export before deletion, membership-management routes, cleaning the 2 real
orphan Messages, distributed rate limiting, a real identity provider.
