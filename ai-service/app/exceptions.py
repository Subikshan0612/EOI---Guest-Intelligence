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

    def __init__(self, message: str | None = None):
        self.message = message or self.default_message
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
