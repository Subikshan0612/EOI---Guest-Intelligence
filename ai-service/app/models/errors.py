"""
Internal error contract returned by this service. Every non-2xx response
uses this exact shape — never a raw exception, stack trace, credential, or
provider SDK object.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict

ErrorCode = Literal[
    "PROVIDER_NOT_CONFIGURED",
    "PROVIDER_ERROR",
    "PROVIDER_TIMEOUT",
    "MALFORMED_RESPONSE",
    "VALIDATION_FAILED",
]


class ErrorDetail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: ErrorCode
    message: str


class ErrorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    error: ErrorDetail
