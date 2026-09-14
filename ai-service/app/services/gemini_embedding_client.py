"""
Real Gemini embedding invocation (Phase 6E).

Used only when this service's own EMBEDDING_PROVIDER=gemini (see
app/routers/embeddings.py and app/config.py — the default remains "test", so
a service with no configuration never attempts a real call). Uses the
official `google-genai` Python SDK's `models.embed_content`, the same SDK
already used for intelligence generation (app/services/gemini_client.py) —
no separate embedding SDK was added.

Model choice: `gemini-embedding-001`, the current generally-available,
text-only Gemini embedding model (a newer `gemini-embedding-2` also exists,
but it is multimodal and does not support `task_type` — unnecessary surface
for embedding plain KnowledgeChunk text). `task_type="RETRIEVAL_DOCUMENT"`
is used because that is exactly what a KnowledgeChunk is: a document meant
to be found by a later query embedding, not the query itself.

Never logs or returns the API key, the raw Gemini error object, its
message, or its response body — only a fixed, safe message and (server-side
only) the exception's type/status code, mirroring gemini_client.py exactly.
"""

import logging

from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import ValidationError

from app.config import settings
from app.exceptions import MalformedResponseError, ProviderError, ProviderNotConfiguredError
from app.models.embedding import EmbeddingResponse

logger = logging.getLogger(__name__)


def _map_embedding_provider_error(exc: Exception) -> Exception:
    """Maps a google-genai SDK exception to a safe internal error. Never
    forwards exc.message/exc.details (Gemini's raw response body) — only
    exc.code/type are ever logged, server-side only."""
    code = getattr(exc, "code", None)
    logger.error("Gemini embedding provider error: %s code=%s", type(exc).__name__, code)

    if code in (400, 401, 403, 404):
        return ProviderError("AI provider is not configured correctly.")
    if code == 429:
        return ProviderError("AI provider is currently rate-limited. Try again shortly.")
    return ProviderError()


def generate_gemini_embeddings(texts: list[str]) -> EmbeddingResponse:
    if not settings.gemini_api_key:
        raise ProviderNotConfiguredError()

    # No retries (attempts=1) — matches gemini_client.py exactly, to avoid
    # silently multiplying free-tier API usage on a transient error.
    client = genai.Client(
        api_key=settings.gemini_api_key,
        http_options=types.HttpOptions(
            timeout=settings.request_timeout_ms,
            retry_options=types.HttpRetryOptions(attempts=1),
        ),
    )

    try:
        response = client.models.embed_content(
            model=settings.embedding_model,
            contents=texts,
            config=types.EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT"),
        )
    except genai_errors.APIError as exc:
        raise _map_embedding_provider_error(exc) from None
    except Exception as exc:  # noqa: BLE001 - last-resort safety net, never re-raised raw
        logger.error("Gemini embedding provider error (unexpected): %s", type(exc).__name__)
        raise ProviderError() from None

    embeddings = response.embeddings or []
    if len(embeddings) != len(texts):
        raise MalformedResponseError("AI provider returned an unexpected number of embeddings.")

    vectors = [list(item.values) if item.values else [] for item in embeddings]

    try:
        return EmbeddingResponse(embeddings=vectors, model=settings.embedding_model)
    except ValidationError:
        raise MalformedResponseError(
            "AI provider returned a response that did not match the expected contract."
        ) from None
