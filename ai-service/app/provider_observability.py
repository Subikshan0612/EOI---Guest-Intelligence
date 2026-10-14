"""
Provider-call observability and the single-503-retry policy for the Intelligence V1 Gemini path.

Three small, pure pieces (no network, no SDK call, no configuration, no database):

  1. CORRELATION ID. One request id per analysis request, supplied by the Node backend in `X-KOI-Request-Id` (the id Node's own
     request-id middleware already generates, a random uuid). It is accepted ONLY when it is a canonical uuid; anything else is ignored and a
     fresh random uuid4 is generated, so a caller cannot inject free text, an identifier or a log-forging string into the log stream. It
     contains no workspace, user, guest or Signal identifier, it is not an authorization input, and nothing here reads it for any decision.

  2. PROVIDER FAILURE CLASSIFICATION (internal, for logs only; it does not change the public error codes in app/exceptions.py):
       PROVIDER_503      the provider answered HTTP 503
       PROVIDER_504      the provider answered HTTP 504 (its own DEADLINE_EXCEEDED)
       PROVIDER_OTHER    the provider answered some other HTTP error status (4xx, 429, 500, 502, ...)
       PROVIDER_TIMEOUT  the CLIENT side gave up (httpx / OS timeout): no provider status exists
       PROVIDER_UNKNOWN  anything else (a transport error, an unexpected exception): no provider status exists
     A provider status is recorded only when the provider actually reported one; it is never inferred.

  3. RETRY DECISION. Exactly one retry, only for PROVIDER_503, only when the first attempt failed quickly enough that the retry still fits
     inside the Node -> AI-service timeout (see RETRY_FIRST_ATTEMPT_MAX_MS). 504, timeouts, 4xx, 429, 5xx other than 503, transport errors,
     validation errors and everything else are NEVER retried. `decide_retry` is a pure function of (failure, attempt number, elapsed time):
     deterministic and unit-testable; it cannot loop, because attempts are capped at MAX_PROVIDER_ATTEMPTS.

STRUCTURED EVENTS: one JSON line per provider attempt and one per analysis, prefixed `[KOI AI EVENT]` on stdout (the same convention as the Node
backend's `[KOI EVENT]`). Only the field names in ALLOWED_FIELDS can be logged and string values must fit SAFE_TOKEN, so a prompt, a model
output, a Signal text, a guest detail, a header or a key cannot enter a line. The single free-text field, `providerMessage`, is the provider's
own error message for a 5xx answer only (those describe the provider's condition, for example "high demand"): it is sanitised (key-, token- and
e-mail-shaped strings redacted, control characters removed, 200 characters at most). The message of a 4xx answer is never logged, because a
rejected-request message can quote part of the request.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from typing import Callable, Optional

import httpx
from google.genai import errors as genai_errors

# ---------------------------------------------------------------------------------------------------------------------------------------
# 1. Correlation id
# ---------------------------------------------------------------------------------------------------------------------------------------

CORRELATION_HEADER = "x-koi-request-id"
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


def resolve_correlation_id(supplied: object) -> tuple[str, str]:
    """(id, source). `source` is "node" when the caller supplied a canonical uuid, otherwise "generated" (a fresh, random uuid4)."""
    if isinstance(supplied, str) and _UUID.match(supplied.strip()):
        return supplied.strip().lower(), "node"
    return str(uuid.uuid4()), "generated"


# ---------------------------------------------------------------------------------------------------------------------------------------
# 2. Provider failure classification
# ---------------------------------------------------------------------------------------------------------------------------------------

PROVIDER_503 = "PROVIDER_503"
PROVIDER_504 = "PROVIDER_504"
PROVIDER_OTHER = "PROVIDER_OTHER"
PROVIDER_TIMEOUT = "PROVIDER_TIMEOUT"
PROVIDER_UNKNOWN = "PROVIDER_UNKNOWN"
PROVIDER_CATEGORIES = (PROVIDER_503, PROVIDER_504, PROVIDER_OTHER, PROVIDER_TIMEOUT, PROVIDER_UNKNOWN)

_SAFE_TOKEN = re.compile(r"^(?!.*\.\.)[A-Za-z0-9_.:/-]{1,80}$")
_MESSAGE_MAX = 200


@dataclass(frozen=True)
class ProviderFailure:
    category: str
    http_status: Optional[int]  # the status the PROVIDER reported; None when none was reported
    provider_status: Optional[str]  # the provider's own status word (for example UNAVAILABLE), when it reported one
    exception_class: str  # the Python exception class name (a code identifier, never a message)
    message: Optional[str]  # sanitised provider message: 5xx only, otherwise None


def _safe_token(value: object) -> Optional[str]:
    return value if isinstance(value, str) and _SAFE_TOKEN.match(value) else None


_REDACTIONS = (
    (re.compile(r"AIza[0-9A-Za-z_\-]{10,}"), "[redacted]"),  # a Google API key shape
    (re.compile(r"(?i)\bbearer\s+\S+"), "[redacted]"),
    (re.compile(r"(?i)\b(?:key|token|secret|password|authorization)\s*[=:]\s*\S+"), "[redacted]"),
    (re.compile(r"[A-Za-z0-9+/_\-=]{32,}"), "[redacted]"),  # any long opaque token
    (re.compile(r"[\w.+\-]+@[\w\-]+\.[\w.\-]+"), "[redacted]"),  # an e-mail address
    (re.compile(r"https?://\S+"), "[redacted]"),  # a URL (can carry a key in its query string)
)


def sanitize_provider_message(message: object) -> Optional[str]:
    """A provider error message made safe for a log line: redacted, printable, bounded. None when there is nothing usable."""
    if not isinstance(message, str):
        return None
    text = "".join(ch if ch.isprintable() else " " for ch in message)
    # The exact secrets this service holds are removed first, whatever shape they have (a provider message can echo a credential it was sent).
    from app.config import settings  # imported here: this module stays importable without configuration

    for secret in (settings.gemini_api_key, settings.ai_service_token):
        if isinstance(secret, str) and len(secret) >= 4:
            text = text.replace(secret, "[redacted]")
    for pattern, replacement in _REDACTIONS:
        text = pattern.sub(replacement, text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:_MESSAGE_MAX] or None


def classify_provider_exception(exc: BaseException) -> ProviderFailure:
    """Classifies an exception raised by the Gemini SDK call. Never raises, never reads a prompt, a response body or a key."""
    exception_class = _safe_token(type(exc).__name__) or "Exception"
    if isinstance(exc, genai_errors.APIError):
        code = getattr(exc, "code", None)
        status = code if isinstance(code, int) and not isinstance(code, bool) and 100 <= code <= 599 else None
        provider_status = _safe_token(getattr(exc, "status", None))
        if status == 503:
            category = PROVIDER_503
        elif status == 504:
            category = PROVIDER_504
        elif status is not None:
            category = PROVIDER_OTHER
        else:
            category = PROVIDER_UNKNOWN  # an API error that reported no usable status: do not pretend to know one
        message = sanitize_provider_message(getattr(exc, "message", None)) if status is not None and status >= 500 else None
        return ProviderFailure(category, status, provider_status, exception_class, message)
    if isinstance(exc, (httpx.TimeoutException, TimeoutError)):
        return ProviderFailure(PROVIDER_TIMEOUT, None, None, exception_class, None)
    return ProviderFailure(PROVIDER_UNKNOWN, None, None, exception_class, None)


# ---------------------------------------------------------------------------------------------------------------------------------------
# 3. Retry decision: exactly one retry, only for PROVIDER_503
# ---------------------------------------------------------------------------------------------------------------------------------------

MAX_PROVIDER_ATTEMPTS = 2  # the first attempt plus at most ONE retry; nothing here can raise it
RETRY_DELAY_SECONDS = 1.0  # fixed, small and bounded: deterministic (no jitter) so the behaviour is exactly testable
# The retry must still fit inside the Node -> AI-service analysis timeout. The analysis deadline is per attempt (LLM_ANALYSIS_TIMEOUT_MS, at most the cross-service
# ceiling provider_policy.ANALYSIS_DEADLINE_CEILING_MS) and Node waits that ceiling plus a 5 s margin (startup-checked to exceed it; Workstream 5C). The worst case is
# therefore  first attempt + delay + deadline  <=  ceiling + 4 s  <=  Node's wait - 1 s of headroom, i.e. the first attempt may have taken at most 3 s - for EVERY
# permitted deadline. Observed 503s answer in 1.5 - 3.4 s. A 503 that took longer is NOT retried (reason "no_retry_budget") so a retry can never outlive Node's wait.
# The retry rule itself is unchanged by Workstream 5C; a test asserts the arithmetic above against the two ceilings and the 5 s margin.
RETRY_FIRST_ATTEMPT_MAX_MS = 3000

REASON_RETRY_503 = "retry_503"
REASON_NOT_503 = "no_retry_not_503"
REASON_EXHAUSTED = "no_retry_attempts_exhausted"
REASON_BUDGET = "no_retry_budget"


@dataclass(frozen=True)
class RetryDecision:
    retry: bool
    reason: str
    delay_seconds: float


def decide_retry(failure: ProviderFailure, attempt: int, elapsed_ms: float) -> RetryDecision:
    """Pure and deterministic. `attempt` is the 1-based number of the attempt that just failed; `elapsed_ms` is how long that attempt took."""
    if attempt >= MAX_PROVIDER_ATTEMPTS:
        return RetryDecision(False, REASON_EXHAUSTED, 0.0)
    if failure.category != PROVIDER_503:
        return RetryDecision(False, REASON_NOT_503, 0.0)
    if elapsed_ms > RETRY_FIRST_ATTEMPT_MAX_MS:
        return RetryDecision(False, REASON_BUDGET, 0.0)
    return RetryDecision(True, REASON_RETRY_503, RETRY_DELAY_SECONDS)


# ---------------------------------------------------------------------------------------------------------------------------------------
# Structured events
# ---------------------------------------------------------------------------------------------------------------------------------------

ALLOWED_FIELDS = frozenset(
    {
        "correlationId", "correlationSource", "provider", "model", "attempt", "maxAttempts", "outcome", "category", "httpStatus", "providerStatus",
        "exceptionClass", "durationMs", "retryDecision", "retryDelayMs", "providerMessage", "attempts", "retried", "finalOutcome", "finalCategory",
        "finalTaxonomy", "totalDurationMs",
    }
)
_EVENT_NAME = re.compile(r"^[a-z][a-z0-9_.]{2,47}$")


def _default_sink(line: str) -> None:
    print(line, flush=True)


_sink: Callable[[str], None] = _default_sink


def set_event_sink(sink: Optional[Callable[[str], None]]) -> None:
    """Test hook: replace (or, with None, restore) the destination of event lines."""
    global _sink
    _sink = sink if callable(sink) else _default_sink


def emit_event(event: str, **fields: object) -> Optional[dict]:
    """Writes one `[KOI AI EVENT]` line. Unknown fields and values that do not fit are dropped, never serialised. Never raises."""
    try:
        if not isinstance(event, str) or not _EVENT_NAME.match(event):
            return None
        out: dict = {"event": event}
        for key, value in fields.items():
            if key not in ALLOWED_FIELDS or value is None:
                continue
            if isinstance(value, bool):
                out[key] = value
            elif isinstance(value, (int, float)):
                out[key] = round(value) if key.endswith("Ms") else value
            elif isinstance(value, str):
                if key == "providerMessage":
                    clean = sanitize_provider_message(value)
                    if clean:
                        out[key] = clean
                elif key == "correlationId":
                    if _UUID.match(value):
                        out[key] = value.lower()
                elif _SAFE_TOKEN.match(value):
                    out[key] = value
        _sink(f"[KOI AI EVENT] {json.dumps(out, separators=(',', ':'))}")
        return out
    except Exception:  # noqa: BLE001 - a logging problem must never change the outcome of a request
        return None
