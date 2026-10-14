"""
Internal exceptions mapped to the service's error contract
(app/models/errors.py). Every one of these carries a fixed, safe message —
never a raw provider exception, its message, or any credential. Server-side
logging (in the services that raise these) may log a type/status code, but
never the exception's own `.message`/`.details`, which can echo Gemini's
raw response body.
"""


class AiServiceError(Exception):
    code = "PROVIDER_ERROR"
    status_code = 502
    default_message = "AI provider returned an error."

    def __init__(self, message: str | None = None, rule: str | None = None):
        self.message = message or self.default_message
        # Phase 38: an optional STABLE rule constant (never text) saying which structural rule rejected the provider's output.
        self.rule = rule
        super().__init__(self.message)


class ProviderNotConfiguredError(AiServiceError):
    code = "PROVIDER_NOT_CONFIGURED"
    status_code = 503
    default_message = "AI provider is not configured."


class ProviderTimeoutError(AiServiceError):
    code = "PROVIDER_TIMEOUT"
    status_code = 504
    default_message = "AI provider timed out."


class ProviderError(AiServiceError):
    code = "PROVIDER_ERROR"
    status_code = 502
    default_message = "AI provider returned an error."


class MalformedResponseError(AiServiceError):
    code = "MALFORMED_RESPONSE"
    status_code = 502
    default_message = "AI provider returned a malformed response."


# --- Phase 34A-B provider error taxonomy -----------------------------------------------------------------------------
# One class per distinguishable provider failure. `taxonomy` is the internal name (used for server-side logs only);
# `code` is the wire code Node maps (backend/src/services/ai/aiServiceClient.js). Every message is fixed and safe.
# The pre-existing classes above keep their codes, so nothing that already handled them changes.
ProviderNotConfiguredError.taxonomy = "provider_not_configured"
ProviderTimeoutError.taxonomy = "provider_timeout"
ProviderError.taxonomy = "provider_unknown_error"
MalformedResponseError.taxonomy = "provider_malformed_response"


class ProviderRateLimitedError(AiServiceError):
    code = "PROVIDER_RATE_LIMITED"
    # Transport status on this internal hop stays 502, exactly as before this phase (an existing test pins it). The stable
    # discriminator is `code`; Node performs the client-facing HTTP mapping (aiServiceClient.js).
    status_code = 502
    taxonomy = "provider_rate_limited"
    default_message = "AI provider is currently rate-limited. Try again later."


class ProviderUnavailableError(AiServiceError):
    code = "PROVIDER_UNAVAILABLE"
    status_code = 503
    taxonomy = "provider_unavailable"
    default_message = "AI provider is temporarily unavailable."


class ProviderBadRequestError(AiServiceError):
    code = "PROVIDER_BAD_REQUEST"
    status_code = 502
    taxonomy = "provider_bad_request"
    default_message = "AI provider rejected the request."


class ProviderAuthenticationFailedError(AiServiceError):
    code = "PROVIDER_AUTHENTICATION_FAILED"
    status_code = 503
    taxonomy = "provider_authentication_failed"
    default_message = "AI provider credentials were rejected."


class ProviderForbiddenError(AiServiceError):
    code = "PROVIDER_FORBIDDEN"
    status_code = 503
    taxonomy = "provider_forbidden"
    default_message = "AI provider denied access for this configuration."


class ProviderSafetyBlockError(AiServiceError):
    code = "PROVIDER_SAFETY_BLOCK"
    status_code = 422
    taxonomy = "provider_safety_block"
    default_message = "AI provider declined to analyse this content."


class ProviderUnknownError(AiServiceError):
    code = "PROVIDER_UNKNOWN_ERROR"
    status_code = 502
    taxonomy = "provider_unknown_error"
    default_message = "AI provider failed for an unrecognised reason."


# Phase 34A-B provider identity policy (app/provider_policy.py).
class ProviderModelNotApprovedError(AiServiceError):
    """The configured Gemini model is not the approved production model. Raised before any provider request."""

    code = "PROVIDER_MODEL_NOT_APPROVED"
    status_code = 503
    taxonomy = "provider_not_configured"
    default_message = "AI provider is not configured with the approved model."


class ProviderIdentityMismatchError(AiServiceError):
    """The provider reported a model other than the approved one. The response is discarded."""

    code = "PROVIDER_IDENTITY_MISMATCH"
    status_code = 502
    taxonomy = "provider_identity_mismatch"
    default_message = "AI provider reported an unapproved model identity."
