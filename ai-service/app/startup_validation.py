"""
Startup gate for the provider CONFIGURATION this service owns (Phase 36): known providers, a key when a Gemini provider is configured, and a
bounded generation. Kept apart from app/provider_policy.py on purpose: that module is the MODEL policy (which model may run) and never handles
credentials; this one only checks that a key is PRESENT (a boolean) and never reads, logs or echoes its value.
"""

from app.provider_policy import APPROVED_PROVIDER, _safe

_KNOWN_PROVIDERS = ("test", "gemini")
MAX_OUTPUT_TOKENS_CEILING = 8192


def validate_provider_configuration(
    llm_provider: object, embedding_provider: object, gemini_api_key: object, max_output_tokens: object
) -> None:
    """
    Startup gate for the provider configuration THIS service owns (Phase 36). Fail closed; messages never echo a key.
      - LLM_PROVIDER and EMBEDDING_PROVIDER must each be exactly `test` or `gemini` (a typo no longer starts a service that can only
        answer PROVIDER_NOT_CONFIGURED to every request);
      - a Gemini provider (either one) requires a non-blank GEMINI_API_KEY;
      - with a Gemini LLM provider, LLM_MAX_OUTPUT_TOKENS must be an integer from 1 to MAX_OUTPUT_TOKENS_CEILING (a bounded generation).
    The model identity and the timeout are validated by `validate_startup_configuration` (same module). This does not weaken the
    deterministic `test` provider: it needs no key and has no generation limit.
    """
    llm = llm_provider.strip().lower() if isinstance(llm_provider, str) else None
    emb = embedding_provider.strip().lower() if isinstance(embedding_provider, str) else None
    if llm not in _KNOWN_PROVIDERS:
        raise RuntimeError(f"LLM_PROVIDER must be one of {', '.join(_KNOWN_PROVIDERS)} (configured: {_safe(llm_provider)!r}). Refusing to start.")
    if emb not in _KNOWN_PROVIDERS:
        raise RuntimeError(
            f"EMBEDDING_PROVIDER must be one of {', '.join(_KNOWN_PROVIDERS)} (configured: {_safe(embedding_provider)!r}). Refusing to start."
        )
    if APPROVED_PROVIDER in (llm, emb) and not (isinstance(gemini_api_key, str) and gemini_api_key.strip()):
        raise RuntimeError("GEMINI_API_KEY is required when a Gemini provider is configured. Refusing to start.")
    if llm == APPROVED_PROVIDER:
        ok = isinstance(max_output_tokens, int) and not isinstance(max_output_tokens, bool) and 1 <= max_output_tokens <= MAX_OUTPUT_TOKENS_CEILING
        if not ok:
            raise RuntimeError(
                f"LLM_MAX_OUTPUT_TOKENS must be an integer between 1 and {MAX_OUTPUT_TOKENS_CEILING} for the Gemini provider "
                f"(configured: {_safe(max_output_tokens)!r}). Refusing to start."
            )
