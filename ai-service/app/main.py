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
"""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.exceptions import AiServiceError
from app.models.errors import ErrorDetail, ErrorResponse
from app.routers import embeddings, health, intelligence

app = FastAPI(title="KOI AI Service")

app.include_router(health.router)
app.include_router(intelligence.router)
app.include_router(embeddings.router)


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
        content=ErrorResponse(error=ErrorDetail(code=exc.code, message=exc.message)).model_dump(),
    )
