# EOI — Authorization Policy (Phase 12)

**Status: PROPOSED. Nothing in this document is implemented.** Every rule marked
**[APPROVAL]** needs an explicit human decision before Phase 13+ may implement it.
Rules marked *(locked)* were already decided in Phases 1–11.

Scope: the backend surfaces that are still unauthenticated after Phase 11 (65 of 75
routes). Authentication, the four roles, the five permissions and the knowledge
ceilings are unchanged and locked.

## 0. Baseline (locked)

Authentication: bearer token → `authenticate` → active `WorkspaceMembership` → `req.actor`.
Authorization: role → permission (server-side map) → knowledge ceiling. The workspace a
request names is only a *selection* validated against membership; a non-member is a 404.

| Role | Permissions today | Ceiling |
|---|---|---|
| viewer | `intelligence:view` | guest |
| operator | + `decision:propose` | staff |
| reviewer | + `decision:review` | staff |
| admin | + `workspace:admin` | restricted |

`action:execute` is held by **no role**. Locked: self-approval allowed for Decision V1; no
automatic Actions; workspace deletion is eventually an operator/bootstrap act; no freshness
rule for stale Intelligence; resolved/dismissed Signals do not block Decision V1; no
property-level authorization.

## 1. Current state (verified in Phases 10–11)

Protected: dashboard reads, Decision V1 (5 routes), workspace `PATCH`/`DELETE` (`workspace:admin`),
and the Action → approved-Decision-V1 data invariant. `GET /health` is public by design.
Everything else has no authentication, no membership check and no permission check.

Findings that shape the policy:
1. **Unauthenticated LLM/embedding triggers.** `POST /intelligence/analyze/:signalId` and
   `POST /signals/:id/intelligence` reach the AI service (proved against a trap server). The
   level comes from the process fallback. `GET /signals/:id/knowledge-retrieval` is a
   "development/validation endpoint" that calls the AI service when embedded knowledge exists.
   `POST /knowledge-documents/:id/embeddings` and `/upload` embed through the AI service.
2. **Unauthenticated Guest/Stay reads and writes.** Guest PII (name, email, phone), reservation
   ids and stay dates are readable and writable by anyone who can name a workspace id.
3. **Imports upsert real Guest/Stay records.** `POST /imports/operational` updates existing
   Guests/Stays by `externalId`/`reservationId`, so an import can OVERWRITE existing PII. The
   workspace is a multipart body field (caller-chosen).
4. **Knowledge visibility is writable.** `PATCH /knowledge-documents/:id` accepts
   `defaultVisibility`; documents, chunks and embeddings can be created and deleted by anyone.
   (Reads already redact by ceiling.)
5. **Learning ignores parent-Intelligence visibility.** The learning service reads Decisions,
   Actions and Outcomes directly, so it can surface descriptions derived from
   staff/restricted knowledge to a caller whose ceiling would hide them elsewhere. The same is
   true of raw `GET /actions`, `/outcomes`, and `GET /intelligence` (which also returns
   provider/model/provenance ids).
6. **Action/Outcome writes are wide open.** An Action accepts any status (even `completed`), no
   Decision, and a free-text assignee; an Outcome needs no Action and no approved Decision.
7. **Workspace enumeration.** `GET /workspaces` lists every tenant; `POST /workspaces` creates one
   with no credential (a new workspace has no members).
8. **Legacy Decision `POST`/`PATCH`** are unauthenticated. They cannot create, mark, change or
   approve a Decision V1 (verified), but can create/alter legacy records that Actions may attach to.

## 2. New permissions proposed

The four-role model cannot express three distinctions the audit found. Everything else reuses
existing permissions (notably **`workspace:admin` stands in for knowledge and import
management**; no `knowledge:manage` or `import` permission is proposed).

| Proposed | Why the existing five cannot express it | Held by |
|---|---|---|
| `intelligence:generate` **[APPROVAL]** | "may see Intelligence" ≠ "may spend model budget and write a persistent record". `decision:propose` is deterministic and free; reusing it would silently couple two unrelated capabilities. | operator, reviewer, admin |
| `operations:view` **[APPROVAL]** | Guest PII / reservation / conversation reads are not Intelligence and not workspace administration. A viewer's `intelligence:view` deliberately reveals no PII (the dashboard has none). | operator, reviewer, admin |
| `operations:manage` **[APPROVAL]** | Creating/updating Signals, Guests, Stays and conversations is neither proposing a Decision nor administering a workspace. | operator, reviewer, admin |

**No-new-permission fallback [APPROVAL]:** if the three are rejected, the interim rule is
`workspace:admin` for every operational write and PII read (admin only), and `intelligence:view` for
non-PII reads. Cost: the provisioned development identity (operator) could no longer use the
Operations pages.

Deliberately NOT proposed now: `action:manage`, `outcome:record`, `knowledge:manage`,
`import:run`. Action/Outcome writes stay blocked (see §5–6); knowledge and imports are
admin-only via `workspace:admin`.

Final role × permission matrix if approved:

| Permission | viewer | operator | reviewer | admin |
|---|:-:|:-:|:-:|:-:|
| `intelligence:view` | ✓ | ✓ | ✓ | ✓ |
| `intelligence:generate` (new) | | ✓ | ✓ | ✓ |
| `operations:view` (new) | | ✓ | ✓ | ✓ |
| `operations:manage` (new) | | ✓ | ✓ | ✓ |
| `decision:propose` | | ✓ | ✓ | ✓ |
| `decision:review` | | | ✓ | ✓ |
| `workspace:admin` | | | | ✓ |
| `action:execute` | | | | |

## 3. LLM / embedding operations

Principles: generation changes persistent data (`Intelligence`) and spends budget; the level
must come only from the actor's role; the workspace only from membership; a request can never
name a level or role. Reading stored Intelligence is a separate, cheaper act.

| Operation | Route | Policy | Who | Notes |
|---|---|---|---|---|
| Read stored Intelligence | `GET /intelligence`, `/:id` | `intelligence:view` + ceiling **[APPROVAL for the raw shape]** | all roles | The raw record exposes provider/model/provenance ids; the dashboard already serves the safe shape. Recommend: authenticate, and either whitelist the response or retire the raw GET. |
| Generate Intelligence V1 | `POST /intelligence/analyze/:signalId` | `intelligence:generate` | operator, reviewer, admin | Idempotent per (workspace, signal, level): a repeat costs nothing. Generated at the ACTOR's ceiling, so an operator can never produce a restricted-level record. |
| Legacy generation | `POST /signals/:id/intelligence` | `intelligence:generate` until retired; then remove | operator+ | Still used by the legacy frontend Generate page — hardening needs a frontend token change. Recommend retiring after Intelligence V1 UI parity **[APPROVAL]**. |
| Knowledge retrieval (dev) | `GET /signals/:id/knowledge-retrieval` | admin-only (`workspace:admin`) or retire | admin | A development/validation endpoint; it spends embedding budget and returns retrieved sections. Recommend retire from HTTP **[APPROVAL]**. |
| Create embeddings | `POST /knowledge-documents/:id/embeddings` | `workspace:admin` | admin | Knowledge management (§6). |
| Upload knowledge | `POST /knowledge-documents/upload` | `workspace:admin` | admin | Auto-chunks/embeds; sets visibility (§6). |

Additional rules: a per-actor rate limit on `intelligence:generate` is required before broad use
(deferred, listed as a follow-up); `__testScenario` must stay honoured only under
`LLM_PROVIDER=test`; unauthorized requests must never reach the AI service (the check is
before any AI call).

## 4. Action policy

Distinguish: creating an Action *record*, executing it, completing it, recording its result,
and reading it. The locked chain is Signal → Intelligence V1 → Decision V1 → approved
Decision → Action → Outcome, and approval never implies execution.

| Operation | Policy now | Notes |
|---|---|---|
| Read (`GET /actions`, `/:id`) | reviewer, admin (`decision:review`), with parent-Intelligence visibility enforced **[APPROVAL]** | Action descriptions can derive from staff/restricted knowledge; today's reads ignore that. Viewers/operators DENY until visibility is enforced. |
| Create an Action record | **DEFER — blocked** | A human-created "planned Action" is plausible, but it needs its own permission and lifecycle. Requiring `action:execute` (held by nobody) blocks it without inventing policy. |
| Execute / change status / complete | **DEFER — `action:execute`, assigned to no role** | Requires: approved Decision V1, execution identity (user or named service), idempotency key, manual/automatic mode. None exists in the model. |
| Record a result | **DEFER — `action:execute`** | Same. |
| Automatic Action from an approved Decision | **DENY** *(locked)* | No automatic execution. |

Migration cost **[APPROVAL]**: blocking Action writes over HTTP breaks `validate-action`,
`validate-outcome`, `validate-learning` and parts of `validate-api`, which create Actions through the
API. They must move to model-level fixtures (as the identity suites already do). The alternative
interim — admin-only via `workspace:admin` — keeps the API usable but is a policy invention;
recommend against.

## 5. Outcome policy

An Outcome records what *happened* after an Action; it is a result, not an execution. Tying
it to `action:execute` would conflate "may act" with "may report what happened" (an auditor or a
guest-services reviewer may legitimately record results without being allowed to execute).

| Operation | Policy | Notes |
|---|---|---|
| Read | reviewer, admin, with visibility enforced | as Action reads |
| Create / update | **DEFER — blocked** | Recommend a *future* `outcome:record` permission, separate from `action:execute` **[APPROVAL, future]**. No lifecycle is invented: today's optional Action link and same-workspace/Intelligence checks stay. |
| Require an approved Decision V1 | Only via its Action: an Outcome that names an Action inherits that Action's already-enforced Decision rule. An Outcome with no Action is legacy-shaped and stays blocked with the rest. |

## 6. Operational data policy (workspace-level only)

Rule of thumb: what the dashboard already shows every role (non-PII Signal, Property and Unit facts)
stays readable by all roles; PII and reservation data need `operations:view`; writes need
`operations:manage`; destructive or configuration acts are admin-only.

| Resource | Read | Write (create/update) | Delete |
|---|---|---|---|
| Property, Unit | all roles (`intelligence:view`) | admin (`workspace:admin`) | admin |
| Signal | all roles (`intelligence:view`) | operator, reviewer, admin (`operations:manage`) | admin |
| Guest (PII) | operator, reviewer, admin (`operations:view`); viewer DENY | operator, reviewer, admin (`operations:manage`) | admin |
| Stay (reservation) | as Guest | as Guest | admin |
| Conversation / Message | member with `intelligence:view` **[APPROVAL]** | member with `intelligence:view` **[APPROVAL]** | admin |

Notes: (a) Guest/Stay delete is destructive and non-cascading, hence admin-only. (b) Conversation
`userId` is an unused free string; a per-user ownership model would derive it from the actor and is
**[APPROVAL]** (chat could remain workspace-shared). (c) The frontend Operations and Chat pages call
these routes without a token, so each resource must be hardened together with its frontend calls
being marked authenticated. (d) No property-level authorization *(locked)*.

## 7. Knowledge policy

Changing a document's visibility changes what AI retrieval can expose, so management is
restricted to the highest-trust role and can never exceed the actor's ceiling.

| Operation | Policy |
|---|---|
| List/get documents (metadata), list chunks | all roles, ceiling-enforced (`intelligence:view`) — the redaction already exists |
| Create, edit, delete a document; add chunks; embeddings; upload | admin (`workspace:admin`) |
| Set/change visibility (`defaultVisibility`, per-chunk visibility) | admin; and never above the actor's ceiling (admin = restricted, so effectively unrestricted) |
| Upload Business Knowledge | admin |
| Restricted visibility | admin-only to create or edit **(recommended, [APPROVAL])** |

`workspace:admin` is reused deliberately: only admins hold it today, so no `knowledge:manage` is
needed until a non-admin role must manage knowledge.

## 8. Import policy

`POST /imports/operational` upserts Guest and Stay records (overwriting existing PII by
`externalId`/`reservationId`) and is workspace-scoped by a caller-supplied multipart field.

Policy: admin only (`workspace:admin`), the workspace derived from membership (the multipart
`workspaceId` is only a selection validated against it), no new permission. `GET /imports/:id`
(batch results) admin. Implementation note: authenticate **before** the multipart parser runs, and
resolve membership after it (the workspace field arrives inside the form).

## 9. Workspace policy *(largely locked)*

| Route | Policy |
|---|---|
| `PATCH`, `DELETE /workspaces/:id` | `workspace:admin` in that workspace — **done** |
| `GET /workspaces` | authenticated; returns only the caller's active memberships ("mine") |
| `GET /workspaces/:id` | authenticated active member (`intelligence:view`) |
| `POST /workspaces` | **remove from normal HTTP**; operator/bootstrap script only (no platform-admin concept; a new workspace has no members) |
| `DELETE /workspaces/:id` | keep admin-only for now; **retire from HTTP** later (it orphans data — there is no cascade) **[APPROVAL on timing]** |

Migration cost: many suites create workspaces via `POST /workspaces`; they move to model fixtures.

## 10. Legacy Decision API

Recommend **B then C**. Interim (B): `POST /decisions` requires `decision:propose`, `PATCH /decisions/:id`
requires `decision:review`, both membership-scoped — mirroring V1 semantics, no new permission, V1 protection
unchanged. Then retire (C) once no suite or client uses them. Not D (no new legacy-only endpoints).
Retirement boundary **[APPROVAL]**: when `validate-action`, `-outcome`, `-learning`, `-api`, `-decision`
create their Decisions by model fixture, and after the Action/Outcome legacy routes are blocked.

## 11. Learning / reports

`GET /learning` and `/learning/patterns` return counts, Decision/Action descriptions, assignee
strings and aggregate guest counts (no guest names or contact details), but they bypass
parent-Intelligence visibility. Policy: **admin only** now (admin's ceiling is restricted, so nothing
is over-exposed); widen to reviewer only after the service applies the visibility filter
**[APPROVAL]**. Read-only; no create route exists.

## 12. API privacy classification

| Class | Endpoints |
|---|---|
| PUBLIC | `GET /health` |
| AUTHENTICATED WORKSPACE MEMBER (any role) | `GET /workspaces` (mine), `/workspaces/:id`, Property/Unit/Signal reads, knowledge document/chunk reads (ceiling-enforced), dashboard, Decision reads, conversations/messages **[APPROVAL]** |
| ROLE-RESTRICTED | Guest/Stay reads (`operations:view`); Signal/Guest/Stay writes (`operations:manage`); generation (`intelligence:generate`); Decision propose/review; Action/Outcome reads (reviewer/admin) |
| ADMIN-ONLY | Property/Unit writes, all deletes, knowledge management and embeddings, imports, learning, workspace `PATCH`/`DELETE` |
| SHOULD BE REMOVED / RETIRED | `POST /workspaces`, `GET /signals/:id/knowledge-retrieval` (dev endpoint), legacy `POST /signals/:id/intelligence`, raw `GET /intelligence` (replace with the whitelisted dashboard shape), legacy Decision `POST`/`PATCH`, `DELETE /workspaces/:id` |
| BLOCKED (nobody yet) | Action create/update/execute, Outcome create/update |

## 13. Final policy matrix

Legend: ALLOW, DENY, NEW = PROPOSE NEW PERMISSION, DEFER. Ceiling column = the knowledge ceiling that
applies when the operation returns or produces knowledge-derived data.

| Resource | Operation | viewer | operator | reviewer | admin | Permission | Ceiling | Notes |
|---|---|---|---|---|---|---|---|---|
| Intelligence | read (dashboard) | ALLOW | ALLOW | ALLOW | ALLOW | `intelligence:view` | role | done |
| Intelligence | read (raw GET) | ALLOW | ALLOW | ALLOW | ALLOW | `intelligence:view` | role | authenticate + whitelist/retire |
| Intelligence | generate V1 | DENY | NEW | NEW | NEW | `intelligence:generate` | actor's | rate limit follow-up |
| Intelligence | legacy generate | DENY | NEW | NEW | NEW | `intelligence:generate` | actor's | retire later |
| Knowledge retrieval (dev) | run | DENY | DENY | DENY | ALLOW | `workspace:admin` | role | or retire |
| Decision | read | ALLOW | ALLOW | ALLOW | ALLOW | `intelligence:view` | parent | done |
| Decision | propose | DENY | ALLOW | ALLOW | ALLOW | `decision:propose` | parent | done |
| Decision | approve/reject | DENY | DENY | ALLOW | ALLOW | `decision:review` | parent | done |
| Decision (legacy) | create | DENY | ALLOW | ALLOW | ALLOW | `decision:propose` | n/a | interim, then retire |
| Decision (legacy) | update | DENY | DENY | ALLOW | ALLOW | `decision:review` | n/a | interim, then retire |
| Action | read | DENY | DENY | ALLOW | ALLOW | `decision:review` | parent | needs visibility filter |
| Action | create/update/execute/complete/result | DENY | DENY | DENY | DENY | `action:execute` | n/a | DEFER; unassigned |
| Outcome | read | DENY | DENY | ALLOW | ALLOW | `decision:review` | parent | needs visibility filter |
| Outcome | create/update | DENY | DENY | DENY | DENY | future `outcome:record` | n/a | DEFER |
| Property, Unit | read | ALLOW | ALLOW | ALLOW | ALLOW | `intelligence:view` | n/a | |
| Property, Unit | write/delete | DENY | DENY | DENY | ALLOW | `workspace:admin` | n/a | |
| Signal | read | ALLOW | ALLOW | ALLOW | ALLOW | `intelligence:view` | n/a | |
| Signal | create/update | DENY | NEW | NEW | NEW | `operations:manage` | n/a | |
| Signal | delete | DENY | DENY | DENY | ALLOW | `workspace:admin` | n/a | |
| Guest, Stay | read | DENY | NEW | NEW | NEW | `operations:view` | n/a | PII / reservation |
| Guest, Stay | create/update | DENY | NEW | NEW | NEW | `operations:manage` | n/a | |
| Guest, Stay | delete | DENY | DENY | DENY | ALLOW | `workspace:admin` | n/a | |
| Conversation, Message | read/write | DEFER | DEFER | DEFER | DEFER | `intelligence:view` (proposed) | n/a | ownership undecided |
| Conversation | delete | DENY | DENY | DENY | ALLOW | `workspace:admin` | n/a | |
| Knowledge document/chunks | read | ALLOW | ALLOW | ALLOW | ALLOW | `intelligence:view` | role | redaction exists |
| Knowledge | create/edit/delete/chunk/embed/upload | DENY | DENY | DENY | ALLOW | `workspace:admin` | n/a | |
| Knowledge | set/change visibility | DENY | DENY | DENY | ALLOW | `workspace:admin` | ≤ actor's | restricted: admin only |
| Import | run / read batch | DENY | DENY | DENY | ALLOW | `workspace:admin` | n/a | overwrites PII |
| Workspace | list (mine), read | ALLOW | ALLOW | ALLOW | ALLOW | `intelligence:view` | n/a | |
| Workspace | create | DENY | DENY | DENY | DENY | (operator script) | n/a | remove from HTTP |
| Workspace | update/delete | DENY | DENY | DENY | ALLOW | `workspace:admin` | n/a | done; retire delete later |
| Learning, patterns | read | DENY | DENY | DEFER | ALLOW | `workspace:admin` | restricted | widen after visibility filter |

## 14. Decisions requiring explicit human approval

1. Add `intelligence:generate`, `operations:view`, `operations:manage` — or take the admin-only fallback.
2. Retire the dev retrieval endpoint and the legacy Generate route (and the frontend page that uses it).
3. Whitelist or retire raw `GET /intelligence`.
4. Action and Outcome writes blocked ("nobody yet") and the resulting move of suites to model fixtures.
5. Action/Outcome/Learning reads restricted to reviewer/admin (admin only for Learning) pending a visibility filter.
6. Conversation ownership: workspace-shared or per-user (`userId` from the actor).
7. Restricted knowledge admin-only; knowledge and imports admin-only via `workspace:admin`.
8. Workspace creation and deletion off normal HTTP; timing of retiring `DELETE`.
9. Legacy Decision API: interim authentication then retirement boundary.
10. A future `outcome:record` permission and who would hold it.

## 15. Recommended implementation order

Pair each backend step with the frontend calls that use those routes (mark them `authenticated: true`).

1. **Phase 13 — LLM, knowledge, imports.** `intelligence:generate` on analyze; admin-only knowledge management, embeddings, upload, imports, dev retrieval; response whitelist or retirement of raw `GET /intelligence`. Highest cost/integrity risk, little frontend impact (only the legacy Generate page).
2. **Phase 14 — operational data.** `operations:view` / `operations:manage` on Guest, Stay, Signal (plus Property/Unit admin writes); frontend Operations pages updated together.
3. **Phase 15 — Action, Outcome, Learning.** Block writes; visibility-filtered reads for reviewer/admin; learning admin-only; migrate suites to fixtures.
4. **Phase 16 — workspace and legacy Decision.** "Mine" listing, membership-scoped read, remove `POST`/(later) `DELETE` from HTTP, authenticate then retire legacy Decision routes.
5. **Later.** Conversation ownership, per-actor rate limits, security headers, a real identity provider, `outcome:record`, and the Action execution design.
