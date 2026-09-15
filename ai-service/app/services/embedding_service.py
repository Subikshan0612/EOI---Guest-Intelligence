"""
Shared embedding provider dispatch.

Extracted from app/routers/embeddings.py so a second internal caller
(Phase 6G's app/routers/retrieval.py) can request an embedding without a
second HTTP round-trip to this same service. Behavior is unchanged from
Phase 6E: same provider selection, same underlying functions, same
"test" default.
"""

from app.config import settings
from app.exceptions import ProviderNotConfiguredError
from app.models.embedding import EmbeddingResponse
from app.services.deterministic_embedding import generate_deterministic_embeddings
from app.services.gemini_embedding_client import generate_gemini_embeddings


def generate_embeddings(texts: list[str]) -> EmbeddingResponse:
    provider = settings.embedding_provider.strip().lower()

    if provider == "test":
        return generate_deterministic_embeddings(texts)

    if provider == "gemini":
        return generate_gemini_embeddings(texts)

    raise ProviderNotConfiguredError()
