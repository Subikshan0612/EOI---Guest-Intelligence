"""
Internal error contract returned by this service. Every non-2xx response
uses this exact shape — never a raw exception, stack trace, credential, or
provider SDK object.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ErrorCode = Literal[
    "PROVIDER_NOT_CONFIGURED",
    "PROVIDER_ERROR",
    "PROVIDER_TIMEOUT",
    "MALFORMED_RESPONSE",
    "VALIDATION_FAILED",
    # Phase 34A-B provider taxonomy (app/exceptions.py)
    "PROVIDER_RATE_LIMITED",
    "PROVIDER_UNAVAILABLE",
    "PROVIDER_BAD_REQUEST",
    "PROVIDER_AUTHENTICATION_FAILED",
    "PROVIDER_FORBIDDEN",
    "PROVIDER_SAFETY_BLOCK",
    "PROVIDER_UNKNOWN_ERROR",
    "PROVIDER_MODEL_NOT_APPROVED",
    "PROVIDER_IDENTITY_MISMATCH",
]


class ErrorDetail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: ErrorCode
    message: str
    # Phase 38: optional, a fixed constant only (e.g. CLAIM_MISSING_SOURCE_REFS); omitted from the body when absent.
    rule: str | None = Field(default=None, pattern=r"^[A-Z][A-Z_]{2,47}$")


class ErrorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    error: ErrorDetail
