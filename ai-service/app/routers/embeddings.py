"""
POST /v1/embeddings

Phase 6E: a dedicated endpoint, clearly separate from intelligence
generation (app/routers/intelligence.py). This service's own
EMBEDDING_PROVIDER config decides what actually computes the vectors:
  - "test"   (default) -> deterministic stub, no network call.
  - "gemini"            -> real Gemini embedding call.
  - anything else       -> PROVIDER_NOT_CONFIGURED.

Same server-side-only provider-selection principle as intelligence.py:
the request contract (app/models/embedding.py) has no provider field, and
no workspaceId, MongoDB identifier, or tenant concept of any kind — Node
alone decides which chunks to embed and persists the result.

Provider dispatch itself lives in app/services/embedding_service.py (Phase
6G extracted it there so the retrieval router could reuse it in-process)
— this router is now just the HTTP-shaped wrapper around it.
"""

from fastapi import APIRouter

from app.models.embedding import EmbeddingRequest, EmbeddingResponse
from app.services.embedding_service import generate_embeddings

router = APIRouter()


@router.post("/v1/embeddings", response_model=EmbeddingResponse)
def post_embeddings(payload: EmbeddingRequest) -> EmbeddingResponse:
    return generate_embeddings(payload.texts)
