# Retrieval evaluation and grounding harness (Phase 26)

**This is not a production benchmark.** The corpus, the queries and the labels are synthetic and were written by the project; the only embedding
provider available offline is the deterministic TEST embedder, whose vectors are sha256-derived and carry **no meaning**. Phase 26 built and
validated the measuring instrument and ran it against the current pipeline. It **did not measure real semantic retrieval quality**, so it
cannot say whether the 0.25 floor, top-K = 5, or dense-only retrieval is appropriate for real embeddings. No production retrieval setting was changed.

Artifacts: `backend/evaluation/retrieval/{dataset.json, metrics.mjs, lib.mjs, run-evaluation.mjs}`, `backend/evaluation/results/phase26-retrieval-results.json`,
`backend/scripts/validate-phase26-evaluation.mjs`. Regenerate the results with `node evaluation/retrieval/run-evaluation.mjs` (the validation suite fails if the checked-in file is stale).

## 1. Principle: what is being asked

"Given an EOI signal and the available business knowledge, does the current retriever retrieve the knowledge an operator would consider relevant?"
Retrieval quality (sections 5-9), grounding of the generated analysis (section 12) and security isolation (section 13) are reported separately and are never combined. There is no composite "RAG score".

## 2. Dataset (version 1.0.0)

23 retrieval cases + 4 separate security cases, over a synthetic corpus of 17 documents / 35 chunks (33 in the evaluation workspace at the staff ceiling: 1 further chunk is restricted, 1 belongs to another workspace).
All content is labelled synthetic; there is no production data and no personal data (a static scan for e-mail, phone, URL and identifier patterns is part of the validation suite).

| Category | Cases | Pattern |
|---|---|---|
| A direct semantic match | 3 | the signal clearly matches one procedure |
| B paraphrase | 3 | different wording from the knowledge text |
| C terminology variation | 3 | aircon vs air conditioner, bath linen vs towels, elevator vs lift |
| D strong distractor | 3 | sibling sections of the same topic share vocabulary |
| E near-topic distractor | 2 | neighbouring section of the same document |
| F exact-keyword distractor | 2 | a section that shares keywords but is the wrong (even harmful) instruction |
| G no relevant knowledge | 3 | nothing in the corpus applies (museum, praise, system notice) |
| H multiple relevant | 2 | two useful chunks; Recall@K must use the full relevant set |
| I boundary / ambiguous | 2 | the judgment is documented in the case (odour: annotated "no relevant knowledge"; lock light: graded 2, not 3) |
| J security isolation | 4 (separate) | foreign workspace, restricted visibility, forged workspace selector, forged visibility selector |

**Labelling policy.** Grade 0 irrelevant (a listed grade-0 chunk is an explicit distractor, tagged strong / near-topic / exact-keyword); 1 related but insufficient; 2 relevant/useful; 3 directly applicable/decisive.
Every label carries a written rationale. **Binary relevance = grade >= 2** (Recall, MRR, hit rate); all grades feed nDCG (gain 2^grade - 1). A case with no chunk graded >= 2 is a "no relevant knowledge" case; this includes one judgment case (odour) whose two grade-1 chunks are plausible but insufficient.
These are the project's evaluation annotations, not objective truth; they were written by the same author who wrote the corpus, which is a known bias (section 16).
No `acceptableAlternativeChunkIds` field is used: alternatives are simply additional chunks with grade >= 2, and Recall@K then requires the whole set.

Dataset validation (suite `D` checks): unique case ids; every label resolves to a real document section (and, after ingestion, to a real chunk); every label has a >= 20-character rationale and a valid grade; every relevant chunk is in the evaluation workspace at or below the staff ceiling;
no-relevant cases have no relevant chunk; at least two multi-relevant cases; category coverage; security cases forbid only foreign/restricted chunks; no PII pattern; no answer-bearing procedure phrases in queries.

## 3. What is evaluated (and what is not re-implemented)

Documents are ingested through the production services (`createKnowledgeDocument` -> `rebuildChunksForDocument` -> `embedKnowledgeDocument`, so the real chunker and embedding path). Each query runs through the production `scoreKnowledgeForContext`
(paged candidate selection with workspace/visibility/scope filters, embedding compatibility, Python scoring, Node re-verification) and the production `selectRelevantResults` (floor on raw cosine, de-duplication, stable order, top-K).
The harness only varies the floor and K it passes to that function. **Production change made for this:** `retrieveKnowledgeForContext` was split into `scoreKnowledgeForContext` + selection (a pure refactor, behavior unchanged, proven by the Phase 25 suite and by a per-case PARITY check in the harness:
at the baseline the harness selection equals the production function's output in all 23 cases, both modes). Nothing else in production changed.

**Two modes, never mixed or averaged:**

* **hash** - the real pipeline with the test embedder. It measures the pipeline under a *no-signal* retriever. Its numbers must be read against the seeded random-ranking baseline (section 8), not as quality.
* **oracle** - the real pipeline with chunk vectors *constructed from the labels* (grade 3 = cosine 0.85 to the query, grade 2 = 0.70, grade 1 = 0.45, strong distractor 0.50, exact-keyword 0.40, near-topic 0.32, unlabelled 0.02-0.15, foreign/restricted 0.98). These values are my design; results follow from them by construction. It validates the harness, the metrics and the sweeps and shows what a retriever *with that behavior* would score. It says nothing about any real embedding model.

## 4. Baseline configuration

Dense retrieval; embedding provider `test` (deterministic, sha256-derived, no semantics), model `deterministic-embedding-v1`, 32 dimensions; cosine similarity (ai-service `vector_math`) ranked by cosine x scope boost (unit 1.15, property 1.08, workspace 1.0),
floor 0.25 applied to the **raw** cosine (provisional Phase 25 value, unchanged), top-K 5, candidate pages of 200 with a 2000-chunk ceiling, staff ceiling, seeded random baseline (seed 20260928, 400 draws per case). Recorded in the results file with the dataset sha256 (`6cdb793c...`).

## 5. Metric definitions

Positive case = at least one relevant (grade >= 2) chunk; no-relevant case = none. All ranking metrics use only the K returned chunks (after the floor); "returned" always means after the floor.

* **Recall@K** = |relevant chunks in the top K| / |all relevant chunks of the case|, averaged over positive cases (full relevant set).
* **Hit rate@K** = share of positive cases with at least one relevant chunk in the top K (the "at least one relevant chunk in top-5" figure).
* **MRR@K** = mean over positive cases of 1 / rank of the first relevant chunk (0 if none in the top K).
* **nDCG@K** = DCG / ideal DCG, DCG = sum over ranks i of (2^grade - 1) / log2(i + 1); unlabelled returned chunks have grade 0; the ideal uses all of the case's labels.
* **No-relevant detection rate** = share of no-relevant cases where the retriever returned nothing. An empty result on a no-relevant case is correct and is never counted as a failure; it is reported separately from the positive cases.
* **Empty result on positive cases** = share of positive cases where nothing was returned (the floor removed everything although relevant knowledge exists).
* **False-positive rate** = returned explicit grade-0 distractors / all returned chunks (all cases). Returned grade-1 chunks and unlabelled chunks are counted separately (`grade1Returned`, `unlabelledReturned`) and are *not* false positives; "cases returning an explicit distractor" is also reported.
* **Threshold rejection rate** = candidates dropped by the floor / candidates scored (summed over cases).
* Random baseline = expected Recall/hit/MRR/nDCG of a random order of each case's candidates (seeded shuffles, no floor). Uncertainty = seeded bootstrap standard error over the 19 positive cases.

## 6. Results: baseline (floor 0.25, K = 5)

| | hash (real pipeline, no-signal embedder) | oracle (designed fixture) |
|---|---|---|
| Recall@5 | 0 | 1 |
| Hit rate@5 | 0 | 1 |
| MRR | 0 | 1 |
| nDCG@5 | 0 | 0.9991 |
| No-relevant detection (4 cases) | 0 (0/4) | 0.75 (3/4) |
| Empty result on positive cases | 0.0526 (1/19) | 0 |
| False-positive rate | 0.0385 (2 of 52 returned) | 0.38 (19 of 50 returned) |
| Cases returning an explicit distractor | 2 | 16 |
| Threshold rejection rate | 0.9315 | 0.9341 |
| Mean chunks returned per case | 2.26 | 2.17 |

Reading: the **hash** row is what a retriever with no relevance signal produces. Its numbers are not evidence about real embeddings. The **oracle** row is true by construction (relevant chunks were placed above the floor, distractors near it); its false-positive rate of 0.38 is a direct consequence of my chosen distractor cosines (0.32-0.50) being above the 0.25 floor.

## 7. Threshold sweep (K = 5)

**hash** (Recall/hit/MRR/nDCG at floors <= 0.20 are identical because the ordering does not change until the floor passes the relevant chunks' similarities, all <= 0.2435):

| floor | Recall@5 | hit@5 | MRR | nDCG@5 | no-relevant detected | false-positive rate | empty on positive | rejected/scored | returned | distractors returned |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 0.2368 | 0.2632 | 0.0789 | 0.0981 | 0 | 0.0348 | 0 | 0.4928 | 115 | 4 |
| 0.05 | 0.2368 | 0.2632 | 0.0789 | 0.0981 | 0 | 0.0348 | 0 | 0.6061 | 115 | 4 |
| 0.10 | 0.2368 | 0.2632 | 0.0789 | 0.0981 | 0 | 0.0348 | 0 | 0.7128 | 115 | 4 |
| 0.15 | 0.2368 | 0.2632 | 0.0789 | 0.0981 | 0 | 0.0381 | 0 | 0.8235 | 105 | 4 |
| 0.20 | 0.2368 | 0.2632 | 0.0789 | 0.0981 | 0 | 0.0471 | 0 | 0.8841 | 85 | 4 |
| 0.25 | 0 | 0 | 0 | 0 | 0 | 0.0385 | 0.0526 | 0.9315 | 52 | 2 |
| 0.30 | 0 | 0 | 0 | 0 | 0.5 | 0.0606 | 0.2105 | 0.9565 | 33 | 2 |
| 0.35 | 0 | 0 | 0 | 0 | 0.5 | 0 | 0.5789 | 0.9816 | 14 | 0 |
| 0.40 | 0 | 0 | 0 | 0 | 1 | 0 | 0.7368 | 0.9934 | 5 | 0 |
| 0.45 | 0 | 0 | 0 | 0 | 1 | 0 | 0.8947 | 0.9974 | 2 | 0 |
| 0.50 | 0 | 0 | 0 | 0 | 1 | n/a | 1 | 1 | 0 | 0 |
| 0.60 | 0 | 0 | 0 | 0 | 1 | n/a | 1 | 1 | 0 | 0 |
| 0.70 | 0 | 0 | 0 | 0 | 1 | n/a | 1 | 1 | 0 | 0 |
| 0.80 | 0 | 0 | 0 | 0 | 1 | n/a | 1 | 1 | 0 | 0 |

**oracle** (designed fixture; the steps in this table are produced by the cosines I designed - 0.85/0.70/0.45/0.50/0.40/0.32 - and are not findings):

| floor | Recall@5 | hit@5 | MRR | nDCG@5 | no-relevant detected | false-positive rate | empty on positive | rejected/scored | returned | distractors returned |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 1 | 1 | 1 | 0.9991 | 0 | 0.1652 | 0 | 0 | 115 | 19 |
| 0.05 | 1 | 1 | 1 | 0.9991 | 0 | 0.1652 | 0 | 0.2227 | 115 | 19 |
| 0.10 | 1 | 1 | 1 | 0.9991 | 0 | 0.1652 | 0 | 0.585 | 115 | 19 |
| 0.15 | 1 | 1 | 1 | 0.9991 | 0.75 | 0.38 | 0 | 0.9341 | 50 | 19 |
| 0.20 | 1 | 1 | 1 | 0.9991 | 0.75 | 0.38 | 0 | 0.9341 | 50 | 19 |
| 0.25 | 1 | 1 | 1 | 0.9991 | 0.75 | 0.38 | 0 | 0.9341 | 50 | 19 |
| 0.30 | 1 | 1 | 1 | 0.9991 | 0.75 | 0.38 | 0 | 0.9341 | 50 | 19 |
| 0.35 | 1 | 1 | 1 | 0.9991 | 0.75 | 0.225 | 0 | 0.9473 | 40 | 9 |
| 0.40 | 1 | 1 | 1 | 0.9991 | 0.75 | 0.225 | 0 | 0.9473 | 40 | 9 |
| 0.45 | 1 | 1 | 1 | 0.9991 | 0.75 | 0.1389 | 0 | 0.9526 | 36 | 5 |
| 0.50 | 1 | 1 | 1 | 0.9666 | 1 | 0.1923 | 0 | 0.9657 | 26 | 5 |
| 0.60 | 1 | 1 | 1 | 0.9666 | 1 | 0 | 0 | 0.9723 | 21 | 0 |
| 0.70 | 1 | 1 | 1 | 0.9666 | 1 | 0 | 0 | 0.9723 | 21 | 0 |
| 0.80 | 0.9211 | 0.9474 | 0.9474 | 0.9027 | 1 | 0 | 0.0526 | 0.975 | 19 | 0 |

**What the sweep does and does not show.** The instrument works: raising the floor monotonically reduces returned chunks and raises the rejection rate, no-relevant detection rises as weak chunks disappear, and a floor above the relevant chunks' similarity starts to remove relevant knowledge (oracle 0.80). Which floor is right is determined entirely by the similarity distribution of the embedding model, and no such distribution is available:
the hash embedder's relevant and irrelevant chunks are statistically identical (section 9), and the oracle distribution is a design. **No best threshold is declared, and none can be inferred from these runs. Several thresholds are indistinguishable on this data** (oracle 0.15-0.30, and 0.60-0.70, give identical rows).

## 8. Top-K sweep

Floor 0.25:

| K | hash Recall | hash hit | hash MRR | hash nDCG | oracle Recall | oracle hit | oracle MRR | oracle nDCG | oracle FPR | oracle returned |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 0 | 0 | 0 | 0 | 0.9474 | 1 | 1 | 1 | 0 | 20 |
| 3 | 0 | 0 | 0 | 0 | 1 | 1 | 1 | 0.9991 | 0.38 | 50 |
| 5 | 0 | 0 | 0 | 0 | 1 | 1 | 1 | 0.9991 | 0.38 | 50 |
| 8 | 0 | 0 | 0 | 0 | 1 | 1 | 1 | 0.9991 | 0.38 | 50 |
| 10 | 0 | 0 | 0 | 0 | 1 | 1 | 1 | 0.9991 | 0.38 | 50 |

Floor 0.00 (ranking quality independent of the floor), with the random-ranking reference of the hash run (expected metric of a random order of each case's candidates):

| K | hash Recall | hash hit | hash MRR | hash nDCG | random Recall | random hit | random MRR | random nDCG | oracle Recall | oracle nDCG |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 0 | 0 | 0 | 0 | 0.0273 | 0.0303 | 0.0303 | 0.0309 | 0.9474 | 1 |
| 3 | 0.0263 | 0.0526 | 0.0263 | 0.0112 | 0.0859 | 0.0946 | 0.0576 | 0.0626 | 1 | 0.9991 |
| 5 | 0.2368 | 0.2632 | 0.0789 | 0.0981 | 0.156 | 0.1699 | 0.0769 | 0.0945 | 1 | 0.9991 |
| 8 | 0.3158 | 0.3684 | 0.0943 | 0.1295 | 0.2469 | 0.2668 | 0.0911 | 0.1266 | 1 | 0.9991 |
| 10 | 0.3158 | 0.3684 | 0.0943 | 0.1315 | 0.3086 | 0.3317 | 0.0964 | 0.1447 | 1 | 0.9991 |

The hash retriever's ranking metrics sit at the level of random ordering: at K = 5 Recall 0.2368 vs 0.156 random, with a bootstrap standard error of 0.0916 over 19 positive cases (hit rate 0.0971, MRR 0.031, nDCG 0.0379); the differences are about one standard error or less, i.e. **not distinguishable from chance**.
The oracle K-sweep is again a property of the design (Recall@1 < 1 only because two cases have two relevant chunks). **Whether top-K = 5 is sufficient cannot be concluded**: on the oracle fixture K = 3 already reaches Recall 1, but that reflects where I placed the relevant chunks, and on the hash retriever no K helps.
The corpus has only 33 candidates per case and at most two relevant chunks per case; a larger real corpus changes the answer.

## 9. Similarity distributions (evidence about the floor)

Raw cosine of every scored (case, chunk) pair by label:

| label | count | hash: min / median / max | oracle: min / median / max |
|---|---|---|---|
| grade 3 | 19 | -0.4604 / -0.0011 / 0.2372 | 0.85 / 0.85 / 0.85 |
| grade 2 | 2 | 0.0087 / 0.0087 / 0.2435 | 0.70 / 0.70 / 0.70 |
| grade 1 | 10 | -0.1566 / 0.0183 / 0.1678 | 0.45 / 0.45 / 0.45 |
| distractor (grade 0) | 19 | -0.4795 / 0.0303 / 0.3162 | 0.32 / 0.32 / 0.50 |
| unlabelled | 709 | -0.5619 / 0.0045 / 0.4721 | 0.0202 / 0.0839 / 0.15 |

With the hash embedder the relevant chunks are indistinguishable from unlabelled ones (median -0.0011 vs 0.0045); every relevant chunk is below the 0.25 floor (largest 0.2435), so the floor removes **all 19** relevant chunks (taxonomy: 19 x `miss_relevant_below_floor`) and rejects 93% of everything scored.
That is a property of a hash embedder (unrelated texts about N(0, 0.18)), and is the expected reason the floor cannot be judged here. For real embedding models the whole question is where the relevant and irrelevant distributions sit, which is exactly what re-running this harness with a real model would show.

## 10. Failure taxonomy

Measured automatically (baseline, per case): **hash** 19 x relevant chunk below the floor, 4 x false retrieval on a no-relevant case (all four returned unrelated chunks: 1, 2, 5 and 2 chunks); **oracle** 19 x full recall, 3 x correct no-relevant, 1 x retrieval on a no-relevant case (the judgment case `boundary_odour_01`, which returned its two grade-1 chunks - related but, by annotation, insufficient).

| Category | Status on this run |
|---|---|
| threshold problem | measured: the floor removes all relevant chunks under the hash embedder (19/19); not attributable to the floor's suitability for real embeddings |
| missing knowledge | measured: cases G1-G3 have no relevant chunk by construction; the hash retriever returned unrelated chunks for all of them |
| ambiguous relevance | present by design (`boundary_odour_01`, `boundary_lock_01`); their handling is a labelling judgment, documented per case |
| embedding compatibility | none: 0 incompatible candidates in every case (Phase 25 covers the rule) |
| chunking | none observed: every section became exactly one chunk, none was split or merged (35 sections, 35 chunks) |
| lexical mismatch, semantic mismatch, exact-term, proper-name, numerical/detail failures | **not diagnosable**: they describe why a *real* embedder fails; the hash embedder fails everything equally, and the oracle fails nothing by design. The dataset has cases aimed at each pattern (B, C, D, E, F; no proper-name or numeric-detail cases yet), so the taxonomy can be filled in when a real model is evaluated |

## 11. Dense baseline and what it does or does not justify

The baseline is stated as: dense retrieval + `deterministic-embedding-v1` (test) + cosine x scope boost + floor 0.25 on raw cosine + top-K 5. Nothing was compared against another method: no BM25, hybrid or reranker implementation exists in the repository, and none was added.
The data here provide **no evidence for or against** dense-only sufficiency, hybrid retrieval or reranking.

## 12. Grounding evaluation (8 cases, deterministic providers, oracle vectors, production floor 0.25 and top-K 5)

Cases: `direct_ac_01`, `paraphrase_ac_01`, `strong_distractor_filter_01`, `keyword_smoke_01`, `multi_ac_01`, `terminology_elevator_01`, `none_museum_01`, `boundary_odour_01`; run through the canonical `analyzeSignal` with the recording proxy capturing the exact model request.
Checks are judged against an **independent** expectation (raw similarity >= 0.25, best five by retrieval score), not against the production selection, so a broken floor cannot pass its own check (mutation-tested).

| Check | Result |
|---|---|
| A cited evidence appears in the retrieved context (ids, stored chunk text, and cited section labels) | 8/8 |
| B0 the evidence sent equals the independent expectation | 8/8 |
| B rejected chunks (below the floor or beyond top-K) are absent (ids and text) | 8/8 |
| C foreign-workspace and restricted chunks (cosine 0.98) are absent, including the foreign marker text | 8/8 |
| D provenance references only evidence that was sent (stored and public) | 8/8 |
| E with nothing relevant retrieved there is no fabricated knowledge evidence, provenance or cited chunk | 8/8 |
| F every evidence line is an operational template or a cited retrieved section (no untraceable line) | 8/8 |
| decisive (grade 3) chunk present in the evidence | 6/6 cases that have one |

`none_museum_01` sent no knowledge and produced confidence `low` with the "no relevant documented Business Knowledge was retrieved" line; `boundary_odour_01` sent its two grade-1 chunks (confidence `medium`) - the deterministic stub treats any supplied guidance as usable, which is a stub property, not a finding about the pipeline.
**Limitation:** the analysis text is a template built from the supplied context and evidence, so traceability holds largely by construction; this checks the evidence flow and boundaries, not the faithfulness of a real language model. No new provenance schema was introduced.

## 13. Security and isolation (evaluated separately; never in the quality denominator)

Oracle vectors place the forbidden chunks at cosine 0.98, above every legitimate chunk, so only authorization can exclude them.

| Case | Result |
|---|---|
| foreign-workspace chunk | never a candidate, never scored; every case saw exactly the 33 legitimate chunks |
| restricted-visibility chunk | never a candidate, never scored (staff ceiling) |
| forged workspace selector (operator of the evaluation workspace names the foreign one, real backend, real token) | 404, zero AI-service calls |
| forged visibility selectors (query, headers and body: restricted / admin) | ignored: 201 at the staff level, restricted chunk never reached the model |

The quality denominators contain only legitimate candidates (asserted: every case in both modes has exactly 33 eligible, 33 compatible, 0 incompatible candidates).

## 14. Offline safety and reproducibility

* Offline guards: the CLI refuses to start if the **launching shell** carries a real provider key, a non-loopback AI URL or a non-test provider (checked before `backend/.env` is loaded); keys that `backend/.env` injects afterwards (the Node side never reads them) are scrubbed and reported by name (`GEMINI_API_KEY` in this environment). A private ai-service is started with `LLM_PROVIDER=test`, `EMBEDDING_PROVIDER=test` and empty keys, its embedding model is probed, and global `fetch` is wrapped so any non-loopback request throws. External AI calls: 0.
* Reproducibility: two complete runs give byte-identical deterministic results (hash `31ca2eb5...`; rankings, scores, metrics, sweeps, taxonomy, grounding, security); latency is the only non-deterministic field and is stored separately (`timing`, about 9-12 ms mean per query) and excluded. The checked-in results file is verified current by the suite. Database identifiers never appear in the results (chunks are referenced by dataset key).
* The harness never touches operational data: throwaway workspaces are removed; counts before and after are identical (User 1, WorkspaceMembership 1, Workspace 1, Property 2, Unit 21, Guest 10, Stay 10, Signal 3, Intelligence 1, KnowledgeDocument 1, KnowledgeChunk 22, ImportBatch 1, Conversation 3, Message 12, Decision 33, Action 32, Outcome 32).

## 15. Validation of the harness itself

`validate-phase26-evaluation.mjs` (98 checks): dataset quality, metric definitions against hand-computed values (multi-relevant Recall, MRR, graded nDCG, no-relevant handling, false positives, the random baseline, the bootstrap), the offline guards, and the run itself (real ingestion, production parity, sweep invariants that must hold for any retriever - monotonic returned chunks / rejection rate / K - the oracle properties that hold by construction, security, grounding, reproducibility, currency of the results file, production defaults untouched).
Mutation-checked: removing the floor from the production selection makes 6 checks fail, and breaking the Recall definition makes 8 fail; both mutations were reverted.

## 16. Limitations

* **No real semantic evaluation was possible.** No safe local semantic embedder exists in the repository and no external call is allowed; downloading a model was out of scope. Every semantic-quality question is unresolved (section 17).
* The oracle mode is a fixture, not a measurement; its numbers must never be quoted as retrieval quality.
* 23 cases (19 positive) is small: the bootstrap standard error of Recall@5 is about 0.09; differences smaller than roughly 0.2 are not distinguishable from case sampling.
* Labels and corpus were written by the same author, the corpus is small (33 candidates per query, mostly one procedure per topic), sections are short single chunks (no chunking stress), all queries are English and clean; no proper-name, numeric-detail, multi-signal, typo or long-description cases yet.
* The retrieval query is the signal's type, title and description only (Phase 25); richer queries belong to a later phase.
* Timing is measured against the tiny test corpus and the in-process embedder; it says nothing about production latency.

## 17. Unresolved questions and what the next retrieval experiment should be

Unresolved by this phase: (1) is the 0.25 floor appropriate for the real embedding model, (2) is top-K 5 sufficient on a realistic corpus, (3) is dense-only retrieval good enough, (4) would BM25/hybrid or a reranker improve results, (5) do real embeddings separate distractors (strong, near-topic, exact-keyword) from relevant chunks.

Recommendation (no method is declared best): the decisive next step is to **run this same harness and dataset with the real embedding model**, in a phase where external embedding calls are explicitly authorized (the harness currently refuses them by design and would need a deliberate, separate opt-in). That single run produces, for the first time, the real similarity distributions per label (section 9), the real threshold and K curves (sections 7-8), the real failure taxonomy (section 10) and a real random-baseline comparison.
Before that run, enlarge and diversify the dataset (target several times the current 19 positives, including proper-name, numeric-detail, longer and noisier signals, and labels from a second annotator) so the standard error does not swamp the comparison.
Only after a real dense baseline exists should alternatives be **measured against it on the same set** - a lexical (BM25) scorer as a measurement-only baseline, hybrid fusion, and a reranker - and only if the taxonomy shows failures those methods address (lexical/exact-term failures point toward lexical or hybrid signals; ranking failures inside the floor point toward reranking; floor failures point toward recalibration). None of that is implemented or claimed here.
