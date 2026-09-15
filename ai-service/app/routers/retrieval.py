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
boost before returning a deterministically ordered list. Node is
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

from app.exceptions import MalformedResponseError
from app.models.retrieval import KnowledgeRetrievalRequest, KnowledgeRetrievalResponse, RetrievalResult
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

    if len(query_embedding) != len(payload.candidates[0].embedding):
        raise MalformedResponseError(
            "Query embedding dimensionality does not match candidate embeddings."
        )

    results = []
    for candidate in payload.candidates:
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

    return KnowledgeRetrievalResponse(results=results, model=embedding_response.model)
