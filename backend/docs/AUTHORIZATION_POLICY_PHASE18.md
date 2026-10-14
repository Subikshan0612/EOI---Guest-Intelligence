# Authorization policy - Phase 18: Conversations and Messages

Status: implemented and tested (`backend/scripts/validate-phase18-authorization.mjs`).
Builds on `AUTHORIZATION_POLICY_PHASE12.md` (roles, permissions, knowledge ceilings) and Phases 13-17.

## 1. Model: conversations are WORKSPACE-SHARED

A Conversation belongs to a **workspace**, not to a user. Every active member of the workspace may read every
Conversation and Message in it; members who may *write* may add to any of them. There is no per-user privacy inside a
workspace. This matches how the product behaves today (the UI lists conversations per workspace and never sets an owner).

- No `ownerUserId` exists. No data was migrated. The existing Conversations and Messages are unchanged.
- Cross-workspace isolation is the only isolation boundary, and it is enforced on every route.

## 2. Permissions (existing ones; nothing new was created)

| Operation | Route | Permission | Roles |
|---|---|---|---|
| List / read conversations | `GET /conversations`, `GET /conversations/:id` | `intelligence:view` | viewer, operator, reviewer, admin |
| Read messages | `GET /conversations/:id/messages` | `intelligence:view` | all four |
| Create / update a conversation | `POST /conversations`, `PATCH /conversations/:id` | `operations:manage` | operator, reviewer, admin |
| Create a message | `POST /conversations/:id/messages` | `operations:manage` | operator, reviewer, admin |
| Delete a conversation | `DELETE /conversations/:id` | `workspace:admin` | admin |

- **Delete** is exposed because the UI has a "delete conversation" action, and it follows the locked rule that every
  destructive operation needs `workspace:admin` (no new permission). Deleting a conversation still does **not** cascade
  to its Messages (known limitation); the orphaned messages are unreachable because every message read goes through the
  parent Conversation.
- **Messages are append-only.** There is no Message `PATCH`/`DELETE` route, and none was added. A Message can be created
  and listed, nothing more.

## 3. Authorization chain

```
bearer token -> authenticate            (401 missing/invalid/expired; 403 unregistered identity or disabled user)
             -> active membership       (workspace selected by body for POST /conversations, by ?workspaceId= otherwise;
                                         non-member / revoked / suspended workspace = 404)
             -> requirePermission       (403 FORBIDDEN, from the server-side role map)
             -> controller              (uses req.actor.workspaceId, never the caller's value)
             -> service                 (Conversation resolved WITH workspaceId = actor workspace)
```

The workspace named by the caller is only a **selector**. `X-Role`, `X-Permission`, `X-Workspace-Id`, `role=`,
`permission=`, `userId`, body role/permission fields and token claims never influence the decision.

### Message -> Conversation -> workspace

A Message has no `workspaceId`. Every message operation first resolves the Conversation inside the actor's workspace
(`findInWorkspaceOr404`) and only then touches Messages. `getMessageById(id, workspaceId)` (unused by routes) resolves a
message *through* its Conversation too, so a message of another workspace, or with a missing parent, is the same 404 as a
message that does not exist.

## 4. Why `Conversation.userId` is not authoritative

`userId` is a free-text string. Nothing sets it from the authenticated identity, it is not linked to the `User`
collection, the frontend never sends it, and older records may hold arbitrary text. Using it for authorization would let
anyone who can write a string impersonate an owner. So it is retained **only as non-authoritative metadata**: it is
never compared to the token, never used as a filter or bypass, and never grants or denies access. The suite proves that
an arbitrary, empty, null, another workspace's, or the caller's own `userId` changes no decision.

## 5. Cross-workspace failure behavior

Objects outside the actor's verified workspace return **404** (same as a missing object; no existence oracle). Naming
another workspace as the selector returns 404 because the caller is not a member. A Conversation cannot be moved
between workspaces (`PATCH` with a different `workspaceId` is refused with 400), and referenced Guest/Stay/Signal ids
must belong to the same workspace.

## 6. Resource limits

List endpoints already clamp `limit` (default 20, hard maximum 100; invalid values fall back to the default; a huge page
number returns an empty page). Phase 18 adds one change: a Conversation's **messages** may be fetched up to **200** per
page, because the chat UI loads a conversation's history in one request (`limit=200`); previously that request was
silently truncated to 100. 200 is still a hard server-side bound. Message `content`/`metadata` size is not limited (a
remaining item).

## 7. Known consequences

- A viewer can read every conversation in the workspace (including ones that discuss Guest/Stay details). That is the
  workspace-shared decision; conversation content is not visibility-filtered.
- An operator may post `assistant`/`system` role messages: the UI persists generated intelligence messages through the
  same endpoint. `role` is a message attribute, not an authorization input.

## 8. If user-owned conversations are ever required

1. Add `ownerUserId` (ObjectId ref `User`), set **only** from `req.actor.userId` on create; never accept it from a body.
2. Decide the fate of existing ownerless conversations (a migration or "workspace-shared legacy" treatment).
3. Add an ownership check next to the workspace check, plus a rule for who may see others' (e.g. `workspace:admin`).
4. Keep `userId` as legacy metadata or drop it. Do not reuse it as the owner.
