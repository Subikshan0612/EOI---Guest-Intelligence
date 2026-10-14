"""
KOI AI service — FastAPI application entry point.

Phase 5 Step 4: real Gemini execution lives in app/services/gemini_client.py,
alongside the deterministic stub from Step 3
(app/services/deterministic_stub.py). Which one runs is decided entirely by
this service's own LLM_PROVIDER config — see app/routers/intelligence.py.

Phase 6E: embedding generation is a separate concern with its own endpoint
(app/routers/embeddings.py), its own provider config (EMBEDDING_PROVIDER),
and its own deterministic/real implementations
(app/services/deterministic_embedding.py, app/services/gemini_embedding_client.py).

Phase 6F: a similarity PRIMITIVE (app/routers/vector_similarity.py) — pure
cosine similarity over vectors the caller supplies, no MongoDB, no provider
call, no retrieval/ranking policy. Not the Phase 6G retrieval endpoint.

Phase 6G: knowledge retrieval (app/routers/retrieval.py) — embeds a Node-
supplied query string (reusing app/services/embedding_service.py) and
ranks Node-selected, tenant-scoped candidates against it (reusing the
Phase 6F cosine similarity primitive) with a deterministic Unit > Property
> Workspace scope preference. Still no MongoDB, no tenant decision, and no
Gemini intelligence generation — this is retrieval only, not RAG.
"""

import hmac

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.config import settings
from app.exceptions import AiServiceError
from app.models.errors import ErrorDetail, ErrorResponse
from app.provider_policy import validate_startup_configuration
from app.startup_validation import validate_provider_configuration
from app.routers import analysis, embeddings, health, intelligence, retrieval, vector_similarity

# Phase 34A-B: with LLM_PROVIDER=gemini the service refuses to start unless LLM_MODEL is exactly the approved model
# (app/provider_policy.py). The deterministic `test` provider is not governed by this check.
# Phase 35.1: the same gate also bounds the Gemini timeout (cross-service contract, see PROVIDER_TIMEOUT_CEILING_MS).
validate_startup_configuration(settings.llm_provider, settings.llm_model, settings.request_timeout_ms, settings.embedding_provider, settings.llm_analysis_timeout_ms)
# Phase 36: and the provider configuration this service owns (known providers, a key for a Gemini provider, a bounded generation).
validate_provider_configuration(settings.llm_provider, settings.embedding_provider, settings.gemini_api_key, settings.llm_max_output_tokens)

# Phase 51: with a service token configured, the schema / docs pages are not published either.
_PROTECTED = bool(settings.ai_service_token)
app = FastAPI(title="KOI AI Service", docs_url=None if _PROTECTED else "/docs", redoc_url=None if _PROTECTED else "/redoc", openapi_url=None if _PROTECTED else "/openapi.json")


@app.middleware("http")
async def require_service_token(request: Request, call_next):
    """Phase 51: when AI_SERVICE_TOKEN is set, only a caller presenting it (the Node backend) may use this service. Health stays open for platform probes. The comparison is
    constant-time and a refusal reveals nothing about the configured value."""
    expected = settings.ai_service_token
    if expected and request.url.path != "/v1/health":
        presented = request.headers.get("x-koi-service-token", "")
        if not hmac.compare_digest(presented.encode("utf-8"), expected.encode("utf-8")):
            return JSONResponse(
                status_code=401,
                # A plain body on purpose: ErrorDetail's code vocabulary is the closed provider-error contract Node maps, and this refusal is not a provider error.
                content={"error": {"code": "UNAUTHORIZED", "message": "This service accepts requests from the KOI backend only."}},
            )
    return await call_next(request)


app.include_router(health.router)
app.include_router(intelligence.router)
app.include_router(analysis.router)
app.include_router(embeddings.router)
app.include_router(vector_similarity.router)
app.include_router(retrieval.router)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """
    Replaces FastAPI's default validation error body with this service's own
    error contract. Never echoes the raw pydantic error internals back to
    the caller — just a fixed, safe message and the VALIDATION_FAILED code.
    """
    return JSONResponse(
        status_code=422,
        content=ErrorResponse(
            error=ErrorDetail(
                code="VALIDATION_FAILED",
                message="The request did not match the expected contract.",
            )
        ).model_dump(),
    )


@app.exception_handler(AiServiceError)
async def ai_service_error_handler(request: Request, exc: AiServiceError) -> JSONResponse:
    """
    Converts an internal AiServiceError (raised by the provider services)
    into this service's error contract. `exc.message` is always one of the
    fixed, safe strings defined in app/exceptions.py — never a raw provider
    exception, its message, or a credential.
    """
    return JSONResponse(
        status_code=exc.status_code,
        content=ErrorResponse(error=ErrorDetail(code=exc.code, message=exc.message, rule=getattr(exc, "rule", None))).model_dump(exclude_none=True),
    )
