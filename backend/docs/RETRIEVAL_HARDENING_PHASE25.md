# Retrieval hardening (Phase 25)

Scope: the EXISTING V1 knowledge retrieval path (dense embeddings + in-memory cosine). No agent, no hybrid search, no reranker, no new
store, no authorization, context or evidence-model change. Source of truth: `EOI_INTELLIGENCE_AUDIT_PHASE23_5.md` and `INTELLIGENCE_V1_CANONICAL_PHASE24.md`.

**Phase 25 does NOT establish semantic retrieval quality.** The deterministic test embeddings prove pipeline behavior, not real-world relevance,
and the relevance floor below is provisional. Phase 26 (the evaluation harness) must measure retrieval before any value is called good.

## 1. Retrieval flow: before and after

Inspected in the current code (no field was invented): `KnowledgeChunk` already persists `embedding` (array), `embeddingModel` (string) and `embeddingInputVersion`;
the dimension is `embedding.length`. Test embeddings: 32-dimension sha256-derived unit vectors, model `deterministic-embedding-v1` (identical text -> identical vector, unrelated texts about N(0, 0.18)).

**Before (Phase 23.5 audit):**
```
Mongo: workspace/status/visibility/scope/window filters, sort _id, limit 200      <- first 200 by _id, however many were eligible
 -> Python: embed query, compare with candidate[0]'s dimension only, cosine x scope boost, sort
 -> Node: re-verify identity/scope/finite scores, slice(0, 5)                      <- no relevance floor: top-5 always returned
 -> analyze request (context, knowledge, level)
```

**After:**
```
Node: query text = signal type. title. description   (nothing else; no guest/stay/unit/property data)
Node: page loop, ascending _id, 200 per page, up to 2000 eligible chunks
        each page: Mongo filters (workspace, active, visibility ceiling, property/unit scope, effective window, has embedding)
                   -> Python: embed query once per page; per candidate: skip if embeddingModel != query model OR dimension != query dimension
                              (counted, never compared); cosine x scope boost on the compatible ones; deterministic sort
                   -> Node: re-verify chunk identity, scope, finite scores AND embedding model
Node: all pages merged -> RAW cosine >= floor (0.25, provisional) -> de-duplicate by chunk id -> stable descending order -> top-K (5)
Node: status ok | no_relevant_knowledge | no_eligible_knowledge, or FAIL CLOSED (see section 5)
 -> analyze request (context, knowledge, level): only the final evidence
```

## 2. Candidate selection

* Every eligibility rule is in the MongoDB query and runs **before** paging, embedding and similarity: workspace, `status: active`, visibility `$in` the role's ceiling, scope (workspace-wide, this Signal's property, this Signal's unit), effective-from/to window, embedding present.
  Similarity is never relied on for isolation.
* **Fixed:** the former `sort _id, limit 200` silently made the first 200 chunks the only candidates. Now the query is walked in pages of 200 (cursor `_id > last`), each page is scored, and results are merged, so a relevant chunk that is 451st by `_id` is found (tested: 451 chunks in pages 200/200/51, the best chunk last).
* **Ceiling:** at most 2000 eligible chunks are scanned (10 pages). More than that **fails closed** (retrieval error) rather than scoring only part of the corpus. Memory stays bounded (one page of vectors at a time).
* Cost note: the query is embedded once per page, so a corpus of N eligible chunks costs ceil(N/200) embedding calls per analysis (1 for the current 22-chunk corpus, at most 10). Caching the query embedding across pages would need a Python contract change and was left out of scope.
* No metadata filter was added: the existing safe filters already apply; the embedding model cannot be a Mongo filter because the query model is only known after Python embeds the query.

## 3. Workspace and visibility guarantees

Unchanged in design and re-proven (see section 8): a foreign-workspace chunk is not a candidate; a chunk above the caller's ceiling is not a candidate; the ceiling is the role's (never a request value); Python re-filters visibility (defense in depth) and Node re-verifies every returned chunk against the map it built itself.
The `x-*` headers, query, body and token claims cannot change floor, top-K, embedding model, visibility, scope or workspace (tested).

## 4. Similarity, floor and top-K

* Similarity = cosine of the query embedding and the chunk embedding (Python, `vector_math.cosine_similarity`). Ranking uses `retrievalScore = cosine x scope boost` (unit 1.15, property 1.08, workspace 1.0; unchanged), ties by raw similarity, scope specificity, then chunk id ascending (stable, deterministic).
* **Relevance floor (new, server-side):** a candidate is kept when its **raw cosine** is `>= KOI_RETRIEVAL_MIN_SIMILARITY` (default **0.25**, boundary inclusive). The raw cosine is used so the scope preference can break ties between relevant chunks but can never lift an irrelevant one over the floor.
  * **0.25 is PROVISIONAL and UNCALIBRATED.** There is no evaluation data to justify a value. It is a conservative floor whose only claim is to discard candidates pointing in unrelated/opposing directions. With the hash-based test embeddings it rejects most unrelated text (which is what makes the below-floor path testable with computed values); with a real embedding model it is expected to be permissive - exactly what Phase 26 must measure.
  * The value is server-controlled (process environment only), deterministic, and easy to tune. An unset, blank, non-numeric or out-of-range (outside -1..1) value falls back to 0.25 (a typo cannot disable it); a deliberate `-1` disables it (every cosine is >= -1) and production start-up prints a warning if the value is below the default. Test harnesses whose hash embeddings carry no meaning (`lib/authFixtures.mjs`, `start-test-stack.mjs`) set `-1` for the legacy suites; the Phase 25 suite unsets it and uses the real default.
* **Top-K = 5** (unchanged): a small final evidence set; more candidates never mean more context. Order: highest retrieval score first, deterministic ties.
* **De-duplication:** by chunk id only. Identical text under different chunk ids (e.g. the same guidance authored at unit, property and workspace scope) is deliberately kept, because the V1 prompt asks the model to prefer the more specific scope without discarding broader guidance.

## 5. Embedding compatibility

* Rule (Python, per candidate, against the QUERY embedding): score only if `candidate.embeddingModel == query model` **and** `len(candidate.embedding) == len(query embedding)`. Otherwise the candidate is skipped and counted (`incompatibleCandidates`), never compared, never returned, never in a prompt. A chunk with no `embeddingModel` is sent with the placeholder `(unlabeled)` so it can never match.
* The old request-level rule "all candidates must share one dimensionality" (which failed the whole request) was replaced by this per-candidate rule, so a corpus in the middle of a model migration keeps working with its compatible part. Zero-magnitude / duplicate-id / invalid vectors still reject the request (a genuine failure).
* Node re-checks: a result whose chunk was embedded by another model than the one Python reports for the query is dropped.
* **Fail closed:** if candidates were eligible but **none** is comparable, retrieval throws (502, `KNOWLEDGE_RETRIEVAL_UNAVAILABLE`) and no analysis is generated or stored. That state is never reported as "no relevant knowledge", because the knowledge layer could not be checked at all. Partial incompatibility logs a count-only warning.
* Limitation: there is no persisted *provider* or explicit *dimension* field, only `embeddingModel` and the vector length; those two are what the rule uses. Chunks embedded under an older `embeddingInputVersion` recipe are not distinguished (only version 1 exists). No migration or re-embedding was performed.

## 6. Empty retrieval

`retrieveKnowledgeForContext` returns `status`: `ok` | `no_relevant_knowledge` (candidates compared, none reached the floor) | `no_eligible_knowledge` (nothing eligible), plus counts-only `diagnostics` (`eligibleCandidates`, `evaluatedCandidates`, `incompatibleCandidates`, `belowThreshold`, `minSimilarity`, `topK`) exposed by the admin-only `GET /signals/:id/knowledge-retrieval` (additive fields).
For generation, an empty result yields `knowledge: []`; the prompt then says "No organizational knowledge was retrieved for this Signal: nothing sufficiently relevant was found... do not assume, invent, or reference any policy" (existing safe contract, wording sharpened). The deterministic stub reports no guidance, cites no chunk, confidence `low`, and no provenance is stored or returned (tested). Rejected chunks are never sent, not even as text.

## 6a. What reaches the model (metadata)

Prompt (Python `prompt_builder.py`): per chunk `[chunkId | scope | section]` and the chunk text. **Removed from the prompt:** the internal document id and version. Never in the prompt: retrieval/similarity scores, chunk index, embeddings, model/provider labels. The deterministic stub no longer prints retrieval scores into evidence text (which is public output).
The Node -> Python HTTP request still carries the internal fields the ai-service contract defines (document id, version, chunk index, scores) - internal to the two services, never the model's input and never in the public response; the Phase 28 evidence redesign is untouched. No embedding vector or embedding-model label is in the analyze request (tested).

## 7. Query construction

Reviewed: the query is `type. title. description` of the current Signal - the only retrieval-relevant, non-personal fields of the V1 signal context. Severity, status, source, ids, guest, stay, unit and property fields were deliberately NOT added (no semantic content or personal data). Guest e-mail/phone/name markers are absent from the retrieval query and from every model request (tested); free text typed into a Signal's description is passed as written (documented Phase 24 residual).

## 8. Test coverage

`scripts/validate-phase25-retrieval-hardening.mjs` (78 checks; starts its own ai-service with forced test providers and a recording proxy; refuses a non-loopback AI URL under `NODE_ENV=test`; constructed vectors with exact cosines):
A candidates (workspace, visibility, ascending order, determinism, paging 200/200/51, best-chunk-last, 2000 ceiling fails closed) - B similarity (Python vs independent cosine < 1e-12, accepted/rejected/exact boundary with the floor set to the measured value and 1e-9 above, ties) - C floor (below excluded, all-below, weak chunk never in the request) - D top-K (10 pass, 5 sent, three ties straddling the cut, order permutations) - E compatibility (other model, other dimension, unlabeled excluded; nothing comparable = 502, no model call, nothing stored) - F isolation (a 0.99 foreign chunk and a 0.95 restricted chunk never reach the operator's request; forged floor/top-K/model/visibility/workspace ignored) - G PII - H exact model request (only final evidence, no vectors/labels) - I empty retrieval - J no operational record modified, foreign workspace byte-identical, counts back to baseline.
Mutation-checked: removing the floor, removing paging and removing the compatibility filter each make the suite fail (11, 6 and 3 failures respectively); all mutations were reverted.
Python: `tests/test_retrieval.py` gained 7 tests (model/dimension compatibility, counts, no Python-side threshold); prompt tests updated to the Phase 25 contract (no document ids in the prompt). Pytest total 228.

## 9. Known limitations

* The floor is provisional and uncalibrated; real-model behavior was never measured (no real provider was called).
* Brute-force cosine in memory over up to 2000 chunks: fine for the current corpus, not a scalable design; one query embedding per page.
* The query embedding is recomputed per page; retrieval quality depends on the signal text alone (no context enrichment: Phase 27).
* No hybrid/keyword search, no reranker, no query rewriting, no knowledge-gap signalling to the user.
* `embeddingInputVersion` is not part of compatibility.
* The ai-service still exposes the pre-V1 `/v1/intelligence/signal` endpoint (uncalled). `CLAUDE.md` is stale on several points (legacy generator, `llmProvider.js`, Phase 4/5 routing, the retrieval description) and was intentionally not edited.

## 10. Hybrid search: not decided here

Dense-only retrieval with the test embedder cannot show whether lexical matching would help: hash vectors carry no semantics, so any comparison here would be meaningless. Nothing in this phase provides evidence for or against hybrid retrieval or reranking.
Phase 26 should first build an evaluation set (queries, expected chunks, hard negatives) and score the current dense pipeline, then compare alternatives (dense, BM25/hybrid, reranking, floor values) on that same set before deciding whether any is justified.
