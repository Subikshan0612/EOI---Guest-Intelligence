"""
POST /v1/vector-similarity

Phase 6F: a similarity PRIMITIVE, deliberately separate from both
intelligence generation (app/routers/intelligence.py) and embedding
generation (app/routers/embeddings.py). Scores the supplied query vector
against each candidate using cosine similarity and returns the results in
deterministic descending-score order.

This is NOT the Phase 6G retrieval endpoint. It makes no MongoDB query,
calls no embedding or LLM provider, applies no scope/precedence policy, and
selects nothing on its own — Node has already decided the exact candidate
set (and verified it is tenant-scoped) before this is ever called. This
endpoint is read-only: it computes and returns scores, and changes nothing.
"""

from fastapi import APIRouter

from app.models.vector_similarity import (
    SimilarityResult,
    VectorSimilarityRequest,
    VectorSimilarityResponse,
)
from app.services.vector_math import cosine_similarity

router = APIRouter()


@router.post("/v1/vector-similarity", response_model=VectorSimilarityResponse)
def post_vector_similarity(payload: VectorSimilarityRequest) -> VectorSimilarityResponse:
    results = [
        SimilarityResult(
            chunkId=candidate.chunkId,
            score=cosine_similarity(payload.queryEmbedding, candidate.embedding),
        )
        for candidate in payload.candidates
    ]

    # Deterministic order: highest score first; chunkId ascending breaks any
    # tie, so identical scores never depend on unstable iteration order.
    results.sort(key=lambda result: (-result.score, result.chunkId))

    return VectorSimilarityResponse(results=results)
