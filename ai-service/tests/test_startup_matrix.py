"""
Phase 36 - the AI service's STARTUP VALIDATION MATRIX.

Every case starts the real service module (`import app.main`) in a subprocess with a FULLY specified environment (so a local .env cannot
influence the result) and asserts the exit status. Startup validation must fail closed: a configuration the service must not run with
makes the process refuse to start, with a message that never contains the key. No network, no Gemini call, no real key (a fake,
unmistakable string is used and its absence from every output is asserted).
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

from app import provider_policy, startup_validation

AI_SERVICE_ROOT = Path(__file__).resolve().parents[1]
APPROVED = "gemini-3.1-flash-lite"
SECRET = "fake-secret-startup-matrix-9f3a7c"

PRODUCTION = {
    "LLM_PROVIDER": "gemini",
    "LLM_MODEL": APPROVED,
    "GEMINI_API_KEY": SECRET,
    "EMBEDDING_PROVIDER": "test",
    "REQUEST_TIMEOUT_MS": "20000",
    "LLM_MAX_OUTPUT_TOKENS": "4096",
}


def start(**overrides):
    env = {**os.environ, **PRODUCTION, **{k: str(v) for k, v in overrides.items()}}
    return subprocess.run([sys.executable, "-c", "import app.main"], cwd=AI_SERVICE_ROOT, env=env, capture_output=True, text=True, timeout=90)


def refused(result, fragment=None):
    assert result.returncode != 0, "the service started with a configuration it must refuse"
    assert SECRET not in result.stdout + result.stderr, "a key value was printed"
    if fragment is not None:
        assert fragment in result.stderr, f"expected {fragment!r} in the refusal; got: {result.stderr[-300:]!r}"


def test_correct_production_configuration_starts():
    result = start()
    assert result.returncode == 0, result.stderr[-400:]
    assert SECRET not in result.stdout + result.stderr


@pytest.mark.parametrize("key", ["", "   "])
def test_missing_or_blank_gemini_key_is_refused(key):
    refused(start(GEMINI_API_KEY=key), "GEMINI_API_KEY is required")


def test_a_gemini_embedding_provider_also_requires_the_key():
    refused(start(LLM_PROVIDER="test", EMBEDDING_PROVIDER="gemini", GEMINI_API_KEY=""), "GEMINI_API_KEY is required")
    assert start(LLM_PROVIDER="test", EMBEDDING_PROVIDER="gemini").returncode == 0


@pytest.mark.parametrize(
    "model",
    ["gemini-3.6-flash", "gemini-3.1-flash-lite-preview", "gemini-flash-latest", "gemini-latest", "models/gemini-3.1-flash-lite", "Gemini-3.1-Flash-Lite", " gemini-3.1-flash-lite", "gemini-3.1-flash", ""],
)
def test_invalid_preview_alias_and_latest_models_are_refused(model):
    refused(start(LLM_MODEL=model), "requires LLM_MODEL")


@pytest.mark.parametrize("timeout", ["0", "-1", "20001", "60000", "1000000000"])
def test_unsafe_gemini_timeouts_are_refused(timeout):
    refused(start(REQUEST_TIMEOUT_MS=timeout), "REQUEST_TIMEOUT_MS")


@pytest.mark.parametrize("timeout", ["abc", "20.5", ""])
def test_a_non_integer_timeout_is_refused(timeout):
    refused(start(REQUEST_TIMEOUT_MS=timeout))


@pytest.mark.parametrize("timeout", ["1", "1000", "20000"])
def test_timeouts_inside_the_ceiling_start(timeout):
    assert start(REQUEST_TIMEOUT_MS=timeout).returncode == 0


@pytest.mark.parametrize("provider", ["gemni", "openai", "", "GEMINI2", "test-python"])
def test_an_unknown_llm_provider_is_refused(provider):
    refused(start(LLM_PROVIDER=provider), "LLM_PROVIDER must be")


def test_an_unknown_embedding_provider_is_refused():
    refused(start(EMBEDDING_PROVIDER="voyage"), "EMBEDDING_PROVIDER must be")


@pytest.mark.parametrize("tokens", ["0", "-5", "8193", "100000"])
def test_an_unbounded_generation_limit_is_refused(tokens):
    refused(start(LLM_MAX_OUTPUT_TOKENS=tokens), "LLM_MAX_OUTPUT_TOKENS")


def test_a_non_integer_generation_limit_is_refused():
    refused(start(LLM_MAX_OUTPUT_TOKENS="lots"))


def test_the_generation_limit_boundaries_start():
    assert start(LLM_MAX_OUTPUT_TOKENS="1").returncode == 0
    assert start(LLM_MAX_OUTPUT_TOKENS="8192").returncode == 0


def test_the_deterministic_test_provider_needs_no_key_and_is_not_governed_by_the_gemini_gates():
    ok = start(LLM_PROVIDER="test", EMBEDDING_PROVIDER="test", GEMINI_API_KEY="", LLM_MODEL="gemini-3.6-flash", REQUEST_TIMEOUT_MS="60000", LLM_MAX_OUTPUT_TOKENS="999999")
    assert ok.returncode == 0, ok.stderr[-300:]


def test_the_gates_are_the_same_functions_the_process_runs():
    # direct calls, so a refusal can be traced to the exact rule
    startup_validation.validate_provider_configuration("gemini", "test", SECRET, 4096)
    startup_validation.validate_provider_configuration("test", "test", "", 0)
    for args in (("gemni", "test", SECRET, 4096), ("gemini", "x", SECRET, 4096), ("gemini", "test", "", 4096), ("gemini", "test", SECRET, 0), ("gemini", "test", SECRET, True), ("gemini", "test", SECRET, 8193)):
        with pytest.raises(RuntimeError, match="Refusing to start"):
            startup_validation.validate_provider_configuration(*args)
    assert startup_validation.MAX_OUTPUT_TOKENS_CEILING == 8192
    assert provider_policy.PROVIDER_TIMEOUT_CEILING_MS == 20000 and provider_policy.APPROVED_MODEL == APPROVED
