# Intelligence V1 - the single canonical path (Phase 24)

Scope: make the grounded V1 analysis the ONE intelligence-generation path, harden what it sends to the model (data minimization) and what it
returns (one sanitized public representation). No retrieval, context, agent, Action/Outcome or authentication-provider change.
Starting point: `EOI_INTELLIGENCE_AUDIT_PHASE23_5.md`.

## 1. The canonical endpoint

```
POST /api/intelligence/analyze/:signalId      (the only generation route)
```

Chain (unchanged from Phases 9-23): bearer token -> `authenticate` -> `User` -> active workspace membership (`workspaceId` is only a
selector; a non-member gets 404) -> `requirePermission("intelligence:generate")` (server-side role map: operator, reviewer, admin) -> per-identity and
per-workspace AI rate limit -> controller uses `req.actor.workspaceId` and the role's knowledge ceiling
(`getAuthorizedKnowledgeLevel`, never a request field).

Flow (`services/intelligenceAnalysisService.js::analyzeSignal`), all after authorization:

```
Signal (workspace-scoped lookup, 404 otherwise)
 -> existing analysis for (workspace, Signal, level)?  yes: return it (200), no model call
 -> buildAnalysisContext            deterministic, workspace-scoped, guest personal data removed (section 4)
 -> retrieveKnowledgeOrThrow        workspace + visibility + scope filtered in the MongoDB query, then Python scoring, then Node re-verification
 -> ai-service POST /v1/intelligence/analyze     (its own LLM_PROVIDER: test | gemini)
 -> validateAnalysisResult          closed schema; cited chunk ids must be a subset of Node's retrieved chunks
 -> createAnalysisIntelligence      stored with analysisVersion / analysisLevel / knowledgeVisibility / provenance built by Node
 -> toIntelligenceView              the public representation (section 3)
```

`201` = created, `200` = the stored analysis for that (Signal, level) was returned. `LLM_PROVIDER` other than `gemini` / `test-python`
(including the former Node-level `openai` and `test`) answers `503`: there is no ungrounded fallback generator.

## 2. Legacy route treatment: retired

`POST /api/signals/:id/intelligence` no longer exists (404, like any unknown path). Evidence that nothing needed it:

| Caller | Was | Now |
|---|---|---|
| Frontend `useSignalIntelligence` -> `koiApi.generateSignalIntelligence` | the only UI caller | switched to `koiApi.analyzeSignal` (`/intelligence/analyze/:signalId`); the old function and endpoint constant are removed |
| Backend validation suites (Phases 5, 6H, 7F-C, 13, 19, 21, security boundary, upload ingestion, visibility, V1 analysis API) | called the legacy route | migrated to the canonical route (fixtures/assertions updated to the sanitized contract) or, where the check WAS "the legacy route works", replaced with "the legacy route is 404 and reaches nothing" |
| `validate-intelligence.mjs` (Phase 4) | tested the Node-level `test`/`openai` generator and its `__testScenario` hooks | deleted with that generator (superseded by `validate-phase24-canonical-intelligence.mjs` and the V1 suites) |

Removed with it (no second engine is kept, not even as a wrapper): `services/ai/llmProvider.js`, `intelligencePrompt.js`, `intelligenceSchema.js`
(the legacy response validator) and the legacy generator in `services/ai/intelligenceService.js`, and `requestIntelligenceFromAiService` in the AI client. That
file now holds only the two helpers V1 shares (`PYTHON_ROUTED_PROVIDERS`, `retrieveKnowledgeOrThrow`).
Kept on purpose: `createGeneratedIntelligence` in `services/intelligenceService.js` (a persistence function used by test fixtures to write pre-V1-shaped
records - no generation logic) and the pre-V1 records already in the database, which stay readable through the same sanitized view.
Not changed (out of scope, flagged): the ai-service still contains the pre-V1 endpoint `POST /v1/intelligence/signal` and its tests. **Nothing in Node calls it any more**; it
accepts whatever context a caller sends, so it must never be handed guest contact details. Removing it is a separate cleanup.

## 3. Public response contract

POST (201/200) and `GET /api/intelligence/:id` return the **same** object, produced by the one function `toIntelligenceView` (Phase 14 whitelist). It carries:

`_id, workspaceId, signalIds, propertyId, conversationId, generatedBy, analysisVersion, analysisLevel, knowledgeVisibility, analysis{situation, evidence[], impact, recommendation, confidence},
knowledgeProvenance[{chunkId, section, sectionPath, visibility, retrievalScore}], signal, context, intelligence, risk, decision, action, outcome, confidence, createdAt, updatedAt`
(the legacy content blocks are the Phase 14 whitelist as it stands; no field was added).

Never returned: `provider`, `model`, `guestId`, `stayId`, `knowledgeDocumentId`, `documentId`, `similarityScore`, `chunkIndex`, `scope`, `version`, embeddings, prompts, `__v`.
The stored record keeps provider, model and the full provenance for audit (readable only from the database).
Change made: the controller now applies `toIntelligenceView` to the service result (previously it returned the raw stored record).

## 4. PII minimization (model context)

`services/analysisContextService.js::sanitizeAnalysisContext` is now an **allowlist** for the guest (it was a denylist of six field names): a field added to the guest
context in the future is withheld from the model by default.

| Guest field in the assembled context | Class | Reaches the model? |
|---|---|---|
| `id` | REQUIRED (link to the stored record; opaque) | yes |
| `available` | REQUIRED (whether the reference resolved inside the workspace) | yes |
| `recentStays` (stay id, reservation id, dates, status, unit, adults/children, source) | REQUIRED/USEFUL operational facts | yes |
| `firstName`, `lastName` | UNNECESSARY (the analysis reasons about "the guest") | **no** |
| `email`, `phone` | UNNECESSARY / REMOVE (no documented, tested business need) | **no** |
| `externalId`, `preferences`, `metadata` | not assembled into the context at all | no |

Kept deliberately: the guest-stay relationship, stay dates/status, historical Signals (id, type, severity, status, title, time, how matched). Residual (documented, not altered):
free text staff type into a Signal's `title`/`description` is recorded operational fact and is passed as written.
The stored Guest is untouched; minimization happens only at the model boundary. The legacy path that sent name/email/phone no longer exists.

## 5. Operational context boundary (unchanged)

Deterministic and workspace-scoped: Signal, Guest (+ recent stays), Stay, Property, Unit, <=20 related Signals. Every lookup carries the workspace
(Unit via its Property). A reference that does not resolve inside the workspace becomes `available:false` with no stay history: a Signal of workspace A whose
guest/stay ids point into workspace B still analyzes, but nothing of B's records reaches the model (tested). Previous Intelligence/Decisions/Actions/Outcomes are not added.

## 6. Knowledge retrieval boundary (unchanged)

The algorithm, top-k, thresholds and providers are untouched. Verified: candidates are selected in MongoDB by workspace, status, visibility ceiling of the actor's
role, scope and effective window before any scoring; Python applies a second visibility filter; Node re-verifies the result. Workspace B's chunks were never a
candidate; an operator (staff ceiling) never sent or received restricted knowledge; an admin received its own restricted knowledge only.

## 7. Security invariants (each has a check in `validate-phase24-canonical-intelligence.mjs`)

1. Authorization precedes protected reads: denied requests (401/403/404) cause **zero** AI-service calls and create no record.
2. The effective workspace is derived from the verified membership; body, query, header and token-claim values naming another workspace, role, permission or knowledge level have no effect.
3. A foreign Signal id is 404 before any context or retrieval.
4. The knowledge level is the role's ceiling; the dev fallback level is never applied to an authenticated caller.
5. The model request contains only `context`, `knowledge`, `authorizedLevel` - no token, secret, workspace id or actor.
6. No guest email/phone/name and nothing of another workspace reaches the model; the response exposes no internal field.
7. The response schema is closed and provenance is Node-derived and limited to chunks Node retrieved: the model is never an authorization boundary.
8. The AI-service URL is loopback in tests; `NODE_ENV=test` refuses any other.

## 8. Frontend

`services/api.js`: `analyzeSignal` -> `POST /intelligence/analyze/:signalId` (authenticated, 30 s timeout; the client sends no role/level). `useSignalIntelligence` maps the public view
(`intelligenceMapping.js`) and keeps the states `idle | loading | ready | unconfigured (503) | forbidden (403) | error`; generation is still only on an explicit click. `SignalIntelligencePage` renders the result with
the dashboard's `AnalysisBlock`, `RecommendationBlock` and `ProvenanceList` (no provider/model/percentage confidence, which the API no longer returns); the old `IntelligenceProvenance` component was removed and the
"Regenerate" button dropped (the server returns the stored analysis for the same Signal and level, so it would not regenerate).
`npm run build` passes.

## 9. Test evidence

### 9.1 Automated (all with the TEST stack: ai-service LLM/EMBEDDING = test, empty key; backend NODE_ENV=test; no real provider)

* New: `scripts/validate-phase24-canonical-intelligence.mjs` - **60 passed, 0 failed** (authorization matrix incl. disabled user / non-member / foreign workspace, PII markers `TEST_GUEST_EMAIL_123` / `TEST_GUEST_PHONE_456` / name markers absent from every captured request,
  POST == GET public view, forbidden keys absent, foreign guest/stay/property/signal/knowledge absent, forged workspace/role/level via query + headers + body + token claims ineffective, legacy route 404, method swapping 404, counts back to baseline). It uses a recording proxy in front of the test ai-service and refuses `PYTHON_BASE` on :8000.
* The suite was **mutation-checked**: with the guest allowlist disabled the B checks fail (5 failures); with the controller returning the raw record the C checks fail (4 failures); both changes were reverted.
* Full backend sweep of every `scripts/validate-*.mjs`: 46 suites, 0 failures. Highlights: Phase 13 (196), 14 (345), 15 (443), 16 (273), 17 (197), 18 (232), 19 (902), 20 (207), 21 (248), 22 (89), 23 (137) + frontend OIDC (27), security boundary (83), V1 analysis unit/API (135 / 81), persistence (64), grounding (46), visibility (144), upload ingestion (158), ai-service delegation (24), dashboard (78/65/74), decision (42/145/130), identity (109).
  `validate-dev-token` needs an explicit `NODE_ENV` (it does not load `.env`): it fails without one and passes (14/14) with `NODE_ENV=development` (unrelated to this phase).
* Stale legacy assertions were updated only where the new behavior is the intended Phase 24 contract (legacy route = 404, sanitized POST body, provenance internals read from the stored record, V1 is idempotent per (Signal, level), V1 Decisions go through propose/approve).
* `ai-service` pytest with forced test providers: **221 passed**. Frontend `npm run build`: passes.

### 9.2 Offline runtime capture (throwaway workspaces, test providers, recording proxy)

| Captured | Observation |
|---|---|
| Incoming signal | maintenance / high / "AC not cooling in 301", with a linked guest (name, e-mail, phone markers) and stay |
| Operational context (in the model request) | signal, property, unit, stay (dates/status), 1 related signal; guest = `{id, available:true, recentStays[1]}` only |
| Knowledge context | retrieval request: query text from the signal, 1 candidate (unit scope, staff); the foreign workspace's near-identical SOP was never a candidate; response model `deterministic-embedding-v1` |
| Exact model request | `{context, knowledge[1], authorizedLevel:"staff"}`; no PII marker, no foreign marker (checked over the raw bytes of both ai-service requests, case-insensitively) |
| Generated response | deterministic stub text (`[DETERMINISTIC TEST ANALYSIS]`), confidence `medium`, the one retrieved chunk cited |
| Persisted Intelligence | `intelligence-v1`, level/visibility `staff`, provider `test` / model `deterministic-stub`, full provenance (document id, similarity...) kept on the stored record |
| Returned API response | 201; no forbidden key; provenance keys = chunkId, section, sectionPath, visibility, retrievalScore; identical to the GET representation |
| Denied paths | operator analyzing a foreign-workspace signal -> 404; legacy route -> 404 |
| Database | counts identical before and after the run |

### 9.3 Database baseline

Before and after (final): User 1, WorkspaceMembership 1, Workspace 1, Property 2, Unit 21, Guest 10, Stay 10, Signal 3, Intelligence 1, KnowledgeDocument 1, KnowledgeChunk 22, ImportBatch 1, Conversation 3, Message 12
(the two pre-existing orphan Messages untouched), Decision 33, Action 32, Outcome 32.
Note: the legacy suites that use `lib/authFetch.mjs` create stub users/memberships they cannot delete themselves (by design they are swept later by `sweepStaleAuthFixtures`, which only removes those older than 15 minutes); after the full sweep 77 such users and 66 memberships remained
and were removed with that same sweep function (exact prefixes `authfetch-` / `vis-nonadmin-`), restoring the baseline.

## 10. Known limits after this phase (not addressed here)

* The ai-service still exposes the pre-V1 `/v1/intelligence/signal` endpoint (uncalled).
* `CLAUDE.md` still describes `llmProvider.js` / the legacy route / Phase 4-5 routing; it should be updated to this phase.
* Retrieval quality, richer context, referential evidence, the Action/Outcome loop and any agent are unchanged and belong to later phases (see the Phase 23.5 audit).
