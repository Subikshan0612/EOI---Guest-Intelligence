"""
KOI AI service — FastAPI application entry point.

Phase 5 Step 3: deterministic Node <-> Python contract. This service does
not call Gemini or any other LLM provider yet — see
app/services/deterministic_stub.py and README.md for exactly what this step
does and does not do.
"""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.models.errors import ErrorDetail, ErrorResponse
from app.routers import health, intelligence

app = FastAPI(title="KOI AI Service")

app.include_router(health.router)
app.include_router(intelligence.router)


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
