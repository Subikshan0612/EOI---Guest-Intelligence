"""
POST /v1/knowledge-retrieval

Phase 6G: ranks Node-selected KnowledgeChunk candidates by relevance to a
Signal's operational context. This is NOT a general RAG/retrieval endpoint
for arbitrary text — the query always comes from Node's own trusted Signal
context (never client-supplied), and every candidate has already been
selected, tenant-scoped, and eligibility-filtered by Node before this is
ever called. This endpoint makes no MongoDB query, no tenant decision, and
does not call Gemini for intelligence generation — it only embeds one
query string (via the same embedding provider Phase 6E already uses),
scores it against the supplied candidate vectors (via the Phase 6F cosine
similarity primitive), and applies a fixed, documented scope-preference
boost before returning a deterministically ordered list.

PHASE 25: a candidate is scored only if its embedding model equals the model that embedded the query AND its
dimension equals the query vector's; anything else is skipped and counted (never compared, never returned). This
service applies NO relevance threshold and no top-K: Node owns both (server-side, authoritative). Node is
responsible for re-verifying every returned chunkId, for the final top-K
selection, and for any persistence, prompting, or UI decision — none of
which happen here (Phase 6H's job, not this endpoint's).

SCOPE PREFERENCE — Unit > Property > Workspace (Phase 6A architecture):
implemented as a small multiplicative boost, not an override. A perfect
Workspace-level match (similarity 1.0) still outranks a barely-relevant
Unit-level one (e.g. similarity 0.3 * 1.15 = 0.345) — the boost is meant to
break ties and near-ties between otherwise comparably relevant chunks, not
to bury a much more relevant broader-scope chunk beneath a barely-relevant
narrow one. See tests/test_retrieval.py for both directions verified.
"""

from fastapi import APIRouter

from app.models.retrieval import KnowledgeRetrievalRequest, KnowledgeRetrievalResponse, RetrievalResult
from app.models.visibility import is_visible
from app.services.embedding_service import generate_embeddings
from app.services.vector_math import cosine_similarity

router = APIRouter()

# Modest, deliberately small multipliers — documented here as the single
# source of truth for the scope-preference policy.
SCOPE_BOOST = {"unit": 1.15, "property": 1.08, "workspace": 1.0}

# Used only as a deterministic tie-breaker (see the sort key below), not as
# part of the score itself.
SCOPE_SPECIFICITY = {"unit": 3, "property": 2, "workspace": 1}


@router.post("/v1/knowledge-retrieval", response_model=KnowledgeRetrievalResponse)
def post_knowledge_retrieval(payload: KnowledgeRetrievalRequest) -> KnowledgeRetrievalResponse:
    embedding_response = generate_embeddings([payload.queryText])
    query_embedding = embedding_response.embeddings[0]

    # Defence in depth: Node has already removed everything above the caller's
    # level; anything that still is above it is ignored, never scored.
    visible_candidates = [c for c in payload.candidates if is_visible(c.visibility, payload.authorizedLevel)]
    if not visible_candidates:
        return KnowledgeRetrievalResponse(results=[], model=embedding_response.model)

    # Phase 25 - embedding compatibility. Cosine similarity is only meaningful between vectors of the SAME
    # embedding model and the SAME dimension. A candidate that fails either test is never compared (and can
    # therefore never reach a prompt); it is counted so Node can tell "nothing relevant" from "nothing comparable".
    query_model = embedding_response.model
    compatible = [
        c for c in visible_candidates if c.embeddingModel == query_model and len(c.embedding) == len(query_embedding)
    ]
    incompatible_count = len(visible_candidates) - len(compatible)

    results = []
    for candidate in compatible:
        similarity_score = cosine_similarity(query_embedding, candidate.embedding)
        retrieval_score = similarity_score * SCOPE_BOOST[candidate.scope]
        results.append(
            RetrievalResult(
                chunkId=candidate.chunkId,
                scope=candidate.scope,
                similarityScore=similarity_score,
                retrievalScore=retrieval_score,
            )
        )

    # Deterministic order: retrievalScore, then similarityScore, then scope
    # specificity, all descending; chunkId ascending breaks any remaining
    # tie so identical scores never depend on unstable iteration order.
    results.sort(
        key=lambda r: (-r.retrievalScore, -r.similarityScore, -SCOPE_SPECIFICITY[r.scope], r.chunkId)
    )

    return KnowledgeRetrievalResponse(
        results=results,
        model=query_model,
        evaluatedCandidates=len(visible_candidates),
        incompatibleCandidates=incompatible_count,
    )
