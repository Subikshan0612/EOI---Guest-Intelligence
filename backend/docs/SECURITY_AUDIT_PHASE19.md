# Security audit - Phase 19: full API authorization and attack-surface audit

Baseline: git HEAD `d94287f` (all Phase 9-18 work is in the **uncommitted working tree**). Audit date: 2026-09-26.
Method: the **live Express router** was introspected (not the docs), every route was probed over real HTTP against a
spawned backend with real stored users/memberships/tokens in throwaway workspaces (`backend/scripts/validate-phase19-route-inventory.mjs`,
911 checks), and the services behind each route were read. The audit changed **no application source code**. No AI/LLM
call was made (the AI URL was a dead port, provider `test`), and no real record was touched (counts identical before/after).

Severity language is factual (exploitability x impact), not a score. "Critical" = an unauthenticated or cross-tenant
compromise that works today; none were found.

---

## 1. Complete endpoint inventory (74 routes)

Produced by `node backend/scripts/validate-phase19-route-inventory.mjs --markdown`. The suite FAILS if the running app
registers any route not in this table, drops one, mounts one elsewhere, or changes a route's middleware chain
(`INV0-INV4`, `CH*`). There are no dynamically registered routes, no other API prefix, no debug/admin/metrics/graphql
routes (probed: 404), and the only other HTTP server in the repo is `backend/server.js` (scripts spawn it; nothing else
listens). The app-level stack is exactly: CORS, `express.json()` (100 KB default), the router, the not-found handler, the error handler.

Counts: **74 endpoints = 2 public + 72 authenticated** (71 with `authenticate > active membership > permission`, 1
`authenticate`-only: `GET /api/workspaces`, which lists only the caller's own memberships). **39 write routes**
(POST/PATCH/DELETE), of which **4 are blocked for every role** (Action/Outcome writes, `action:execute` held by nobody).
**6 routes can reach the AI service**, **3 are LEGACY**, **1 is DEBUG/DEV**.

| # | METHOD | PATH | AUTH | MEMBERSHIP | PERMISSION | OBJECT CHECK | WORKSPACE SOURCE | SENSITIVE DATA | WRITE | AI/EXTERNAL | STATUS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | GET | `/` | none | - | PUBLIC | n/a | none | none (liveness only) | no | no | PUBLIC (by design) |
| 2 | GET | `/api/health` | none | - | PUBLIC | n/a | none | none (liveness only) | no | no | PUBLIC (by design) |
| 3 | GET | `/api/workspaces` | bearer | own list | AUTH | list = caller's own active memberships | actor-memberships | workspace name/slug/settings | no | no | ACTIVE |
| 4 | GET | `/api/workspaces/:id` | bearer | active | intelligence:view | id IS the selector: membership of :id verified; controller uses actor workspace | path | workspace name/slug/settings | no | no | ACTIVE |
| 5 | PATCH | `/api/workspaces/:id` | bearer | active | workspace:admin | id IS the selector: membership of :id verified; controller uses actor workspace | path | workspace name/slug/settings | yes | no | ACTIVE |
| 6 | DELETE | `/api/workspaces/:id` | bearer | active | workspace:admin | id IS the selector: membership of :id verified; controller uses actor workspace | path | workspace name/slug/settings | yes | no | ACTIVE (no cascade) |
| 7 | POST | `/api/properties` | bearer | active | workspace:admin | AT lookup {_id, workspaceId = actor} | body | property data | yes | no | ACTIVE |
| 8 | GET | `/api/properties` | bearer | active | intelligence:view | AT lookup {_id, workspaceId = actor} | query | property data | no | no | ACTIVE |
| 9 | GET | `/api/properties/:id` | bearer | active | intelligence:view | AT lookup {_id, workspaceId = actor} | query | property data | no | no | ACTIVE |
| 10 | PATCH | `/api/properties/:id` | bearer | active | workspace:admin | AT lookup {_id, workspaceId = actor} | query | property data | yes | no | ACTIVE |
| 11 | DELETE | `/api/properties/:id` | bearer | active | workspace:admin | AT lookup {_id, workspaceId = actor} | query | property data | yes | no | ACTIVE |
| 12 | POST | `/api/units` | bearer | active | workspace:admin | AT lookup: Unit -> parent Property {workspaceId = actor} | body | unit data | yes | no | ACTIVE |
| 13 | GET | `/api/units` | bearer | active | intelligence:view | AT lookup: Unit -> parent Property {workspaceId = actor} | query | unit data | no | no | ACTIVE |
| 14 | GET | `/api/units/:id` | bearer | active | intelligence:view | AT lookup: Unit -> parent Property {workspaceId = actor} | query | unit data | no | no | ACTIVE |
| 15 | PATCH | `/api/units/:id` | bearer | active | workspace:admin | AT lookup: Unit -> parent Property {workspaceId = actor} | query | unit data | yes | no | ACTIVE |
| 16 | DELETE | `/api/units/:id` | bearer | active | workspace:admin | AT lookup: Unit -> parent Property {workspaceId = actor} | query | unit data | yes | no | ACTIVE |
| 17 | POST | `/api/guests` | bearer | active | operations:manage | AT lookup {_id, workspaceId = actor} | body | GUEST PII | yes | no | ACTIVE |
| 18 | GET | `/api/guests` | bearer | active | operations:view | AT lookup {_id, workspaceId = actor} | query | GUEST PII | no | no | ACTIVE |
| 19 | GET | `/api/guests/:id` | bearer | active | operations:view | AT lookup {_id, workspaceId = actor} | query | GUEST PII | no | no | ACTIVE |
| 20 | PATCH | `/api/guests/:id` | bearer | active | operations:manage | AT lookup {_id, workspaceId = actor} | query | GUEST PII | yes | no | ACTIVE |
| 21 | DELETE | `/api/guests/:id` | bearer | active | workspace:admin | AT lookup {_id, workspaceId = actor} | query | GUEST PII | yes | no | ACTIVE |
| 22 | POST | `/api/stays` | bearer | active | operations:manage | AT lookup {_id, workspaceId = actor}; refs validated AFTER lookup (400 oracle) | body | STAY / reservation data | yes | no | ACTIVE |
| 23 | GET | `/api/stays` | bearer | active | operations:view | AT lookup {_id, workspaceId = actor}; refs validated AFTER lookup (400 oracle) | query | STAY / reservation data | no | no | ACTIVE |
| 24 | GET | `/api/stays/:id` | bearer | active | operations:view | AT lookup {_id, workspaceId = actor}; refs validated AFTER lookup (400 oracle) | query | STAY / reservation data | no | no | ACTIVE |
| 25 | PATCH | `/api/stays/:id` | bearer | active | operations:manage | AT lookup {_id, workspaceId = actor}; refs validated AFTER lookup (400 oracle) | query | STAY / reservation data | yes | no | ACTIVE |
| 26 | DELETE | `/api/stays/:id` | bearer | active | workspace:admin | AT lookup {_id, workspaceId = actor}; refs validated AFTER lookup (400 oracle) | query | STAY / reservation data | yes | no | ACTIVE |
| 27 | POST | `/api/signals` | bearer | active | operations:manage | AT lookup {_id, workspaceId = actor}; refs validated AFTER lookup (400 oracle) | body | signal data | yes | no | ACTIVE |
| 28 | GET | `/api/signals` | bearer | active | intelligence:view | AT lookup {_id, workspaceId = actor}; refs validated AFTER lookup (400 oracle) | query | signal data | no | no | ACTIVE |
| 29 | GET | `/api/signals/:id/context` | bearer | active | operations:view | signal AT lookup; related records queried with workspaceId | query | GUEST/STAY facts | no | no | ACTIVE |
| 30 | POST | `/api/signals/:id/intelligence` | bearer | active | intelligence:generate | signal scoped lookup BEFORE any AI call | query | generated Intelligence (level-gated) | yes | YES: Python AI service (Gemini) | LEGACY (retirement candidate) |
| 31 | GET | `/api/signals/:id/knowledge-retrieval` | bearer | active | workspace:admin | signal scoped lookup BEFORE the embedding call | query | knowledge text (ceiling-gated) | no | YES: embeddings via Python AI service | DEBUG/DEV (retirement candidate) |
| 32 | GET | `/api/signals/:id` | bearer | active | intelligence:view | AT lookup {_id, workspaceId = actor}; refs validated AFTER lookup (400 oracle) | query | signal data | no | no | ACTIVE |
| 33 | PATCH | `/api/signals/:id` | bearer | active | operations:manage | AT lookup {_id, workspaceId = actor}; refs validated AFTER lookup (400 oracle) | query | signal data | yes | no | ACTIVE |
| 34 | DELETE | `/api/signals/:id` | bearer | active | workspace:admin | AT lookup {_id, workspaceId = actor}; refs validated AFTER lookup (400 oracle) | query | signal data | yes | no | ACTIVE |
| 35 | POST | `/api/conversations` | bearer | active | operations:manage | AT lookup {_id, workspaceId = actor} | body | conversation content | yes | no | ACTIVE |
| 36 | GET | `/api/conversations` | bearer | active | intelligence:view | AT lookup {_id, workspaceId = actor} | query | conversation content | no | no | ACTIVE |
| 37 | POST | `/api/conversations/:conversationId/messages` | bearer | active | operations:manage | Message -> Conversation scoped lookup {workspaceId = actor} BEFORE messages | query | conversation content | yes | no | ACTIVE |
| 38 | GET | `/api/conversations/:conversationId/messages` | bearer | active | intelligence:view | Message -> Conversation scoped lookup {workspaceId = actor} BEFORE messages | query | conversation content | no | no | ACTIVE |
| 39 | GET | `/api/conversations/:id` | bearer | active | intelligence:view | AT lookup {_id, workspaceId = actor} | query | conversation content | no | no | ACTIVE |
| 40 | PATCH | `/api/conversations/:id` | bearer | active | operations:manage | AT lookup {_id, workspaceId = actor} | query | conversation content | yes | no | ACTIVE |
| 41 | DELETE | `/api/conversations/:id` | bearer | active | workspace:admin | AT lookup {_id, workspaceId = actor} | query | conversation content | yes | no | ACTIVE |
| 42 | POST | `/api/intelligence/analyze/:signalId` | bearer | active | intelligence:generate | signal scoped lookup BEFORE any AI call | query | generated Intelligence (level-gated) | yes | YES: Python AI service (Gemini) | ACTIVE |
| 43 | GET | `/api/intelligence` | bearer | active | intelligence:view | AT lookup {_id, workspaceId = actor} + analysisLevel/knowledgeVisibility gate | query | Intelligence (whitelisted view, ceiling-gated) | no | no | ACTIVE |
| 44 | GET | `/api/intelligence/:id` | bearer | active | intelligence:view | AT lookup {_id, workspaceId = actor} + analysisLevel/knowledgeVisibility gate | query | Intelligence (whitelisted view, ceiling-gated) | no | no | ACTIVE |
| 45 | POST | `/api/decisions/propose/:intelligenceId` | bearer | active | decision:propose | Intelligence scoped lookup + visibility BEFORE create | query | Decision (derived from Intelligence) | yes | no | ACTIVE |
| 46 | POST | `/api/decisions/:id/approve` | bearer | active | decision:review | AT lookup {_id, workspaceId = actor} + live parent-Intelligence visibility | query | Decision (ceiling-gated via parent) | yes | no | ACTIVE |
| 47 | POST | `/api/decisions/:id/reject` | bearer | active | decision:review | AT lookup {_id, workspaceId = actor} + live parent-Intelligence visibility | query | Decision (ceiling-gated via parent) | yes | no | ACTIVE |
| 48 | GET | `/api/decisions` | bearer | active | intelligence:view | AT lookup {_id, workspaceId = actor} + live parent-Intelligence visibility | query | Decision (ceiling-gated via parent) | no | no | ACTIVE |
| 49 | GET | `/api/decisions/:id` | bearer | active | intelligence:view | AT lookup {_id, workspaceId = actor} + live parent-Intelligence visibility | query | Decision (ceiling-gated via parent) | no | no | ACTIVE |
| 50 | POST | `/api/decisions` | bearer | active | decision:propose | Intelligence findById then assertSameWorkspace (AFTER lookup; 400 oracle) | body | Decision | yes | no | LEGACY (retirement candidate) |
| 51 | PATCH | `/api/decisions/:id` | bearer | active | decision:review | AT lookup {_id, workspaceId = actor}; V1 refused | query | Decision | yes | no | LEGACY (retirement candidate) |
| 52 | POST | `/api/actions` | bearer | active | action:execute | DENIED before lookup for every role (service checks exist but are unreachable) | body | - | yes | no | BLOCKED (no role holds action:execute) |
| 53 | GET | `/api/actions` | bearer | active | decision:review | AT lookup {_id, workspaceId = actor} + parent-Intelligence visibility | query | Action/Outcome text (ceiling-gated via parent) | no | no | ACTIVE |
| 54 | GET | `/api/actions/:id` | bearer | active | decision:review | AT lookup {_id, workspaceId = actor} + parent-Intelligence visibility | query | Action/Outcome text (ceiling-gated via parent) | no | no | ACTIVE |
| 55 | PATCH | `/api/actions/:id` | bearer | active | action:execute | DENIED before lookup for every role (service checks exist but are unreachable) | query | - | yes | no | BLOCKED (no role holds action:execute) |
| 56 | POST | `/api/outcomes` | bearer | active | action:execute | DENIED before lookup for every role (service checks exist but are unreachable) | body | - | yes | no | BLOCKED (no role holds action:execute) |
| 57 | GET | `/api/outcomes` | bearer | active | decision:review | AT lookup {_id, workspaceId = actor} + parent-Intelligence visibility | query | Action/Outcome text (ceiling-gated via parent) | no | no | ACTIVE |
| 58 | GET | `/api/outcomes/:id` | bearer | active | decision:review | AT lookup {_id, workspaceId = actor} + parent-Intelligence visibility | query | Action/Outcome text (ceiling-gated via parent) | no | no | ACTIVE |
| 59 | PATCH | `/api/outcomes/:id` | bearer | active | action:execute | DENIED before lookup for every role (service checks exist but are unreachable) | query | - | yes | no | BLOCKED (no role holds action:execute) |
| 60 | POST | `/api/knowledge-documents` | bearer | active | workspace:admin | workspace-scoped; refs validated AFTER lookup | body | knowledge text/metadata (ceiling-gated) | yes | YES: auto chunk + embed after create | ACTIVE |
| 61 | GET | `/api/knowledge-documents` | bearer | active | intelligence:view | workspace-scoped; refs validated AFTER lookup | query | knowledge text/metadata (ceiling-gated) | no | no | ACTIVE |
| 62 | POST | `/api/knowledge-documents/upload` | bearer | active | workspace:admin | propertyId/unitId validated AFTER lookup | form | knowledge text | yes | YES: embeddings via Python AI service (auto chunk+embed) | ACTIVE |
| 63 | POST | `/api/knowledge-documents/:documentId/chunks` | bearer | active | workspace:admin | document AT lookup {workspaceId = actor}; chunk visibility filter; NO embedding vectors | query | knowledge text (ceiling-gated) | yes | no | ACTIVE |
| 64 | GET | `/api/knowledge-documents/:documentId/chunks` | bearer | active | intelligence:view | document AT lookup {workspaceId = actor}; chunk visibility filter; NO embedding vectors | query | knowledge text (ceiling-gated) | no | no | ACTIVE |
| 65 | POST | `/api/knowledge-documents/:documentId/embeddings` | bearer | active | workspace:admin | document AT lookup {workspaceId = actor} | query | knowledge text | yes | YES: embeddings via Python AI service | ACTIVE |
| 66 | GET | `/api/knowledge-documents/:id` | bearer | active | intelligence:view | AT lookup {_id, workspaceId = actor} + visibility | query | knowledge text/metadata (ceiling-gated) | no | no | ACTIVE |
| 67 | PATCH | `/api/knowledge-documents/:id` | bearer | active | workspace:admin | AT lookup {_id, workspaceId = actor} + visibility | query | knowledge text/metadata (ceiling-gated) | yes | no | ACTIVE |
| 68 | DELETE | `/api/knowledge-documents/:id` | bearer | active | workspace:admin | AT lookup {_id, workspaceId = actor} + visibility | query | knowledge text/metadata (ceiling-gated) | yes | no | ACTIVE |
| 69 | GET | `/api/learning` | bearer | active | workspace:admin | aggregation filtered by workspaceId = actor (no caller id) | query | Decision/Action/Outcome text (ignores parent visibility => admin only) | no | no | ACTIVE |
| 70 | GET | `/api/learning/patterns` | bearer | active | workspace:admin | aggregation filtered by workspaceId = actor (no caller id) | query | Decision/Action/Outcome text (ignores parent visibility => admin only) | no | no | ACTIVE |
| 71 | POST | `/api/imports/operational` | bearer | active | workspace:admin | propertyId proven to belong to the workspace; Unit only via that Property | form | writes GUEST/STAY PII | yes | no | ACTIVE |
| 72 | GET | `/api/imports/:id` | bearer | active | operations:view | AT lookup {_id, workspaceId = actor} | query | import counts, row errors | no | no | ACTIVE |
| 73 | GET | `/api/dashboard/signals` | bearer | active | intelligence:view | AT lookup {_id, workspaceId = actor}; refs validated AFTER lookup (400 oracle) | query | signal data | no | no | ACTIVE |
| 74 | GET | `/api/dashboard/signals/:signalId` | bearer | active | intelligence:view | AT lookup {_id, workspaceId = actor}; refs validated AFTER lookup (400 oracle) | query | signal data | no | no | ACTIVE |

Public routes and why: `GET /` returns a fixed service banner (no data); `GET /api/health` is a liveness/DB-status probe
for orchestration. Neither returns identity, tenant or record data (asserted `PR*`).

---

## 2. Authentication matrix

For every non-public route the probe asserted (911 checks total, `AU*`):

| Question | Result |
|---|---|
| Reachable without a token? | **No** - 401 `MISSING_CREDENTIAL` on all 72 |
| Invalid / malformed / expired / wrong-signature token? | 401 |
| Forged `X-Role` / `X-Permission` / `X-Workspace-Id` / `X-Knowledge-Level` / cookies substitute for identity? | **No** - `authenticate` reads only `Authorization: Bearer`; the identity is (issuer, subject) of the verified token. Asserted in Phases 13-18 suites |
| Query/body parameters substitute for identity (`userId`, `role`, `permission`, token claims)? | **No** |
| Valid token but unregistered identity | 403 `IDENTITY_NOT_REGISTERED` (nothing auto-provisioned) |
| Disabled user reaches the controller? | **No** - 403 (also re-checked inside membership resolution) |
| Revoked membership / non-member / member of a suspended workspace reaches workspace data? | **No** - 404 "Workspace not found" (no existence oracle) |
| Uploads: is the multipart body parsed before authentication? | **No** - chain is `authenticate > handleUpload > membership > permission` |
| JSON bodies: parsed before authentication? | **Yes** - `express.json()` runs first, bounded to 100 KB (`ER8`). Low. |
| Production mode | `NODE_ENV=production`: the development stub verifier is refused (`ER3`); **there is no production verifier yet** (finding H2/known issue 9) |

---

## 3. Permission matrix (function-level authorization)

Actual permission per route is in the inventory column PERMISSION and was **verified by behavior**: for each of the 4
roles the observed decision (403 `FORBIDDEN` vs permitted) equals the server-side role map for all 72 routes (`FN*`).
Summary of the role map (unchanged from the locked policy):

| Permission | viewer | operator | reviewer | admin | Gates |
|---|:-:|:-:|:-:|:-:|---|
| `intelligence:view` | x | x | x | x | all reads of workspace-shared, ceiling-gated data |
| `intelligence:generate` | | x | x | x | analyze, legacy generate |
| `operations:view` | | x | x | x | Guest/Stay reads, signal context, import batch read |
| `operations:manage` | | x | x | x | Signal/Guest/Stay/Conversation/Message writes |
| `decision:propose` | | x | x | x | propose, legacy Decision create |
| `decision:review` | | | x | x | approve/reject, legacy PATCH, Action/Outcome reads |
| `workspace:admin` | | | | x | Property/Unit writes, all deletes, knowledge management, imports, learning, retrieval debug, workspace PATCH/DELETE |
| `action:execute` | | | | | **nobody** - gates Action/Outcome writes (denied for all) |
| `outcome:record` | - | - | - | - | **does not exist** |

Function-level findings: no GET/POST asymmetry, no collection-vs-object gap, no unprotected PATCH/DELETE, no
admin-only function reachable by a lower role, no alternate route name (24 swap/unknown-path probes -> 404, `MS*`).
Two notes: (a) `PATCH /api/workspaces/:id` lets an admin set `status: suspended` on their **own** workspace, which locks out
every member including themselves until fixed in the database (finding M4); (b) `GET /api/workspaces/:id` uses
`intelligence:view` (any member) - intended.

---

## 4. BOLA / object-level authorization

Every route with a caller-supplied id was traced to its lookup. Pattern in the code base: the workspace named by the
caller is only a **selector**, validated against the caller's ACTIVE membership; controllers use `req.actor.workspaceId`;
services resolve the object **inside that workspace** (`findInWorkspaceOr404` = `{_id, workspaceId}` **at** lookup).
Result: another tenant's object returns the **same 404** as a missing one.

| Route family | Where authorization happens | Notes |
|---|---|---|
| Property, Guest, Stay, Signal, Conversation, ImportBatch, KnowledgeDocument, Decision, Action/Outcome (reads) | AT lookup (`{_id, workspaceId}`) | Decision/Action/Outcome/Intelligence additionally require the **live parent Intelligence** to be visible at the caller's ceiling |
| Unit | AT lookup through parent Property `{workspaceId}` | Unit has no workspaceId by design |
| Message | Conversation resolved in workspace BEFORE messages are touched; `getMessageById` resolves through the Conversation | no per-message route exists |
| KnowledgeChunk | parent KnowledgeDocument AT lookup, then chunk visibility filter | vectors never selected |
| Signal-derived routes (analyze, legacy generate, retrieval, context, dashboard) | signal scoped lookup BEFORE any AI/embedding call | verified: a foreign/fake id is 404 before the AI client is reachable |
| Learning | no caller id; aggregation filtered by `workspaceId = actor` | |
| Action / Outcome writes | denied BEFORE lookup for every role | service-level checks (findById then `assertSameWorkspace`) exist but are unreachable over HTTP |

Findings:
- **B1 (Low) existence oracle on body/query references.** Stay/Signal/Conversation/KnowledgeDocument/legacy-Decision
  creation validate a *referenced* id with `findByIdOr404` (unscoped) and only **then** `assertSameWorkspace`. A foreign id
  yields `400 "... does not belong to the given workspace"` while a nonexistent id yields `404`. An authorized caller can
  therefore learn that a given ObjectId exists in some other tenant. ObjectIds are not guessable and nothing else leaks,
  so exploitability is very low; it is the pattern OWASP flags ("authorization AFTER lookup"). Known issue 6.
- **B2 (Info)** `updateWorkspace/deleteWorkspace` use `req.params.id`; it equals the membership-verified workspace (the
  selector for these routes is the path), so it is safe today; using `req.actor.workspaceId` would remove the dependency.
- No route was found that trusts `body.workspaceId`, `query.workspaceId` or an object's own `workspaceId` supplied by the
  caller as authority.

---

## 5. Property-level authorization / mass assignment

Probed against a throwaway workspace (observation script `p19-probe`, results below; nothing was changed).

| Resource | Allowed client fields | Server-controlled | Immutable | Observed with junk fields |
|---|---|---|---|---|
| Guest | names, contact, externalId, preferences, metadata | `_id`, `workspaceId` (actor), timestamps, `__v` | workspaceId | `_id`, `createdAt`, `__v`, `role`, `permissions`, `isAdmin`, `createdBy`, `ownerUserId` **ignored** (strict schema); PATCH `_id`/`createdAt` ignored; body `workspaceId` of another tenant -> 400 |
| Property / Unit / Signal / Stay | explicit UPDATABLE lists | same | workspaceId, guestId/propertyId on Stay | ignored / 400 |
| Conversation | title, status, userId, guestId, stayId, signalIds | `_id`, `workspaceId`, timestamps | workspaceId | `_id`/`createdAt` ignored; `userId` and `status` accepted (non-authoritative) |
| Message | role, type, content, metadata | `conversationId` (path), `_id`, timestamps | conversationId | `conversationId`/`createdAt` ignored; **`role: assistant`, `type: intelligence`, `metadata.koiIntelligence` accepted** (finding M2) |
| Workspace (admin) | name, slug, status, settings | `_id`, timestamps | - | `status` self-suspend accepted (M4) |
| Legacy Decision | description, type, priority, status (status needs `decision:review` to be non-default) | approval metadata, V1 fields | decisionVersion, analysis*, provenance | `provider`/`model`/`analysisLevel`/`knowledgeVisibility`/`reviewedAt` -> 400 (V1-owned) |
| Membership / roles / permissions / knowledge level | **not writable through any route** | | | no endpoint exists |

A field being ignored is acceptable; **no field silently overrides server authority**. Operator-syntax injection was
probed on query strings (`email[$regex]`, `status[$ne]`: Express 5's simple query parser makes them inert keys) and JSON
bodies (`{"$ne": null}` for guestId/type/email: 400 cast/validation). Prototype-pollution keys are refused (400).

---

## 6. Response / data exposure

| Item | Result |
|---|---|
| Roles, permissions, membership internals, tokens, issuer/subject in responses | none found (asserted `PR*`, Phase 15-18 suites) |
| Provider/model, guest/stay ids, provenance internals in raw Intelligence | removed in Phase 14 (whitelist view) |
| Embedding vectors | never selected in chunk reads (Phase 14); verified |
| Guest/Stay PII to viewers | 403 on Guest/Stay reads; denials and cross-tenant 404s carry no PII (Phase 15) |
| Hidden Intelligence / knowledge | filtered at the role ceiling incl. parent-visibility for Decision/Action/Outcome |
| Another tenant's workspace data | none; workspace list returns only own memberships |
| **Stack traces and absolute file paths in errors** | **YES in non-production** (finding H1) |
| Database error text | `Cast to string failed ... at path "x"` (schema path + value) and Mongo/BSON messages on 500 in non-production (finding L2) |

- **H1 (High when misconfigured / Medium by default)** `errorHandler` adds `err.stack` to **every** error response unless
  `NODE_ENV=production` (`ER1`: a 401 body carries a multi-line stack with absolute paths such as `C:\Users\...`).
  `NODE_ENV` defaults to `development`, so an unset variable in a deployment fails **open**. In production mode the stack
  is absent (`ER2`) and 5xx messages are masked. Recommendation: fail closed (omit stack unless an explicit dev flag).
- **L2** unhandled deep-nesting: a message `metadata` nested ~200 levels deep (within the 100 KB body cap) is a 500 whose
  message is a MongoDB BSON error in non-production (masked in production). Any operator can trigger it; impact is one failed
  request, no state change.

---

## 7. Resource-consumption audit

| Resource | State | Detail |
|---|---|---|
| List page size | BOUNDED | default 20, max 100 (messages 200); invalid -> default; huge page -> empty |
| JSON request body | BOUNDED | 100 KB (`express.json()` default), 413 above (`ER7`); parsed before authentication (bounded) |
| String / array limits per field | **UNBOUNDED per field, bounded per request** | message content 95 KB accepted; metadata 90 KB accepted; `settings` 50 KB accepted; `signalIds` up to ~3.8k entries fit the body cap (validated -> 404 in 25 ms) |
| Number of records a member can create | **UNBOUNDED** | no per-actor or per-workspace quota, no rate limiting (Guests, Signals, Conversations, Messages ...) |
| Uploads (knowledge, import) | BOUNDED size | 10 MB memory storage, `.csv` filter for imports; authenticated **before** parsing |
| Import rows | **UNKNOWN/UNBOUNDED by count** | bounded by 10 MB; per-row DB round-trips run synchronously in the request; diagnostics capped at 1,000 |
| Knowledge document text | BOUNDED | extracted text <= 500,000 chars; chunks <= 2,000 chars; up to ~250 chunks per document per embed call |
| Guest name search | BOUNDED | literal match, <= 100 chars (Phase 17) |
| Other regex/search | none | no other user-controlled regex found |
| Expensive queries | BOUNDED by workspace | Learning/patterns aggregations are workspace-scoped and admin-only; `Unit` list resolves the workspace's property ids first |
| External HTTP | BOUNDED per call | single sink `postToAiService` with an abort timeout; no retries; OpenAI branch `maxRetries: 0` |
| AI calls | authorization-gated, **not rate-limited** | see section 8 |
| HTTP server timeouts / TLS / security headers | not configured | no `helmet`, `X-Powered-By` present (finding L1) |

- **M3 (Medium, availability/cost)** with no rate limiting or quotas, any authenticated member with `operations:manage`
  can create unbounded rows, and any member with `intelligence:generate` can repeatedly trigger paid AI calls. Not
  cross-tenant; requires a valid identity.

---

## 8. AI / external-service boundary

Single external sink: `services/ai/aiServiceClient.js#postToAiService` -> `AI_SERVICE_URL` (Python service, which owns
Gemini). Node has no other outbound HTTP except the optional OpenAI branch (`LLM_PROVIDER=openai`, `llmProvider.js`).

| HTTP route | Controller -> service | External call | Authorized BEFORE the call? |
|---|---|---|---|
| `POST /api/intelligence/analyze/:signalId` | analyzeSignal -> intelligenceAnalysisService | retrieval (embedding) + analysis (Gemini) | yes: authenticate, membership, `intelligence:generate`, then signal scoped lookup (404 before any call) |
| `POST /api/signals/:id/intelligence` (LEGACY) | generateSignalIntelligence -> ai/intelligenceService | retrieval + generation | yes (same chain) |
| `GET /api/signals/:id/knowledge-retrieval` (DEBUG) | retrieveKnowledgeForSignal | embedding | yes: `workspace:admin` first |
| `POST /api/knowledge-documents` | create -> auto chunk + `embedKnowledgeDocument` | embeddings | yes: `workspace:admin` |
| `POST /api/knowledge-documents/upload` | upload -> chunk + embed | embeddings | yes: authenticate BEFORE parsing, then `workspace:admin` |
| `POST /api/knowledge-documents/:id/embeddings` | embedKnowledgeDocument | embeddings | yes: `workspace:admin`, document scoped lookup |

Probing all 6 with permitted roles used non-existent ids, so each returned 404/400 **before** any external call. No
tool execution, URL fetching, vector DB or agent framework exists. Generation is user-triggered only (no polling, no
background job). No retries. Gap: none of these is rate-limited or quota-limited (M3).

---

## 9. Legacy / dead endpoint map

| Endpoint | Class | Note |
|---|---|---|
| `POST /api/decisions`, `PATCH /api/decisions/:id` | LEGACY - retirement candidate | pre-V1 records only; authenticated (Phase 16); no frontend consumer; still used (via fixtures/admin tokens) by several validation suites |
| `POST /api/signals/:id/intelligence` | LEGACY - retirement candidate | old Generate page is the only frontend consumer |
| `GET /api/signals/:id/knowledge-retrieval` | DEBUG/DEV - retirement candidate | admin-only; spends embedding budget; no frontend consumer |
| `POST/PATCH /api/actions`, `POST/PATCH /api/outcomes` | BLOCKED (kept for a future execution design) | denied to every role; suites use in-process fixtures |
| `GET /api/actions`, `/outcomes` (+ `/:id`) | ACTIVE (reviewer/admin) | no frontend consumer (only via Learning) |
| `POST /api/intelligence` | RETIRED (404) | Phase 14 |
| `POST /api/workspaces` | RETIRED (404) | Phase 16; bootstrap by `scripts/create-dev-workspace.mjs` |
| Frontend-unused but ACTIVE | `/workspaces*`, `/intelligence*` (raw + analyze), `/knowledge-documents*`, `/imports*`, decision propose/approve/reject | API-first surface used by suites/operators |
| Unknown / unused CRUD | none found | |
| Stale comment | `knowledgeDocumentRoutes.js` still says the chunk GET "returns each chunk's embedding" (untrue since Phase 14) | documentation drift only |

---

## 10. Test-coverage matrix

What each suite actually PROVES (not counts). COVERED = an executable assertion exists; PARTIAL = covered for some
routes/cases only.

| Security property | Proven by | Status |
|---|---|---|
| Route inventory is complete and chains are as audited | `validate-phase19-route-inventory` (INV*, CH*) | COVERED (new) |
| Authentication on every route (no/invalid/unregistered/disabled/revoked/non-member) | phase19 (all 72), identity, phase13-18 | COVERED |
| Function-level authorization = role map for every route x role | phase19 (`FN*`), decision-authorization, phase15-18 | COVERED |
| Method swapping / alternate paths | phase16/17/18 (`MS*`), phase19 | COVERED |
| BOLA / cross-workspace (read, write, delete, id-swap, selector spoofing) | phase14 (raw reads), 15 (5 resources), 16 (workspace/decision/action/outcome/learning), 17 (writes), 18 (conversation/message), security-boundary | COVERED for every resource family; **PARTIAL** for KnowledgeDocument PATCH/DELETE/embed and Import upload cross-tenant (phase13 covers upload/import/knowledge management and admin isolation; per-verb BOLA matrix is lighter) |
| Header/query/body/token-claim spoofing | phase13-18 (`FG*`/`SP*`) | COVERED |
| Mass assignment / property-level | Guest/Stay/Signal refs (phase15), V1-owned fields (decision suites), messages (phase18); **junk-field observation only in this audit** | **PARTIAL** - no regression suite asserts `_id`/`createdAt`/`role` are ignored across all resources |
| Response sanitization | phase14 (Intelligence whitelist, no vectors), phase15 (PII), phase16/18 (no internals), dashboard suites | COVERED; error-shape (stack) only asserted in phase19 |
| Resource limits | phase17 (name search), phase18 (message/page limits), phase19 (JSON body cap) | PARTIAL - no assertion for import row volume, per-field sizes, quotas |
| Parent-visibility (Decision/Action/Outcome) | decision-v1/-authorization, phase16 | COVERED |
| AI never reached without authorization | phase13 (trap server), phase19 (fake-id probes) | COVERED |
| Production-mode behavior (no stack, stub refused) | phase19 (`ER2`, `ER3`) | COVERED (new) |
| Intelligence persistence path | `validate-intelligence-persistence` | **STALE / NOT COVERED** (asserts the removed raw-read fields; leaks records; intentionally not run) |
| Rate limiting, real IdP, TLS, security headers | - | NOT COVERED (not implemented) |

---

## 11. Assessment of the nine known issues

| # | Issue | Verified facts | Security | Data integrity | Availability | Compat. risk | Recommended phase |
|---|---|---|---|---|---|---|---|
| 1 | Conversation delete does not cascade | **Confirmed in real data: 2 of the 12 Messages have no Conversation.** Unreachable via API (reads go through the Conversation) | Low: retained content survives "deletion" (retention/compliance) | Medium: orphaned rows | Low | Low (delete + `deleteMany`) | Phase 20 (with 2) |
| 2 | Workspace delete does not cascade | `deleteWorkspace` removes only the Workspace; memberships and ALL tenant data (PII, knowledge, conversations) remain; nothing can reach them (membership 404) | **Medium**: deleted tenants' PII is retained and unreachable | High: orphans | Low | Medium: needs a cascade order or a soft-delete/status design | Phase 20/21 (design first) |
| 3 | Viewers can read shared Conversations that may discuss Guest/Stay data | Real data: 0 of 12 messages mention a real Guest name/phone/email; conversations carry no Guest/Stay links; but nothing prevents future content | Low-Medium: policy decision (workspace-shared) documented in Phase 18 | - | - | Medium if restricted | Product decision; revisit with the frontend Guest-linked chat |
| 4 | Operators can persist assistant/system messages | Confirmed: `role: assistant`, `type: intelligence`, `metadata.koiIntelligence` are stored and rendered as an AI intelligence card | **Medium**: an operator can forge "AI-generated" analysis visible to viewers/reviewers | Medium (provenance of chat content) | - | Medium: the UI persists its own intelligence messages through the same endpoint | Phase 20 (server-issued assistant messages or a signed/marked origin) |
| 5 | No message content/metadata size limit | Bounded **per request** by the 100 KB body cap (95 KB content accepted); not per field; **no count quota** | Low | Low | Medium: storage growth by any operator; ~200-level nesting -> 500 (L2) | Low | Phase 20 (field limits, depth guard) + rate limiting phase |
| 6 | Cross-workspace body ids return an existence-revealing 400 | Confirmed (B1) | Low | - | - | Medium: existing suites assert the 400 | Phase 21 (return the same 404, scope the lookup) |
| 7 | `validate-intelligence-persistence` is stale | Reads removed fields from the raw GET; leaks records | - | Low | - | Low | Phase 20 (rewrite to read via DB / dashboard) |
| 8 | No rate limiting | Confirmed; no limiter, no quota; AI and record-creation routes unmetered | Medium (credential/abuse amplification, cost) | - | **Medium-High** | Low | Phase 21 (per-actor + per-workspace, AI routes first) |
| 9 | No real identity provider | Production refuses the stub verifier (`ER3`) => authenticated routes cannot work in production today | High as a **launch blocker**; the dev stub is safe only in development | - | - | High | Phase 22 (OIDC verifier behind the existing `tokenVerifier` seam) |

---

## 12. Findings by severity

**Critical: none.** No unauthenticated access, no cross-tenant read/write, no privilege escalation, no way to obtain
`action:execute`, no route trusting a caller-supplied workspace/role/level was found.

**High**
- **H1** Stack traces + absolute paths in every non-production error; `NODE_ENV` defaults to development, so a deployment
  that forgets to set it leaks internals (sections 6, `ER1`). Not exploitable for access; exposes code layout for further attacks.
- **H2** No production identity verifier: the only verifier is the development stub, refused in production. A launch blocker, not a vulnerability (section 2).

**Medium**
- **M1** No rate limiting / quotas anywhere, including paid AI routes and record creation (known issue 8).
- **M2** Operators can forge assistant/`intelligence` messages that the UI renders as AI output (known issue 4).
- **M3** Unbounded record creation and paid-AI invocation by any member with the relevant permission (section 7).
- **M4** An admin can suspend their own workspace (`PATCH status`), locking every member out until repaired in the database; workspace `settings` is free-form (50 KB accepted).
- **M5** Workspace delete leaves all tenant data and memberships behind (known issue 2).

**Low**
- **L1** No security headers (`helmet`), `X-Powered-By: Express` present, no HTTP timeouts configured; single-origin CORS with `credentials: true` (no cookies are used).
- **L2** Deeply nested `metadata` produces a 500 with a database error message in non-production; cast errors echo schema paths/values.
- **L3** Existence oracle on cross-workspace body references (400 vs 404) (B1).
- **L4** Conversation delete leaves orphaned Messages (2 real orphans) (known issue 1).
- **L5** Import volume is bounded only by the 10 MB file size with synchronous per-row DB work.
- **L6** Unauthenticated 100 KB JSON bodies are parsed before the authentication check.

**Informational**
- Working tree: all Phase 9-18 security work (~80 modified + many new files) is uncommitted at `d94287f`; a lost working tree loses the security model.
- `updateWorkspace/deleteWorkspace` use the path id rather than `req.actor.workspaceId` (equal by construction).
- `knowledgeDocumentRoutes.js` comment about chunk embeddings is stale.
- `validate-intelligence-persistence` is stale (known issue 7). All 32 real Actions/Outcomes reference no existing Intelligence (orphans) and are invisible to reviewers by design.

---

## 13. Recommended remediation order

1. **Phase 20 - fail-closed error handling and message integrity**: omit stack/DB detail unless an explicit dev flag (H1, L2); server-side limits for message/metadata size and nesting depth; stop operators forging assistant/`intelligence` messages (M2); cascade Message delete with Conversation delete (L4/known 1); replace `validate-intelligence-persistence`.
2. **Phase 21 - abuse resistance**: rate limits and quotas per actor and per workspace, AI routes first (M1/M3); import row-count/time budget (L5); security headers/timeouts (L1); scope reference lookups so a foreign id is a 404 (L3/B1).
3. **Phase 22 - workspace lifecycle**: workspace delete design (soft-delete + cascade or retention policy) (M5); guard against self-suspension/last-admin lockout (M4).
4. **Phase 23 - identity**: real OIDC verifier through the existing `tokenVerifier` seam (H2), keeping the role map server-side.
5. **Then**: retire LEGACY/DEBUG routes (legacy Decision, legacy generate, knowledge-retrieval) once suites use fixtures; per-verb BOLA regression suites for knowledge PATCH/DELETE/embed.

Nothing in this list requires changing the permission model.

---

## 14. Phase 20 remediation addendum

| Finding | Status after Phase 20 |
|---|---|
| H1 stack traces / paths in errors | **FIXED**: one error handler; message is authored (AppError) or a fixed generic string; `debug` (name/message/stack) only with `KOI_EXPOSE_ERROR_DETAILS=true` AND not production; omitted = hidden; the 404 no longer reflects the URL |
| L2 deeply nested metadata -> 500 | **FIXED**: bounded-JSON validation (depth/keys/array/string/bytes) returns a clean 400 before MongoDB |
| M2 forged assistant/intelligence messages | **FIXED**: a browser may create only `role: user`, `type: text` messages without `metadata.koiIntelligence`; assistant/system/intelligence are server-owned (`createServerMessage`, no HTTP route). UI consequence: the locally generated mock reply is no longer persisted in backend mode |
| Known 5 message limits | **FIXED** per field (content 8,000; metadata 4 KB/depth 4/20 keys/50 items/1,000-char strings; conversation title 200, `userId` 200, `signalIds` 100) |
| L4 / known 1 conversation delete orphans messages | **FIXED**: messages are deleted first, then the conversation (transaction when a replica set is available). The 2 pre-existing orphan messages in the real data were NOT touched |
| Known 7 stale persistence suite | **FIXED**: asserts the sanitized contract; leaves no records |
| H2, M1, M3, M4, M5, L1, L3, L5, L6 | unchanged (later phases) |
