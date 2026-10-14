"""
Provider failure classification for the Intelligence V1 Gemini path (Phase 34A-B).

Turns (a) an exception from the google-genai SDK or its HTTP layer and (b) a response that carries no usable text into one
of the distinguishable errors in app/exceptions.py. It never forwards an SDK message, details, response body or key: only
the taxonomy name and numeric status are logged, and the raised errors carry fixed safe messages.

  provider_not_configured / provider_authentication_failed / provider_forbidden   server configuration, not the caller
  provider_rate_limited / provider_unavailable / provider_timeout                  transient provider conditions
  provider_bad_request                                                             the provider refused our request shape
  provider_malformed_response                                                      no/invalid/truncated output
  provider_safety_block                                                            the provider declined the content
  provider_unknown_error                                                           anything unrecognised

No retry, backoff or circuit breaker lives here: classification only.
"""

import logging
from enum import Enum

import httpx
from google.genai import errors as genai_errors
from pydantic import ValidationError

from app.exceptions import (
    AiServiceError,
    MalformedResponseError,
    ProviderAuthenticationFailedError,
    ProviderBadRequestError,
    ProviderForbiddenError,
    ProviderNotConfiguredError,
    ProviderRateLimitedError,
    ProviderSafetyBlockError,
    ProviderTimeoutError,
    ProviderUnavailableError,
    ProviderUnknownError,
)

logger = logging.getLogger(__name__)

# Finish reasons that mean the provider withheld the output for a content-policy reason.
_SAFETY_FINISH_REASONS = {
    "SAFETY",
    "BLOCKLIST",
    "PROHIBITED_CONTENT",
    "SPII",
    "RECITATION",
    "IMAGE_SAFETY",
    "IMAGE_PROHIBITED_CONTENT",
}


def _enum_name(value: object) -> str | None:
    """The member name of an enum (or a plain string), else None. Anything else - including a test double - is ignored."""
    if isinstance(value, Enum):
        return value.name
    return value if isinstance(value, str) else None


def map_status_code(code: object) -> AiServiceError:
    """HTTP status reported by the provider -> taxonomy error."""
    if code == 429:
        return ProviderRateLimitedError()
    if code in (408, 504):  # 504 is the provider's DEADLINE_EXCEEDED
        return ProviderTimeoutError()
    if code == 401:
        return ProviderAuthenticationFailedError()
    if code == 403:
        return ProviderForbiddenError()
    if code == 404:  # the model is not available to this key/project: a configuration problem
        return ProviderNotConfiguredError("AI provider is not configured correctly.")
    if isinstance(code, int) and 400 <= code < 500:
        return ProviderBadRequestError()
    if isinstance(code, int) and 500 <= code < 600:
        return ProviderUnavailableError()
    return ProviderUnknownError()


def map_provider_exception(exc: BaseException) -> AiServiceError:
    """Classifies an exception raised by `client.models.generate_content`. Always returns, never re-raises raw."""
    if isinstance(exc, genai_errors.APIError):
        mapped = map_status_code(getattr(exc, "code", None))
        logger.error("Gemini provider error: %s status=%s", mapped.taxonomy, getattr(exc, "code", None))
        return mapped
    if isinstance(exc, (httpx.TimeoutException, TimeoutError)):
        mapped = ProviderTimeoutError()
    elif isinstance(exc, httpx.TransportError):  # connection refused / reset / DNS: the provider was not reachable
        mapped = ProviderUnavailableError()
    else:
        mapped = ProviderUnknownError()
    logger.error("Gemini provider error: %s (%s)", mapped.taxonomy, type(exc).__name__)
    return mapped


def claim_rule_from_validation_error(exc: ValidationError) -> str:
    """
    A STABLE rule constant for a response whose shape the contract rejected (Phase 38). Derived from the pydantic error LOCATION and type only -
    never from the model's content - so it is deterministic and carries nothing sensitive. Mirrors the Node claim-validator codes.
    """
    for error in exc.errors():
        loc = tuple(str(part) for part in error.get("loc", ()))
        if loc and loc[0] == "claims":
            if "sourceRefs" in loc:
                return "CLAIM_MISSING_SOURCE_REFS"
            if "claimType" in loc:
                return "CLAIM_UNKNOWN_TYPE"
            return "CLAIM_MALFORMED"
    return "RESPONSE_SHAPE_INVALID"


def classify_unusable_response(response: object) -> AiServiceError | None:
    """
    A response with no usable output -> the specific reason, or None when the response looks usable.
    Checked BEFORE the text is read: a blocked prompt or withheld candidate has no text, and that must not be reported as
    a generic malformed response.
    """
    feedback = getattr(response, "prompt_feedback", None)
    block = _enum_name(getattr(feedback, "block_reason", None))
    if block and block != "BLOCKED_REASON_UNSPECIFIED":
        logger.error("Gemini provider safety block: prompt (%s)", block)
        return ProviderSafetyBlockError()

    candidates = getattr(response, "candidates", None)
    first = candidates[0] if isinstance(candidates, (list, tuple)) and candidates else None
    finish = _enum_name(getattr(first, "finish_reason", None))
    if finish in _SAFETY_FINISH_REASONS:
        logger.error("Gemini provider safety block: candidate (%s)", finish)
        return ProviderSafetyBlockError()
    if finish == "MAX_TOKENS":
        logger.error("Gemini provider response truncated at the output token limit")
        return MalformedResponseError("AI provider returned a truncated response.")
    return None
