"""
Approved production provider policy (Phase 34A-B) - the single authoritative place in this service that says
which Gemini model may run.

  APPROVED_PROVIDER = "gemini"
  APPROVED_MODEL    = "gemini-3.1-flash-lite"   (the exact stable model id; never an alias, never a preview)

Fail closed, never fall back:
  - startup:  with LLM_PROVIDER=gemini and any other model, the service REFUSES TO START (`validate_startup_configuration`).
  - request:  every Gemini call re-checks the configured model BEFORE any request is sent (`require_approved_gemini_model`),
              because `settings` is a mutable singleton and a request must never run an unapproved model.
  - response: `resolve_observed_model` cross-checks the model version the Gemini API itself reports on the response.
Nothing here substitutes another model, and nothing here reads anything from a request: the model is selected by server
configuration only. The deterministic `test` provider is unaffected - this policy applies to the Gemini path only.

HONEST SCOPE OF "VERIFIED": google-genai 2.23.0 exposes `GenerateContentResponse.model_version`. When the API reports it,
it is checked against the approved id (see `resolve_observed_model`). When the API does not report it, provenance is
CONFIGURATION-BACKED: the approved model is what this service was configured (and validated) to call, which is not a
server-side attestation of what executed. This module never presents the latter as the former.
"""

import logging
import re
from enum import Enum

from app.exceptions import ProviderIdentityMismatchError, ProviderModelNotApprovedError, ProviderNotConfiguredError

logger = logging.getLogger(__name__)

APPROVED_PROVIDER = "gemini"
APPROVED_MODEL = "gemini-3.1-flash-lite"

# The API may report the model with a numeric revision suffix (for example "...-001"). Anything else - "-preview",
# a different family, an alias - is NOT the approved model.
_REVISIONED = re.compile(rf"^{re.escape(APPROVED_MODEL)}-\d{{3}}$")

# CROSS-SERVICE TIMEOUT CONTRACT (Phase 35.1). The Gemini SDK timeout (REQUEST_TIMEOUT_MS) must be a positive integer no larger than this
# ceiling. Node's analysis timeout is derived from its own settings and, on the real Gemini route, must EXCEED this number
# (backend/src/config/runtimeConfig.js AI_PROVIDER_TIMEOUT_CEILING_MS; its start-up check enforces that), so this service's provider
# timeout - classified PROVIDER_TIMEOUT - always fires before Node gives up on the call. Each side validates only ITS OWN configuration against
# the one documented number; neither reads the other's settings. The two copies live in different processes, so a test asserts they are equal.
PROVIDER_TIMEOUT_CEILING_MS = 20000

# Workstream 5C - THE ANALYSIS DEADLINE IS A SEPARATE CONCERN. REQUEST_TIMEOUT_MS (above, at most 20 s) keeps bounding the calls that must stay short and independent:
# the embedding call (query embedding for retrieval, knowledge embedding) and the legacy generate path. The Gemini ANALYSIS call - the one request that is allowed to be
# slow, because the hybrid 202 / status architecture (Workstreams 5A, 5B) means no person and no HTTP request is held for its whole length - has its own setting,
# LLM_ANALYSIS_TIMEOUT_MS, bounded by ANALYSIS_DEADLINE_CEILING_MS. Node mirrors this number (backend/src/config/runtimeConfig.js AI_ANALYSIS_DEADLINE_CEILING_MS) and its
# analysis wait must exceed it. 60 s is the largest deadline Workstream 5C considered; it is a CEILING (what may be configured), not the chosen value.
ANALYSIS_DEADLINE_CEILING_MS = 60000

PROVENANCE_OBSERVED = "observed_model_version"
PROVENANCE_CONFIGURED = "configuration"


def _safe(value: object, limit: int = 80) -> str:
    """A bounded, printable rendering for a log line. Model ids are not secrets, but they are untrusted text."""
    text = value if isinstance(value, str) else type(value).__name__
    return "".join(ch if ch.isprintable() else "?" for ch in text)[:limit]


def is_approved_model(model: object) -> bool:
    """Exact match only: no strip, no case folding, no aliases, no prefixes."""
    return isinstance(model, str) and model == APPROVED_MODEL


def require_approved_gemini_model(model: object) -> str:
    """Request-time gate for the Gemini path. Raises BEFORE any request is sent to Gemini."""
    if not is_approved_model(model):
        logger.error("Gemini model policy rejected the configured model: %s", _safe(model))
        raise ProviderModelNotApprovedError()
    return APPROVED_MODEL


def is_valid_provider_timeout(value: object) -> bool:
    """A real int (not a bool), at least 1 ms and at most PROVIDER_TIMEOUT_CEILING_MS."""
    return isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= PROVIDER_TIMEOUT_CEILING_MS


def require_bounded_provider_timeout(value: object) -> int:
    """Request-time gate for the Gemini analysis call (settings is a mutable singleton): raises BEFORE any request is sent."""
    if not is_valid_provider_timeout(value):
        logger.error("Gemini provider timeout is outside 1..%d ms: %s", PROVIDER_TIMEOUT_CEILING_MS, _safe(value))
        raise ProviderNotConfiguredError()
    return int(value)  # type: ignore[arg-type]


def is_valid_analysis_deadline(value: object) -> bool:
    """A real int (not a bool), at least 1 ms and at most ANALYSIS_DEADLINE_CEILING_MS."""
    return isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= ANALYSIS_DEADLINE_CEILING_MS


def require_bounded_analysis_deadline(value: object) -> int:
    """Request-time gate for the Gemini analysis call (settings is a mutable singleton): raises BEFORE any request is sent."""
    if not is_valid_analysis_deadline(value):
        logger.error("Gemini analysis deadline is outside 1..%d ms: %s", ANALYSIS_DEADLINE_CEILING_MS, _safe(value))
        raise ProviderNotConfiguredError()
    return int(value)  # type: ignore[arg-type]


def validate_startup_configuration(
    provider: str, model: object, request_timeout_ms: object = None, embedding_provider: str = "", analysis_timeout_ms: object = None
) -> None:
    """
    Startup gate: a service configured for the real provider must be configured with exactly the approved model, and (when
    `request_timeout_ms` is supplied) with a Gemini timeout inside the cross-service contract. The timeout is checked when
    EITHER the LLM or the embedding provider is Gemini, because both use the same setting. (Workstream 5C) The ANALYSIS deadline
    (`analysis_timeout_ms`, LLM_ANALYSIS_TIMEOUT_MS) is its own setting with its own ceiling and is checked when the LLM provider is Gemini.
    """
    llm_is_gemini = (provider or "").strip().lower() == APPROVED_PROVIDER
    embedding_is_gemini = (embedding_provider or "").strip().lower() == APPROVED_PROVIDER
    if not (llm_is_gemini or embedding_is_gemini):
        return  # the deterministic `test` provider (and any non-Gemini value) is not governed by this policy
    if llm_is_gemini and not is_approved_model(model):
        raise RuntimeError(
            f"LLM_PROVIDER={APPROVED_PROVIDER} requires LLM_MODEL={APPROVED_MODEL} exactly "
            f"(configured: {_safe(model)!r}). Refusing to start; no fallback model is used."
        )
    if request_timeout_ms is not None and not is_valid_provider_timeout(request_timeout_ms):
        raise RuntimeError(
            f"REQUEST_TIMEOUT_MS must be an integer between 1 and {PROVIDER_TIMEOUT_CEILING_MS} milliseconds when a Gemini provider is "
            f"configured (configured: {_safe(request_timeout_ms)!r}). Refusing to start."
        )
    if llm_is_gemini and analysis_timeout_ms is not None and not is_valid_analysis_deadline(analysis_timeout_ms):
        raise RuntimeError(
            f"LLM_ANALYSIS_TIMEOUT_MS must be an integer between 1 and {ANALYSIS_DEADLINE_CEILING_MS} milliseconds when LLM_PROVIDER={APPROVED_PROVIDER} "
            f"(configured: {_safe(analysis_timeout_ms)!r}). Refusing to start."
        )


def _observed_name(value: object) -> str | None:
    if isinstance(value, Enum):
        return str(value.value)
    return value if isinstance(value, str) else None


def resolve_observed_model(observed_model_version: object) -> str:
    """
    Cross-checks the model version the Gemini API reported on the response.

    Returns PROVENANCE_OBSERVED when the API reported a version that is the approved model (optionally with a numeric
    revision suffix), or PROVENANCE_CONFIGURED when the response carried no usable version (configuration-backed only).
    Raises ProviderIdentityMismatchError when the API reported a DIFFERENT model: that response is never used.
    """
    observed = _observed_name(observed_model_version)
    if observed is None or observed.strip() == "":
        return PROVENANCE_CONFIGURED
    candidate = observed.strip().removeprefix("models/")
    if candidate == APPROVED_MODEL or _REVISIONED.fullmatch(candidate):
        return PROVENANCE_OBSERVED
    logger.error("Gemini reported a model version that is not the approved model: %s", _safe(observed))
    raise ProviderIdentityMismatchError()
