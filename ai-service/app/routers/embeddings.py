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
"""

from fastapi import APIRouter

from app.config import settings
from app.exceptions import ProviderNotConfiguredError
from app.models.embedding import EmbeddingRequest, EmbeddingResponse
from app.services.deterministic_embedding import generate_deterministic_embeddings
from app.services.gemini_embedding_client import generate_gemini_embeddings

router = APIRouter()


@router.post("/v1/embeddings", response_model=EmbeddingResponse)
def post_embeddings(payload: EmbeddingRequest) -> EmbeddingResponse:
    provider = settings.embedding_provider.strip().lower()

    if provider == "test":
        return generate_deterministic_embeddings(payload.texts)

    if provider == "gemini":
        return generate_gemini_embeddings(payload.texts)

    raise ProviderNotConfiguredError()
