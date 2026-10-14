# Real embedding evaluation (Phase 26.5)

**Scope and honesty.** One real embedding model (the repository's current provider), the fixed Phase 26 synthetic dataset and labels, the production retrieval scoring/selection code.
It answers "how does our current real embedding provider perform on our EOI evaluation set?" It is **not** a production benchmark, **not** a model comparison, and **no production setting was changed**.
The dataset is small (23 cases, 19 with a relevant chunk, 33 candidates per query), English, clean and written by the same author as the labels, so the results below are strong evidence about *this set* and weak evidence about production traffic.

Artifacts (`backend/evaluation/`): `retrieval/real/{export-manifest.mjs, collect_embeddings.py, replay_service.py, real-run.mjs, run-real-evaluation.mjs}`, `results/phase26_5-embedding-manifest.json`, `results/phase26_5-real-embedding-cache.json` (the provider vectors, no secrets),
`results/phase26_5-real-embedding-results.json`, and `backend/scripts/validate-phase26_5-real-embedding.mjs`. The metric definitions are unchanged from Phase 26.

## 1. What was sent to the provider (authorization boundary)

| | |
|---|---|
| Provider / model | Gemini, `gemini-embedding-001` (the repository's configured model; not switched) |
| Embedding dimension | 3072 (the provider default the production integration uses) |
| Document configuration | task type `RETRIEVAL_DOCUMENT` (as production does for chunks) |
| Query configuration, arm A ("production") | `RETRIEVAL_DOCUMENT` - **what production does today**: the query is embedded by the same function as a chunk |
| Query configuration, arm B ("provider-recommended") | `RETRIEVAL_QUERY` - Google's documented asymmetric-retrieval configuration; evaluation only |
| Embedding calls | **6** requests (documents 2, queries-as-document 2, queries-as-query 2), 81 texts, 13,174 characters |
| Generation / LLM calls | **0** |
| Timestamp of the embeddings | 2026-09-28T10:07:50Z (`embeddingsGeneratedAt` in the results) |
| Dataset | version 1.0.0, sha256 `6cdb793c5c20...` (identical to Phase 26) |

Before the first call the exact texts were exported (`export-manifest.mjs`: production chunker, production `buildEmbeddingText`, production query builder), reviewed and a dry run printed the plan (requests, characters, task types).
Sent: 35 chunk texts (34 in the evaluation workspace + 1 foreign-tenant fixture) and 23 query texts, all derived from `dataset.json`. **No production data and no PII were sent**: no guest, stay, signal, property or knowledge record from the database is read by the collector (it never opens the database);
a static scan finds no e-mail, phone number or URL; queries are the synthetic signal text ("type. title. description"). Two of the 35 chunk texts are *evaluation fixtures* for the security cases - a synthetic "restricted" escalation chunk and a synthetic near-copy of the AC procedure labelled as another tenant's - they are synthetic text, embedded only so that isolation can be tested against genuinely similar real vectors.
The key is read by the repository's settings object inside the collector process only; it is never printed, logged, passed to another process or written to any artifact (a key-shaped-string scan of every artifact is part of the validation suite). The collector contains one provider call type, `embed_content` (through the repository's existing `generate_gemini_embeddings` for documents/production-arm queries, and a small isolated adapter with the same client construction for `RETRIEVAL_QUERY`); no generation call exists in it.

## 2. How the evaluation runs (no parallel retrieval algorithm)

The vectors were obtained once and cached. Every evaluation run replays them **offline**: a private ai-service imports the *unchanged* production application and replaces only the two provider calls (chunk embedding text, and the query inside the retrieval router) with cache lookups by sha256 of the exact text; an uncached text raises (no fall-through), the process has no key and a non-loopback socket guard.
Documents are ingested through the production services, queries go through the production `scoreKnowledgeForContext` (paged candidates, workspace/visibility filters, model + dimension compatibility, cosine x scope boost, Node re-verification) and the production `selectRelevantResults`. At the baseline the harness selection equals the production `retrieveKnowledgeForContext` output in all 23 cases, in both arms (parity check).
No operational record is created or changed (throwaway workspaces, removed; database counts identical before and after each arm).

## 3. Three kinds of measurement - never combined

| | A. real embeddings (this phase) | B. oracle fixture (Phase 26) | C. hash embedder (Phase 26) |
|---|---|---|---|
| What it is | real semantic retrieval | vectors designed from the labels | real pipeline, embedder with no meaning |
| Says something about a real model | **yes (one model, this set)** | no | no |

## 4. Baseline: production configuration (floor 0.25, K = 5)

| | C. hash (Phase 26) | B. oracle (Phase 26) | A1. real, production query task | A2. real, RETRIEVAL_QUERY |
|---|---|---|---|---|
| Recall@5 | 0 | 1 | **1** | **1** |
| Hit@5 | 0 | 1 | 1 | 1 |
| MRR | 0 | 1 | 1 | 1 |
| nDCG@5 | 0 | 0.9991 | 0.9848 | 0.9931 |
| No-relevant detection (4 cases) | 0 (0/4) | 0.75 | **0 (0/4)** | **0 (0/4)** |
| False-positive rate (returned explicit distractors / returned) | 0.0385 | 0.38 | 0.113 | 0.1391 |
| Cases returning an explicit distractor | 2 | 16 | 11 | 13 |
| Threshold rejection rate | 0.9315 | 0.9341 | **0** | **0** |
| Chunks returned (23 cases) | 52 | 50 | 115 (always 5) | 115 (always 5) |

Recall@5 goes from 0 (hash) to 1, MRR from 0 to 1, nDCG@5 from 0 to 0.985 / 0.993: the real model ranks the relevant chunk first in **19 of 19** positive cases (top-1 relevant 19/19 in both arms). Relevant and non-relevant chunks are also cleanly separable *within a query* (mean per-case AUC 0.9992 in arm A, 1.0 in arm B: the probability that a relevant chunk outscores a non-relevant one).
The floor, however, rejected **nothing** (rejection rate 0): see section 6.

## 5. Threshold sweep (K = 5)

Arm A1 - real, query task `RETRIEVAL_DOCUMENT` (production):

| floor | Recall@5 | hit@5 | MRR | nDCG@5 | no-relevant detected | false-positive rate | empty on positive | rejected/scored | returned | distractors returned |
|---|---|---|---|---|---|---|---|---|---|---|
| 0.00-0.60 (12 floors: 0, .05, .10, .15, .20, .25, .30, .35, .40, .45, .50, .60) | 1 | 1 | 1 | 0.9848 | 0 | 0.113 | 0 | 0 | 115 | 13 |
| 0.70 | 1 | 1 | 1 | 0.9848 | 0 | 0.113 | 0 | 0.1159 | 115 | 13 |
| 0.80 | 0.9211 | 0.9474 | 0.9474 | 0.9233 | 1 | 0.1754 | 0.0526 | 0.9236 | 57 | 10 |

Arm A2 - real, query task `RETRIEVAL_QUERY`:

| floor | Recall@5 | hit@5 | MRR | nDCG@5 | no-relevant detected | false-positive rate | empty on positive | rejected/scored | returned | distractors returned |
|---|---|---|---|---|---|---|---|---|---|---|
| 0.00-0.50 (11 floors) | 1 | 1 | 1 | 0.9931 | 0 | 0.1391 | 0 | 0 | 115 | 16 |
| 0.60 | 1 | 1 | 1 | 0.9931 | 0 | 0.1416 | 0 | 0.5007 | 113 | 16 |
| 0.70 | 0.8947 | 0.9474 | 0.9474 | 0.8945 | 1 | 0 | 0.0526 | 0.971 | 22 | 0 |
| 0.80 | 0 | 0 | 0 | 0 | 1 | n/a | 1 | 1 | 0 | 0 |

The full 14-step sweeps are in the results file. No "best threshold" is chosen: the rows are constant over a very wide range and then fall off a cliff, the cliff is at a different place for each query task (0.70-0.80 vs 0.60-0.70), and no floor improves on "no floor" for the positive cases while
no floor delivers no-relevant detection without losing relevant chunks (section 6).

## 6. Is the 0.25 floor reasonable? Similarity distributions

Raw cosine of every scored (case, chunk) pair (21 relevant-labelled pairs from the 19 positive cases, 19 explicit distractors, 10 grade-1, 709 unlabelled):

| | A1 (production query task): min / median / max (mean, sd) | A2 (RETRIEVAL_QUERY): min / median / max (mean, sd) |
|---|---|---|
| relevant (grade >= 2) | 0.7803 / 0.8614 / 0.8939 (0.8555, 0.029) | 0.6528 / 0.7398 / 0.7788 (0.7335, 0.030) |
| grade 1 (related, insufficient) | 0.7463 / 0.8088 / 0.8442 | 0.6214 / 0.6815 / 0.7125 |
| explicit distractor | 0.7474 / 0.8052 / 0.8443 | 0.6091 / 0.6699 / 0.6945 |
| unlabelled (unrelated chunks) | **0.6600** / 0.7401 / 0.8375 | **0.5093** / 0.5956 / 0.7059 |

* **The 0.25 floor sits far below every similarity the model produces**: the lowest unrelated pair is 0.66 (A1) or 0.51 (A2). Chunk-level, 100% of relevant, distractor and unlabelled chunks pass any floor up to 0.60 (A1) / 0.50 (A2). With this model the floor is **inert**: it is not a relevance filter at all. The Phase 26 hash run (93% rejected) said nothing about this because the hash embedder's cosines are centred on 0; real Gemini cosines are compressed into roughly 0.5-0.9.
* **It cannot deliver "no relevant knowledge"**: for the four no-relevant cases the highest similarity any chunk reached was 0.7476 / 0.7394 / 0.7330 / 0.7998 (A1) and 0.6098 / 0.6240 / 0.6208 / 0.6815 (A2), so at 0.25 each of them returned **5 unrelated chunks** (detection 0/4). In the grounding subset the no-relevant case `none_museum_01` sent 5 unrelated chunks to the model (nothing was fabricated, but the intent "do not force irrelevant chunks into the prompt" is not met with this model).
* **No absolute floor separates them cleanly.** Arm A1: the highest no-relevant top-1 (0.7998, the judgment case `boundary_odour_01` returning a grade-1 chunk) is above the lowest best-relevant similarity of a positive case (0.7803): the ranges overlap, so no floor works. Arm A2: 0.6815 < 0.6882 (lowest best-relevant), a window of 0.0067 - one floor in that window would separate these 23 cases, but it is a coincidence-sized gap on 4 no-relevant cases, and at 0.70 the same arm already loses relevant chunks (Recall 0.8947, 14% of relevant chunks below 0.70).
* **The right value depends on the query-task configuration**: switching the query from `RETRIEVAL_DOCUMENT` to `RETRIEVAL_QUERY` shifts every similarity down by roughly 0.12 (median relevant 0.861 -> 0.740). A floor calibrated for one arm is wrong for the other; if production ever changes the query task, the floor has to be re-derived.

Uncertainty: 4 no-relevant cases and 19 positive cases. 19 of 19 top-1 successes bound the true top-1 rate only to about >= 0.82 (two-sided 95% lower bound, 0.025^(1/19)); the bootstrap standard error of Recall@5 is 0 because every case is at the ceiling, which reflects the easiness of this set, not certainty.

**Verdict on 0.25:** not defensible as a relevance floor for `gemini-embedding-001` on this evidence - it is neither harmful nor useful here (inert). A *candidate for human review*, not applied: an absolute floor is a weak tool for this model (compressed range, task-dependent scale); a rule relative to the top score or a per-model calibrated value would need a larger no-relevant set to study. Production was not changed.

## 7. Top-K sweep

Floor 0.25 (identical to floor 0 for real vectors):

| K | A1 Recall | A1 hit | A1 MRR | A1 nDCG | A1 FPR | A2 Recall | A2 hit | A2 MRR | A2 nDCG | A2 FPR |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 0.9474 | 1 | 1 | 1 | 0 | 0.9474 | 1 | 1 | 1 | 0 |
| 3 | 1 | 1 | 1 | 0.9848 | 0.1449 | 1 | 1 | 1 | 0.9906 | 0.1739 |
| 5 | 1 | 1 | 1 | 0.9848 | 0.113 | 1 | 1 | 1 | 0.9931 | 0.1391 |
| 8 | 1 | 1 | 1 | 0.9893 | 0.0815 | 1 | 1 | 1 | 0.9953 | 0.0978 |
| 10 | 1 | 1 | 1 | 0.9913 | 0.0739 | 1 | 1 | 1 | 0.9953 | 0.0783 |

Recall@1 is below 1 only because two cases have two relevant chunks; K = 3 already retrieves every relevant chunk in every case. **K = 5 is sufficient on this set** (the second relevant chunk is within the top 3 everywhere) and leaves two slots of margin. It is defensible for a corpus like this one (33 candidates, at most 2 relevant chunks per case);
it says nothing about a corpus with hundreds of near-duplicate sections or queries needing more than five chunks. Because the floor is inert, K = 5 is also what limits the context: every query returns exactly 5 chunks, of which on average about 2 are not relevant.

## 8. Ranking, false positives and false negatives (baseline)

* False negatives: **none** (no relevant chunk missed at K = 5 in either arm).
* False positives are the non-relevant chunks that fill the remaining slots (88 in A1, 86 in A2, including the five unrelated chunks returned for each of the three no-relevant cases that have no labelled chunk at all). Largest A1 examples: `housekeeping#Extra towels and amenities` for the missed-cleaning case (0.8443, explicit strong distractor), `ac-troubleshooting#Noisy or leaking air conditioner` for the blocked-filter case (0.8375, unlabelled, same document), `housekeeping#Linen change frequency` (0.8341), `ac-preventive#Annual servicing` (0.8314). A2: `ac-troubleshooting#Noisy or leaking air conditioner` for the direct AC case (0.7059), `plumbing-leaks#Low water pressure` for the heater case (0.6945), `ac-preventive#Annual servicing` (0.6934).
  They are sibling sections of the right document or the right topic: the model separates by *topic* and then *within topic*, but only by a margin of 0.03-0.09 cosine.
* Margins: the relevant chunk beats the best explicit distractor in 19/19 cases (mean margin 0.03-0.09 by category); beats every non-relevant chunk in 18/19 (A1) and 19/19 (A2).

## 9. Per-category results (baseline, K = 5, both arms Recall 1 and MRR 1 in every category with a relevant chunk)

| Category | cases | A1 nDCG@5 | A2 nDCG@5 | A1 FPR | A2 FPR | note |
|---|---|---|---|---|---|---|
| A direct | 3 | 0.9943 | 0.9943 | 0.1333 | 0.1333 | |
| B paraphrase | 3 | 0.9724 | 0.9724 | 0.1333 | 0.1333 | |
| C terminology | 3 | 0.9795 | 0.9954 | 0 | 0 | |
| D strong distractor | 3 | 1 | 1 | 0.3333 | 0.3333 | most false positives (sibling sections) |
| E near-topic | 2 | 0.9587 | 0.9914 | 0.1 | 0.2 | |
| F exact-keyword | 2 | 1 | 1 | 0.1 | 0.3 | |
| G no relevant | 3 | - | - | - | - | detection 0/3: 5 unrelated chunks each |
| H multiple relevant | 2 | 0.9779 | 1 | 0.1 | 0.1 | |
| I boundary | 2 | 1 | 1 | 0.1 | 0.1 | odour case (annotated no-relevant) returned its grade-1 pest chunk at 0.80 / 0.68 |

Still difficult: **no-relevant detection** (G and the odour case), and the **sibling-section false positives** in D/E. Ranking itself is not difficult on this set.

## 10. Semantic sanity checks (no LLM judge, no score edited)

For each positive case the embedding's top-1 was compared with a pure keyword baseline (Jaccard overlap of content words between the query and each chunk - a *diagnostic*, not a retriever). Result (embedding top-1 relevant / keyword top-1 relevant):

| Category | A1 | A2 | reading |
|---|---|---|---|
| B paraphrase (3) | 3 / 0 | 3 / 0 | the relevant chunk shares almost no words with the query (mean overlap 0.025), the embedding still ranks it first in every case: it follows meaning |
| C terminology (3) | 3 / 2 | 3 / 2 | aircon/elevator/bath-linen variants handled; margin over the strongest distractor 0.088 / 0.106 |
| D strong distractor (3) | 3 / 1 | 3 / 1 | the sibling section shares vocabulary; the embedding still wins 3/3 (margin only 0.034 / 0.053) |
| E near-topic (2) | 2 / 1 | 2 / 1 | correct, margin 0.033 / 0.059 |
| F exact-keyword (2) | 2 / 2 | 2 / 2 | **not discriminating on this dataset**: the labelled keyword distractors share *no* content words with the query after stopword removal (mean overlap 0), so keywords also win; these two cases do not test a keyword trap |

Conclusion supported by the data: on B-E the model behaves semantically rather than lexically; the F cases are too weak to say anything about exact-keyword traps.

## 11. Security and retrieval integrity (repeated with real vectors)

* Foreign-workspace and restricted chunks: never candidates, never scored (every case saw exactly the 33 legitimate chunks) in both arms. Their **real** similarity to the query is reported: the foreign near-copy scores 0.8727 (A1; the best legitimate chunk 0.8733) and **0.7841 in A2, higher than every legitimate chunk (0.7788)** - it would have been the top hit if authorization relied on similarity; the restricted chunk scores 0.7982 / 0.6854. Isolation held because filtering happens before scoring.
* Forged workspace selector (operator of the evaluation workspace names the foreign one): 404, zero AI-service calls. Forged visibility selectors (query, headers, body): ignored, staff-level analysis, the restricted chunk never sent. No unauthorized data was sent to the provider: only the manifest texts were, and the manifest is provably the dataset-derived synthetic set.
* Retrieval integrity subset (8 cases, real vectors, judged against an independent expectation): evidence in retrieved context, evidence equals the independent expectation, rejected chunks absent, foreign/restricted absent, provenance limited to sent evidence, no untraceable evidence line - 8/8 in both arms. Caveat: generation is the deterministic test stub (no generation call was allowed), and with the inert floor the stub is handed 5 chunks even for the no-relevant cases.

## 12. Comparison with Phase 26 hash mode

| Question | Answer from the data |
|---|---|
| Does the real model separate relevant from irrelevant chunks? | Within a query: yes (mean AUC 0.9992 / 1.0, top-1 19/19). Across queries by absolute value: only partly - relevant chunks 0.65-0.89 vs unrelated 0.51-0.84 overlap |
| Is 0.25 reasonable? | No evidence for it: it is 0.26-0.41 below the lowest unrelated similarity, so it filters nothing |
| Recall@5 | 0 (hash) -> 1 (real) |
| MRR | 0 -> 1 |
| nDCG@5 | 0 -> 0.985 (A1) / 0.993 (A2) |
| No-relevant detection | 0/4 in hash and 0/4 in real (different reasons: hash returned junk above the floor by chance; real returns 5 chunks because every cosine exceeds the floor) |
| Difficult categories | G (no relevant), and D/E for false positives; not ranking |
| Is K = 5 enough? | Yes on this set (Recall 1 from K = 3) |
| Query task | RETRIEVAL_QUERY gave slightly better nDCG@5 (0.9931 vs 0.9848), larger margins over distractors and AUC 1.0, but also more false-positive distractors at K = 5 (0.139 vs 0.113); with 19 positive cases these differences are not significant, and the two arms need different floors |

## 13. Findings that need a human decision (nothing was changed)

1. **The relevance floor is inert with the real provider**, so "no relevant knowledge" behavior does not work in practice (4/4 no-relevant cases got 5 chunks).
2. **Production embeds the retrieval query with `RETRIEVAL_DOCUMENT`** (the same function as chunks) although the provider documents `RETRIEVAL_QUERY` for queries. Both configurations rank this set perfectly; they differ in similarity scale, so this choice and any floor are coupled.
3. Any future floor should be calibrated per model **and per query task**, on a larger set that contains more no-relevant and near-miss queries.

## 14. Tests and mutation checks

`validate-phase26_5-real-embedding.mjs`: 54 checks, offline (cache and manifest integrity and hashes, exact-text provenance, synthetic-only/PII scan, zero generation calls, no secret in any artifact, replay-only-from-cache including a live refusal of an uncached text, production parity, sweep invariants, arm honouring, security, integrity, reproducibility, results currency, database counts).
Mutation-checked and reverted: removing the relevance floor (2 checks fail), breaking Recall (2 fail), ignoring the query task (2 fail; the arms become identical). Regression results are in the final report.

## 15. Limitations

* One model, one provider, one task pair; nothing here ranks embedding models.
* 23 cases, 19 positive, 4 no-relevant: the ranking result (19/19) is a ceiling result on an easy set; the no-relevant findings rest on only 4 cases.
* Labels and corpus by one author; sections are short single chunks; English only; keyword-distractor cases (F) do not actually test keyword traps; no proper-name / numeric-detail cases.
* Cosines are those of the production scoring over full-precision vectors; nothing was normalised or altered.
* Real generation was not evaluated (out of scope and not authorized); the grounding check uses the deterministic stub.

## 16. Phase 26.5A closure: reproducibility and call graph (verification only; no production change, no new external call)

### 16.1 The intermittent "not byte-identical" failure

What was observed: once, in a batched run started while the test stack was booting, the check "two complete offline runs give byte-identical deterministic results" failed. In that same run the FIRST run matched the checked-in results file (currency check passed), so the second run was the one that deviated. The diff was not captured (the diff output was added afterwards).

What was established offline (no external call):

* **Repeated runs, no recurrence:** 8 further complete two-arm runs in ONE process under 3 busy CPU loops (the pattern that restarts every service on the same ports back to back): 8/8 matched the artifact; 3 back-to-back pairs (6 runs) all identical; 4 further full suite runs (one under load) all passed. In total about 25 complete runs after the one failure, none differing.
* **Content sources of nondeterminism reviewed and excluded:** the hashed content has no timestamp, database id, process id or latency (latency and environment are stripped; chunks are referenced by dataset key); ObjectId ordering matters only for exact score ties and real vectors have none (distinct texts); results are built from ordered arrays and stable sorts; all random draws are seeded; the replay lookups are by text hash and deterministic; JSON serialization order is insertion order. A rare ObjectId counter wrap between the 35 chunk ids has a probability around 2e-6.
* **Process-lifecycle hypothesis tested and mostly excluded:** the harness restarted the replay service, proxy and backend on the SAME ports between arms and runs without waiting for the previous process to exit (`kill()` was fire-and-forget), so a lingering process could in principle answer with the wrong arm's query task. Measured: a killed replay service releases its port in about 30 ms (5/5, also under CPU load), and a second process cannot bind a port a live one holds (it exits), so the window is far shorter than the time between arms. It is a possible but unproven contributor, not a demonstrated cause.
* **Root cause: NOT identified.** It cannot be reproduced and no code-level source of nondeterminism was found. The exact limitation is: one unexplained deviation of a second in-process run under concurrent machine activity, with no captured diff.

What was changed (evaluation harness only; production retrieval untouched; measurements unchanged - the regenerated results equal the previous ones apart from the added identity block):

1. `stopProcess` now WAITS for each child to exit and for its port to refuse connections (services, backend); the recording proxy is closed and awaited.
2. `assertPortFree`: a service is never started on a port that still answers (a lingering process now fails loudly instead of possibly serving).
3. Every replay service gets a per-spawn nonce and an identity endpoint (`/v1/eval-replay-info`); the harness verifies 20 times per arm (10 before, 10 after the run) that the process answering is the one it started, replays THIS arm's query task, uses test providers, holds no key and has the socket guard installed; the result records it (`serviceIdentity`). A wrong-process condition can therefore no longer produce silently different numbers.
4. The reproducibility check now compares THREE runs (services restarted between all of them) and, on failure, prints the first differing fields and writes `results/phase26_5-repro-failure.json` so a recurrence is diagnosable.

### 16.2 Real-embedding call graph (traced and now asserted by the suite)

```
backend/evaluation/retrieval/dataset.json                       (synthetic; no database)
  -> export-manifest.mjs: PRODUCTION chunker + buildEmbeddingText + buildRetrievalQueryText   (opens no DB connection: asserted)
  -> results/phase26_5-embedding-manifest.json                  (texts + sha256; provably equals the dataset-derived set)
  -> collect_embeddings.py pre-flight: kinds, hash match, PII patterns, "synthetic" purpose flag, request ceiling (20)
  -> generate_gemini_embeddings / embed_content  -> Gemini embeddings endpoint     [the ONLY external call; 6 requests, 81 texts]
  -> results/phase26_5-real-embedding-cache.json                (vectors + hashes; no key; secret-pattern scan in the suite)
replay (every evaluation run, offline):
  Node harness (global fetch = loopback only) -> recording proxy -> replay_service.py = UNCHANGED production ai-service app
     with only the two embedding calls answered from the cache; providers test/test, no key, non-loopback socket guard
  generation path reachable from the runner: /v1/intelligence/analyze on that process = the deterministic stub (LLM provider "test"), no network
```
* Only synthetic dataset text reaches the provider: the manifest is rebuilt from the dataset in the suite and compared entry by entry; the collector re-checks hashes and PII patterns before any call.
* The collector reads no MongoDB or operational data: it imports no database client (asserted by listing loaded modules), never opens a connection, and its only input file is the manifest.
* No generation/LLM endpoint is reachable from the runner: the collector contains no generation call (static check), the replay service holds no provider client and reports LLM provider `test`, `keyConfigured: false` and the socket guard (verified per arm); the Node process cannot fetch a non-loopback URL.
* The replay path cannot make an external call: it answers only from the cache (an uncached text raises - live check), has no key, and its socket guard raises on any non-loopback connection.
* The API key is never printed: only a boolean is; no artifact contains a key-shaped string (scan in the suite).

### 16.3 Production configuration confirmed unchanged

`gemini-embedding-001` (ai-service settings; `.env` sets the same name), document task `RETRIEVAL_DOCUMENT` (`generate_gemini_embeddings`), query task = the existing production behavior (the retrieval router embeds the query with the same function, i.e. `RETRIEVAL_DOCUMENT`), floor 0.25 (no override present), top-K 5, candidate ceiling 2000. No production file was edited in Phase 26.5 or 26.5A (the one production file touched after Phase 26, `knowledgeRetrievalService.js`, was modified and restored by a mutation check; its content is byte-identical to the pre-mutation copy).
