# EOI Intelligence Engine - Audit & Completion Plan (Phase 23.5)

Date: 2026-09-28 - HEAD `d94287f` (all Phase 9-23 work is uncommitted) - Audit only: **no application source was changed**.

Method: full read of the intelligence pipeline on both sides (Node + Python), repository-wide search for agent/tool/orchestration constructs, and one
**runtime verification with test providers only** (a throwaway two-workspace fixture, a recording proxy between Node and ai-service, exact
request/response capture, DB counts before/after). Statements below are tagged **[code]** (read from source), **[runtime]** (observed in the run in section 11),
or **[not verified]**. Nothing was executed against a real LLM or a real embedding provider, so the *quality* of real model output and of real embeddings is **not verified**.

Vocabulary used in the matrix: **IMPLEMENTED** (real, working, exercised), **PARTIAL** (real but limited, or works only on part of the path),
**SCAFFOLDING** (structure/fields/routes exist but nothing meaningful populates or consumes them), **MISSING** (does not exist).

---

## 1. Executive Summary

EOI today is a **correctly secured, single-shot RAG generator with human-gated Decisions** - not yet an operational-intelligence *loop*.

What genuinely works end to end (runtime-verified with test providers):

```
Signal -> deterministic context (Signal/Guest/Stay/Property/Unit/<=20 related Signals)
       -> deterministic, workspace- and visibility-scoped knowledge candidates (Mongo)
       -> query embedding + cosine similarity + scope boost (Python, in memory) -> top 5
       -> ONE LLM generation call over (sanitized context + retrieved knowledge)
       -> strict schema validation, provenance limited to chunks Node itself retrieved
       -> persisted Intelligence (analysisVersion, analysisLevel, knowledgeVisibility, knowledgeProvenance)
       -> human-proposed / human-reviewed Decision (text copied verbatim from the recommendation)
```

What does **not** exist:

* **No agent.** No orchestrator/planner, no tool calling, no model-chosen retrieval, no multi-step reasoning. One retrieval + one generation call, in a fixed order in code.
* **No feedback into intelligence.** Previous Intelligence, Decisions, Actions, Outcomes, conversations and learning patterns are **never** part of the LLM context (proven at runtime with marker strings). Action and Outcome creation is blocked for every role, so the back half of the loop cannot even be populated through the product.
* **The loop stops at "Decision (proposed/approved)".** Action / Outcome are storage schemas + admin-only read reports; Learning is a descriptive counting report, not a learner, and nothing reads it back.
* **The shipped UI does not use the V1 engine.** The frontend's "Generate" button calls the *legacy* `POST /signals/:id/intelligence` (`useSignalIntelligence.js`); `POST /intelligence/analyze/:signalId` (Intelligence V1, the grounded, provenance-validated one) has **no frontend caller**.

Headline gaps (details in section 13): retrieval has no relevance threshold and a silent 200-candidate cap; the retrieval query ignores everything except the Signal's own text; historical signals carry no resolution/outcome information; `evidence` is free text with no record references; the V1 generate response returns the raw stored record (provider/model/guest+stay ids/document ids/scores) while `GET /intelligence` is sanitized; the legacy path still sends guest PII to the model; the real Gemini paths are unexercised.

---

## 2. Current Architecture

```
React (legacy generate button)                       [no caller of V1 analyze]
   |  POST /signals/:id/intelligence  (legacy)   POST /intelligence/analyze/:signalId  (V1)
   v                                                  v
Node: authenticate -> workspace membership -> requirePermission(intelligence:generate, tier "ai" rate limit)
   |                                                  |
   | services/ai/intelligenceService.js               | services/intelligenceAnalysisService.js  (analyzeSignal)
   |   context = assembleSignalContext (UNSANITIZED)  |   context = sanitizeAnalysisContext(assembleSignalContext)
   |   retrieval (same service)                       |   retrieval (same service)
   v                                                  v
ai-service (FastAPI, no DB, no tenant concept)
   POST /v1/knowledge-retrieval  -> embed query, cosine x scope boost, top-k      (EMBEDDING_PROVIDER test|gemini)
   POST /v1/intelligence/signal  (legacy prompt)   POST /v1/intelligence/analyze (V1 prompt)   (LLM_PROVIDER test|gemini)
   v
Node: re-validate (intelligenceSchema.js / analysisSchema.js), attach provenance from Node's own retrieval, persist Intelligence
   v
MongoDB: Intelligence  ->  Decision (propose/approve/reject, human)  ->  Action / Outcome (blocked)  ->  Learning report (read-only counts)
```

Provider routing [code]: Node `LLM_PROVIDER` in `{gemini, test-python}` delegates to ai-service; `openai`/`test` stay in Node (legacy path only; V1 analyze returns 503 for them).
ai-service's own `LLM_PROVIDER` / `EMBEDDING_PROVIDER` (default `test`) decide whether the stub or Gemini executes. Provider selection is server-side only.

Two generation pipelines coexist:

| | Legacy `POST /signals/:id/intelligence` | V1 `POST /intelligence/analyze/:signalId` |
|---|---|---|
| Used by frontend | **yes** | **no** |
| Context sent to model | `assembleSignalContext` **unsanitized** (guest name/email/phone included) | `sanitizeAnalysisContext` (guest identifiers stripped) |
| Output shape | summary/findings/risk/decision/action/outcome/confidence(number)/provenance | situation/evidence/impact/recommendation/confidence(class)/usedKnowledgeChunkIds |
| Idempotent | no | yes, per (signal, analysisLevel) |
| Feeds Decision V1 | no (`proposeDecision` requires `analysisVersion=intelligence-v1`) | yes |

---

## 3. Operational Context Audit

Assembled by `services/signalContextService.js::assembleSignalContext` (all queries workspace-scoped; Unit via its Property), sanitized for V1 by `services/analysisContextService.js::sanitizeAnalysisContext`.

| Item | Status | Where | In LLM prompt? |
|---|---|---|---|
| Workspace (record: name, settings, timezone) | **MISSING** as context | only used as a scoping key | no |
| Property | IMPLEMENTED | `assembleSignalContext` -> `property {id,name,code,address,timezone,status}` | yes [runtime] |
| Unit | IMPLEMENTED | `unit {id,unitNumber,type,status,propertyId}` | yes [runtime] |
| Guest | PARTIAL | `guest {id,available,recentStays<=5}`; **V1 strips firstName/lastName/email/phone/name** | V1: id + recentStays only [runtime: "Zedmarker" / email absent from the rendered prompt]; **legacy: full PII sent** [code] |
| Stay | IMPLEMENTED | `stay {dates,status,adults,children,source,reservationId}` | yes [runtime] |
| Current Signal | IMPLEMENTED | `signal {type,source,severity,status,title,description,occurredAt,detectedAt,ids}` | yes [runtime] |
| Historical Signals | PARTIAL | `history.signals`: <=20, priority stay > guest > unit > property; **metadata only** (id,type,severity,status,title,occurredAt,matchedBy) - no description, no resolution, no linked Intelligence/Decision/Outcome | yes [runtime] |
| Previous Intelligence | **MISSING** | read only for idempotency (`findAnalysisIntelligence`) | **no** [runtime] |
| Decisions | **MISSING** | - | **no** [runtime: marker absent] |
| Actions | **MISSING** | - | **no** [runtime: marker absent] |
| Outcomes | **MISSING** | - | **no** [runtime: marker absent] |
| Conversations / messages | **MISSING** | the Chat feature is a separate mock (`chatService.js`) | no |
| Learning patterns (`patternService`) | **MISSING** as input | admin-only read report | no |

Observations [runtime]: history for a signal on Unit 302 included a Unit 301 AC signal (property-level match, `matchedBy:["property"]`) - useful for pattern spotting but also unrelated noise; there is no relevance ordering beyond the match-priority buckets and time. History includes every status (new/resolved/dismissed alike).

---

## 4. Business Knowledge / RAG Audit

| Arrow | Status | Detail |
|---|---|---|
| Document -> chunk | IMPLEMENTED | `knowledgeDocumentService` (manual/txt/md/pdf/docx via `documentExtractor`), `knowledgeChunkService` + `knowledge/knowledgeChunker.js`, section paths, corpus profiles; idempotent bulkWrite by (documentId, version, chunkIndex) |
| Chunk -> embedding | IMPLEMENTED (test provider verified; real provider **not verified**) | `knowledgeEmbeddingService` -> Python `/v1/embeddings`; embedding text = section path + text (`EMBEDDING_INPUT_VERSION 1`); batch 20; stores `embedding`, `embeddingModel`, `embeddingInputVersion` on the chunk. `test`: sha256-derived 32-dim vector (deterministic, **not semantic**). `gemini`: `gemini-embedding-001`, RETRIEVAL_DOCUMENT |
| Vector store | PARTIAL | vectors live as a plain array field in MongoDB `KnowledgeChunk`; **no vector index, no ANN, no vector DB** |
| Retrieval | PARTIAL | Node selects candidates (`selectCandidateChunks`), Python embeds the query and scores in memory |
| Retrieved -> LLM | IMPLEMENTED | top-5 chunk texts with chunkId/scope/document/version/section are placed in the "BUSINESS KNOWLEDGE" section |
| Provenance | IMPLEMENTED | Node stores its own retrieval results filtered by `usedKnowledgeChunkIds`; the validator rejects any id not in Node's retrieved set |

Retrieval mechanics [code, retrieval request captured at runtime]:

* Candidate filter (Mongo): `workspaceId`, `status: active`, `visibility ∈ allowedVisibilities(level)`, embedding present, scope `workspace` OR `property = signal.property` OR `unit = signal.unit`, effectiveFrom/To window; **sorted by `_id`, `limit 200`**.
* Query text = `[signal.type, title, description].join(". ")` (observed: `"maintenance. AC not cooling in 301. Warm air blowing from the unit; guest uncomfortable."`). Nothing from guest/stay/unit/history is used.
* Python: embed query, drop candidates above the level (second visibility check), cosine similarity x scope boost (unit 1.15 / property 1.08 / workspace 1.0), deterministic sort, **top-k = 5** (Node constant `TOP_K`).
* **No minimum-similarity threshold.** Observed: a workspace chunk with similarity -0.256 was still passed to the model and reported as "used" (with the test embedding this only proves plumbing; with real embeddings scores are usually positive, but the absence of a floor stands).
* **No embeddingModel filter.** Python guards only against a dimensionality mismatch (compares the first candidate's length); two models with equal dimension would be compared silently.
* **Candidate cap:** once a workspace has more than 200 eligible chunks, the remainder (highest `_id`) are never scored - arbitrary, not relevance-based.
* Hybrid/keyword search, re-ranking, query rewriting, knowledge-gap detection at generation time: **MISSING**.
* Chunk `text` reaches the LLM; knowledge scope, document id and version are shown to it. Similarity scores are not shown to it.

Visibility / isolation: `knowledge/visibility.js` (`guest < staff < restricted`, fail-closed). Ceiling comes from the actor's server-side role (viewer guest, operator/reviewer staff, admin restricted), never from the request.

---

## 5. Operational Data vs RAG Separation

**IMPLEMENTED and clean.** Operational facts come only from MongoDB entity queries (Signal/Guest/Stay/Property/Unit) and are rendered under `=== OPERATIONAL CONTEXT ===` (JSON). Business knowledge (SOP/policy/procedure) comes only from the RAG chain and is rendered under `=== BUSINESS KNOWLEDGE ===`. Neither is ever embedded into the other:

* Operational data is **not embedded, not vector-searched, not stored as knowledge**. Knowledge chunks contain no operational facts (documents are authored/uploaded content).
* The V1 system prompt (16 grounding rules) instructs the model that knowledge is *guidance, not an observed fact*, that missing operational facts must be stated as missing (not filled from policy), that conflicting chunks must be surfaced, and that cited chunk ids must be ones supplied and actually used.
* Enforcement is by instruction plus one hard check (cited ids ⊆ retrieved ids). "The model did not present a policy as an observed fact" is prompt-level only - **not machine-verified** and **not verified against a real model**.
* Storage side: derived intelligence references source records by id (`signalIds`, `propertyId`, `guestId`, `stayId`) and never overwrites them (CLAUDE.md principle upheld).

---

## 6. Agent / Orchestrator Audit

Search: no occurrence of agent frameworks, `tool_call`, `functionDeclarations`, LangChain/LangGraph, planner loops or model-selected tools anywhere in `backend/src` or `ai-service/app` (the only "orchestration" hit is a docstring in `documentExtractor.js`).

| Q | Answer |
|---|---|
| A. Is there an actual agent? | **No.** |
| B. Is it only an LLM generation service? | It is a **deterministic pipeline around one LLM call**: fixed code sequence context -> retrieval -> generation -> validation -> persistence. |
| C. Orchestrator? | `analyzeSignal()` sequences the steps in fixed code. It is a service function, not a planner - nothing decides *what to do next*. |
| D. Tools? | None exposed to the model. The model cannot call anything. The response schema is closed (an extra key is rejected), so it cannot carry an action. |
| E. Operational-data retrieval? | Yes, deterministic (`assembleSignalContext`), always the same relationships, not chosen by the model. |
| F. Knowledge retrieval? | Yes, deterministic (`retrieveKnowledgeForContext`), query built by code, always executed. |
| G. Multiple tool calls? | No. Observed per generation: exactly **two** ai-service calls (`/v1/knowledge-retrieval` [embeds internally], `/v1/intelligence/analyze`). |
| H. Deterministic vs agent-selected retrieval? | 100% deterministic. |
| I. Single-shot RAG vs agentic? | **Single-shot RAG.** Not agentic in any sense. |

This is a sound base for a later bounded agent, but today "agent" would be an overstatement.

---

## 7. LLM Context Audit

Captured at runtime (V1, operator, staff ceiling) and rendered offline with the real `build_analysis_prompt` (no network) - system prompt 4,653 chars, user prompt 3,688 chars.

What reaches the model, in order:

1. **System prompt** (`ai-service/app/services/analysis_prompt.py`): KOI role; operational context is the only source of fact; missing info must be stated; history is inference not certainty; knowledge is guidance not fact; scope preference unit > property > workspace; no invented policy; conflicts surfaced; cite used chunkIds; prioritization; structured fields only.
2. **`=== OPERATIONAL CONTEXT ===`**: JSON of `{signal, guest{id,available,recentStays}, stay, property, unit, history{signals[<=20]}}`. Guest firstName/lastName/email/phone are absent [runtime: 0 matches for name/email/phone in the rendered prompt].
3. **`=== BUSINESS KNOWLEDGE ===`**: per chunk `[chunkId | scope | document id vN | section "..."]` + chunk text; or an explicit "No organizational knowledge was retrieved..." paragraph.
4. Closing instruction: "Return the structured analysis now."

Request envelope Node -> Python analyze: `{context, knowledge[], authorizedLevel}`; knowledge items carry chunkId, document id, version, scope, section(+path), visibility, chunkIndex, text, similarity/retrieval scores. No token, secret, workspace id, actor id or role is sent. The rendered *prompt* never includes retrieval scores or workspace id.

Caveats: the `test` provider does **not** build a prompt at all (it fills a template from the same inputs), so the prompt itself was verified by rendering, not by a model's behavior. **Legacy path**: Node sends the *unsanitized* context and Python's legacy prompt builder serializes the whole context, so guest name/email/phone **do reach the model** on that path [code; not runtime-tested]. Real-model behavior (Gemini structured output, `gemini_analysis_client.py`) is **not verified**.

---

## 8. Intelligence Output Audit

V1 fields and their origin (runtime record):

| Field | Origin | Notes |
|---|---|---|
| `analysis.situation`, `impact`, `recommendation` | **LLM-generated** (stub in test) | validated non-empty strings, <=2000 chars |
| `analysis.evidence` | **LLM-generated** free-text list (1-12 items, <=1000 chars) | **not references**: no signal/stay/history/knowledge ids. Not verifiable against records. |
| `analysis.confidence` | **LLM-generated** class `high|medium|low` | an evidence-quality class, not a probability; nothing calibrates it. Test stub never emits `high`. |
| `usedKnowledgeChunkIds` | LLM-declared, **validated ⊆ Node's retrieved set** | the only real cross-reference; cited-but-unretrieved id => whole analysis rejected |
| `knowledgeProvenance` | **Node-derived** from its own retrieval, filtered to used ids | real records; carries document id, version, scope, section, chunkIndex, similarity/retrieval scores |
| `provider` / `model` | **attached by the executing layer**, never from the model | observed `test` / `deterministic-stub` |
| `analysisVersion` (`intelligence-v1`), `analysisLevel`, `knowledgeVisibility` | **Node-set** | `knowledgeVisibility` = max visibility of *all retrieved* chunks (not only cited ones) - conservative |
| `risk.level/reason` | **Node-derived** from signal severity | not analysis |
| legacy blocks `intelligence.*`, `decision.recommendation`, `risk` | back-filled from V1 fields for compatibility | |
| `context.summary/unit/stayStatus`, `intelligence.pattern`, `guestImpact`, `decision.summary`, `action.*`, `outcome.*` | **SCAFFOLDING**: stored as empty strings on V1 records | schema-only |
| `decision.priority` on the Intelligence record | constant `"medium"` [runtime] | schema default, not derived (the Decision V1 record derives priority from severity: observed `high`) |

Do evidence references point to real records/knowledge? Knowledge: **yes** (chunk ids are checked and provenance is Node's own). Operational evidence: **no** - evidence strings are prose; with a real model nothing prevents a sentence that misstates a fact. Anti-hallucination is prompt-level.

Contract inconsistency [runtime]: `POST /intelligence/analyze` returns the **raw stored record** (keys included `provider`, `model`, `guestId`, `stayId`, `__v`, and `knowledgeProvenance[].knowledgeDocumentId/similarityScore/chunkIndex`), whereas `GET /intelligence[/:id]` returns the Phase 14 sanitized whitelist view. An operator therefore sees more fields from the generate response than any role sees from a read. (Not a cross-tenant leak; an inconsistency in what the sanitizing policy is meant to guarantee.)

Persistence [runtime]: analysis stored with `generatedBy: llm`, ids of signal/property/guest/stay, `analysisLevel`, provenance. Re-analysis is idempotent per (signal, level): a repeat call returned 200 with the same `_id` and made **0** AI calls; an admin (restricted) analysis of the same signal created a **separate** record (201) at level `restricted`.

---

## 9. Signal -> Intelligence -> Decision -> Action -> Outcome -> Learning Audit

| Arrow | Status | Evidence |
|---|---|---|
| Signal -> Context | IMPLEMENTED | `assembleSignalContext` (deterministic, tenant-scoped) |
| Context -> Intelligence | IMPLEMENTED (V1) / PARTIAL overall | V1 grounded + validated + persisted [runtime]; UI still triggers the legacy pipeline; no agentic reasoning; real-model quality not verified |
| Intelligence -> Decision | IMPLEMENTED (deterministic, human-gated) | `decisionService.proposeDecision`: description = `analysis.recommendation` **verbatim**, priority from Signal severity, confidence copied; idempotent; `approve`/`reject` by reviewer/admin [runtime: propose 201, approve 200]. No model involvement. |
| Decision -> Action | **SCAFFOLDING (blocked)** | Action model/service/routes exist; the data invariant (Action only on an approved Decision V1) is implemented, but `POST /actions` is **403 for every role, including admin** [runtime] because `action:execute` is assigned to nobody. Nothing executes or dispatches anything. |
| Action -> Outcome | **SCAFFOLDING (blocked)** | Outcome model/service exist; `POST /outcomes` is **403 for every role** [runtime]; there is no `outcome:record` permission. Rows currently in the DB predate the authorization phases. |
| Outcome -> Learning | PARTIAL / descriptive | `learningService.getLearningReport` (counts/coverage over Intelligence->Decision->Action->Outcome) and `patternService` (recurring Signal types via aggregation) - deterministic, admin-only, **read-only, not persisted** |
| Learning -> better Intelligence | **MISSING** | Outcomes, learning report and patterns are **not** inputs to context, retrieval or prompt. Runtime proof: a prior Intelligence + approved Decision + Action + Outcome (marker strings in each) on Unit 301 did **not** appear in the LLM request for a later Signal in the same property (marker absent; prior analysis text absent; context keys still only signal/guest/stay/property/unit/history). |

So: Outcome and Learning do **not** feed future intelligence.

---

## 10. Security Boundary Audit (AI retrieval path)

Runtime results (statuses observed):

| Check | Result |
|---|---|
| No token -> analyze | 401 |
| Viewer (no `intelligence:generate`) -> analyze | 403 |
| Admin of workspace B -> analyze signal of workspace A | 404 |
| Same, with `?workspaceId=<A>` spoof | 404 (non-member; workspaceId is only a selector) |
| Operator of A -> analyze a workspace-B signal (with and without `?workspaceId=<B>`) | 404 / 404 |
| Forged `x-role: admin`, `x-knowledge-level: restricted`, `x-workspace-id: <B>` headers | ignored; returned the operator's own existing staff-level record (200, no new generation). *Weak signal only, because the analysis pre-existed - the header-immunity proof is Phase 13/19 suites, not this run.* |
| AI calls caused by all denied requests | **0** (authorization precedes retrieval and generation) |
| Foreign-workspace knowledge chunk (near-identical SOP text) in any candidate set | **never** (chunks of workspace B absent from every captured candidate list) |
| Restricted knowledge for operator (staff ceiling) | not among candidates (`[staff, guest]` only) |
| Restricted knowledge for admin (restricted ceiling) | candidates `[staff, guest, restricted]`; stored record `analysisLevel=restricted`, `knowledgeVisibility=restricted` |
| Viewer / operator reading the restricted Intelligence | 404 / 404 (ceiling-gated reads) |

Design properties [code]: identity from the verified token -> `User` -> active workspace membership -> server-side role -> knowledge ceiling; workspace for every query is `req.actor.workspaceId`, never a body/query value. Filtering happens **before** the model (Mongo candidate query, then a second visibility filter in Python, then Node re-verification), so the LLM is never an authorization boundary and never sees data above the caller's ceiling. The response schema is closed and provenance is Node-derived, so model output cannot smuggle an action, a foreign chunk id or a visibility claim. Prompt-injection residue: text inside a Signal description or a knowledge chunk can influence the *advice text* (which is copied verbatim into a proposed Decision, then reviewed by a human); it cannot trigger any operation.

Not covered: the legacy path sends guest PII to the model (privacy, not tenancy); the generate response exposes fields the read view hides (section 8).

---

## 11. Runtime Verification Results

Setup (all offline, scratchpad script, nothing written into the repository): ai-service spawned on `:8013` with `LLM_PROVIDER=test EMBEDDING_PROVIDER=test GEMINI_API_KEY=""`; recording proxy `:8014`; backend on `:5059` with `NODE_ENV=test` (refuses a non-loopback AI URL), `LLM_PROVIDER=test-python`, `AI_SERVICE_URL=http://localhost:8014`; throwaway workspaces A and B, users for admin/operator/reviewer/viewer (stub-signed tokens), real routes for knowledge documents (create -> chunk -> embed). Fixture: 1 property, 2 units, 1 guest (with name/email/phone), 1 in-house stay, 3 related signals + 1 analyzed signal + 1 foreign-workspace signal, 3 documents in A (unit/staff SOP, workspace/guest policy, workspace/restricted procedure) and a near-duplicate SOP in B.

Captured path (operator, staff ceiling):

| Step | Observed |
|---|---|
| Input signal | `type=maintenance severity=high title="AC not cooling in 301"`, description "Warm air blowing from the unit; guest uncomfortable." |
| Context | property, unit 301, guest (id + recentStays), stay `checked_in`, 3 history signals (matchedBy stay/guest/unit/property) |
| Retrieval request | queryText = type + title + description; 2 candidates (unit/staff, workspace/guest); restricted and foreign chunks absent |
| Retrieval response | both chunks, similarity -0.019 (unit, boosted -> -0.022) and -0.256 (workspace) - both passed on (no threshold) |
| LLM request | `{context (sanitized), knowledge[2], authorizedLevel:"staff"}`; rendered prompt: 3 sections, no guest PII |
| Generated intelligence | stub text with `[DETERMINISTIC TEST ANALYSIS]` markers, 7 evidence lines derived from the context, confidence `medium`, both chunks reported used, provenance `test / deterministic-stub` |
| Persisted | 1 Intelligence, `intelligence-v1`, level/visibility `staff`, provenance = the 2 retrieved chunks |
| Decision | `proposed` (priority `high` from severity, description = recommendation verbatim) -> approved by reviewer |
| Action / Outcome via HTTP | 403 / 403 (fixtures created in-process only to test feedback) |
| Feedback test | second signal (Unit 302): no marker text, no prior analysis, same 6 context keys |
| Admin generation of the same signal | new record at `restricted`, 3 provenance chunks |

**DB counts before == after (baseline preserved):** User 1, WorkspaceMembership 1, Workspace 1, Property 2, Unit 21, Guest 10, Stay 10, Signal 3, Intelligence 1, KnowledgeDocument 1, KnowledgeChunk 22, ImportBatch 1, Conversation 3, Message 12, Decision 33, Action 32, Outcome 32 (the two pre-existing orphan Messages untouched; all throwaway data removed by exact workspace ids; the run needed three attempts to fix fixture enum values - two aborted early, and cleanup ran each time, counts identical each time).

Additional: `ai-service` pytest with forced test providers: **221 passed**. Existing `validate-*.mjs` suites were **not** re-run in this phase.

External AI calls: **none** (test providers, empty key, `NODE_ENV=test` loopback guard, proxy saw only loopback traffic; the user's own ai-service on `:8000` was not used).

---

## 12. IMPLEMENTED / PARTIAL / SCAFFOLDING / MISSING Matrix

| Capability | Status |
|---|---|
| Signal ingestion + context assembly (Signal/Guest/Stay/Property/Unit) | IMPLEMENTED |
| Guest PII stripping before the model | IMPLEMENTED (V1) / **MISSING (legacy)** |
| Historical signal context | PARTIAL (metadata only) |
| Workspace-level context (config/timezone/policies as data) | MISSING |
| Previous Intelligence / Decisions / Actions / Outcomes / messages in context | MISSING |
| Document ingestion, chunking, embedding | IMPLEMENTED |
| Vector storage | PARTIAL (array field, no index) |
| Semantic retrieval | PARTIAL (brute force, cap 200, no threshold, query = signal text only) |
| Metadata filtering (workspace/status/visibility/scope/effective window) | IMPLEMENTED |
| Retrieval quality controls (threshold, rerank, hybrid, model filter) | MISSING |
| Grounded prompt (operational vs knowledge separation) | IMPLEMENTED (prompt-level) |
| Structured output validation + Node-derived provenance | IMPLEMENTED |
| `evidence` as verifiable references | MISSING (free text) |
| Real-provider execution (Gemini generate/embed) | IMPLEMENTED in code, **not verified here** |
| Intelligence persistence with analysisVersion/level/visibility | IMPLEMENTED |
| Agent / orchestrator / tools / multi-step reasoning | MISSING |
| Decision V1 (propose/approve/reject) | IMPLEMENTED (deterministic, human-gated) |
| Action execution / tracking | SCAFFOLDING (blocked for all roles) |
| Outcome recording | SCAFFOLDING (blocked for all roles) |
| Learning report / recurring patterns | PARTIAL (descriptive, admin-only, not fed back) |
| Learning -> future intelligence | MISSING |
| UI trigger for V1 analyze | MISSING (UI uses legacy) |
| Tenant isolation / authorization in the AI path | IMPLEMENTED |
| Evaluation harness for answer quality / observability (token/cost/prompt version) | MISSING |

---

## 13. Exact Implementation Gaps

1. **UI/engine mismatch.** `frontend/src/features/intelligence/useSignalIntelligence.js` -> `koiApi.generateSignalIntelligence` -> legacy `/signals/:id/intelligence`. V1 (`/intelligence/analyze/:signalId`) has no caller; the dashboard's "Analyzed" counts V1 records only.
2. **Legacy PII exposure.** `services/ai/intelligenceService.js` passes `assembleSignalContext` output unsanitized; Python's legacy prompt serializes the whole context.
3. **Generate response not sanitized.** `intelligenceAnalysisService`/`analyzeSignal` returns the raw record; `toIntelligenceView` (used by GET) is not applied.
4. **Retrieval relevance.** No minimum score; top-5 always returned; observed a -0.256 chunk cited as used.
5. **Candidate cap.** `selectCandidateChunks` `limit 200` sorted by `_id`: chunks beyond 200 are silently excluded (breaks at realistic knowledge-base sizes).
6. **Query construction.** Only signal type/title/description; unit/guest/stay/history/severity/property unused.
7. **Embedding-model consistency.** No filter on `embeddingModel`; only a dimension check on the first candidate.
8. **History without meaning.** No description, resolution, or downstream Decision/Outcome for related Signals; property-level matches can be unrelated.
9. **No feedback context.** Previous Intelligence/Decision/Action/Outcome are never assembled for the prompt.
10. **Loop cannot close.** No role holds `action:execute`; no `outcome:record` permission exists; nothing dispatches an Action or captures a result through the product.
11. **Evidence not referential.** `analysis.evidence` is free text; no ids for Signals/Stays/history/knowledge; unverifiable claims possible with a real model.
12. **Scaffolding fields.** Empty legacy blocks (`context.*`, `intelligence.pattern/guestImpact`, `decision.summary`, `action.*`, `outcome.*`) and constant `decision.priority: medium` on V1 records.
13. **Confidence** is an uncalibrated class emitted by the model.
14. **Real providers unverified** in this audit (Gemini generation, Gemini embeddings, structured-output behavior, latency, cost, quota).
15. **No evaluation/observability** for answer quality, retrieval hit-rate, tokens or cost.
16. **Learning is descriptive.** `learningService`/`patternService` count and aggregate; no signal is written back anywhere.

---

## 14. Recommended Implementation Order

Ordered by dependency and risk; each step is independently reviewable and keeps the existing authorization model (workspace/visibility filtering before the model, closed response schemas).

1. **Make V1 the product path.** Point the UI at `/intelligence/analyze`, sanitize the generate response with the same view as GET, retire (or sanitize) the legacy generator. Removes gaps 1-3 and the PII exposure.
2. **Retrieval hardening.** Relevance floor and "no relevant knowledge" outcome; enrich the query (unit/severity/history titles); replace the `_id`-capped candidate set with scoring over all eligible chunks (paged, or Mongo Atlas/`$vectorSearch`/a vector index if the deployment allows); filter on `embeddingModel`/input version; record retrieval diagnostics. Gaps 4-7.
3. **Evaluation harness with a golden set** (unit-tested with the test providers for mechanics; a small approved real-provider run for quality). Establishes how good retrieval and generation actually are before more is built. Gaps 14-15.
4. **Richer, deterministic context.** Historical signals with descriptions, resolution status and linked Decision/Outcome summaries; previous Intelligence for the same unit/guest; property/workspace facts. Sanitized and size-bounded; still assembled in code, not chosen by the model. Gaps 8-9.
5. **Referential evidence.** Change `evidence` to items that cite record ids (signal/stay/history/knowledge) validated against the assembled context (same pattern as `usedKnowledgeChunkIds`). Gap 11.
6. **Close the operational loop.** Decide the Action policy (who may execute/record; introduce `outcome:record`), build minimal Action tracking and Outcome capture on approved Decisions - still no autonomous execution. Gap 10.
7. **Feed outcomes back (deterministic first).** "Similar past incidents and what happened" assembled from Decision/Action/Outcome by type/unit/property, added to context; use `patternService` output as context. Then measure whether it changes recommendations. Gaps 9, 16.
8. **Only then consider a bounded agent.** A small, server-authorized tool set (read operational history, retrieve knowledge) with a step/cost budget, every tool re-applying workspace and visibility checks from the token-derived actor, and no write tools without a human gate. The model must never be an authorization boundary.
9. **Cleanup:** remove scaffolding fields or populate them; derive `decision.priority`; calibrate or drop `confidence`; add token/cost/prompt-version observability.
