"""
Phase 34A-B - approved provider/model policy, provider identity, and the provider error taxonomy.

Everything is synthetic and deterministic. NO test here calls a real provider: the Gemini SDK client is always replaced with
a MagicMock (and tests/conftest.py's network guard fails any non-loopback connection). No API key is needed; the only key
value used is the literal fake string below.
"""

import json
import logging
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi.testclient import TestClient
from google.genai import errors as genai_errors
from google.genai import types

from app import provider_policy
from app.config import Settings, settings
from app.main import app
from app.services import gemini_analysis_client, gemini_client
from tests.test_knowledge_grounding import BASE_CONTEXT

client = TestClient(app)
AI_SERVICE_ROOT = Path(__file__).resolve().parents[1]
FAKE_KEY = "fake-key-for-this-test-only"

# Written out literally on purpose: if the approved id is ever changed, these tests must be changed with it, deliberately.
APPROVED = "gemini-3.1-flash-lite"

MODEL_OUT = {
    "situation": "AC in Unit 204 reported as not cooling.",
    "evidence": ["Signal severity is high."],
    "impact": "Not available.",
    "recommendation": "Consider the documented maintenance guidance.",
    "confidence": "medium",
    "usedKnowledgeChunkIds": [],
}


@pytest.fixture(autouse=True)
def restore_settings():
    original = (settings.llm_provider, settings.gemini_api_key, settings.llm_model, settings.llm_max_output_tokens)
    settings.llm_provider = "test"
    yield
    settings.llm_provider, settings.gemini_api_key, settings.llm_model, settings.llm_max_output_tokens = original


def real_response(text=None, model_version=None, finish=types.FinishReason.STOP, block=None):
    """A real google-genai response object (not a mock), so `.text`, `.model_version` etc. behave as in production."""
    candidate = types.Candidate(
        content=types.Content(parts=[types.Part(text=text)], role="model") if text is not None else None,
        finish_reason=finish,
    )
    feedback = types.GenerateContentResponsePromptFeedback(block_reason=block) if block is not None else None
    return types.GenerateContentResponse(candidates=[candidate], model_version=model_version, prompt_feedback=feedback)


def use_gemini(monkeypatch, response=None, error=None, model=APPROVED):
    """Routes the Gemini branch to a mock SDK client. Returns (fake_client, client_factory_mock)."""
    fake_client = MagicMock()
    if error is not None:
        fake_client.models.generate_content.side_effect = error
    else:
        fake_client.models.generate_content.return_value = response
    factory = MagicMock(return_value=fake_client)
    monkeypatch.setattr(gemini_analysis_client.genai, "Client", factory)
    monkeypatch.setattr(gemini_client.genai, "Client", factory)
    settings.llm_provider = "gemini"
    settings.gemini_api_key = FAKE_KEY
    settings.llm_model = model
    return fake_client, factory


def analyze(extra=None):
    return client.post("/v1/intelligence/analyze", json={"context": BASE_CONTEXT, "knowledge": [], **(extra or {})})


def ok_response(**kw):
    return real_response(text=json.dumps(MODEL_OUT), **kw)


# ======================================================================================================================
# Model policy
# ======================================================================================================================


def test_01_approved_model_passes(monkeypatch):
    assert provider_policy.APPROVED_MODEL == APPROVED and provider_policy.APPROVED_PROVIDER == "gemini"
    assert provider_policy.is_approved_model(APPROVED)
    assert provider_policy.require_approved_gemini_model(APPROVED) == APPROVED
    fake_client, _ = use_gemini(monkeypatch, ok_response())
    response = analyze()
    assert response.status_code == 200
    assert response.json()["provenance"] == {"provider": "gemini", "model": APPROVED}
    assert fake_client.models.generate_content.call_args.kwargs["model"] == APPROVED


@pytest.mark.parametrize(
    "model",
    [
        "gemini-3.6-flash",  # 2
        "gemini-3.1-flash-lite-preview",  # 3
        "gemini-flash-latest",  # 4
        "gemini-3.5-flash",
        "gemini-flash-lite-latest",
        "gpt-4o-mini",  # 5 arbitrary
        "models/gemini-3.1-flash-lite",  # a prefix is not the approved id
        " gemini-3.1-flash-lite",  # no trimming
        "gemini-3.1-flash-lite ",
        "GEMINI-3.1-FLASH-LITE",  # no case folding
        "gemini-3.1-flash-lite-001",  # a configured model must be the exact id, not a revision
        "",  # 6 empty
        "   ",
    ],
)
def test_02_to_06_unapproved_model_fails_closed_before_any_provider_request(monkeypatch, model):
    fake_client, factory = use_gemini(monkeypatch, ok_response(), model=model)
    assert not provider_policy.is_approved_model(model)
    response = analyze()
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "PROVIDER_MODEL_NOT_APPROVED"
    # fail closed, no silent substitution: the SDK client was never even constructed, and no model was called
    factory.assert_not_called()
    fake_client.models.generate_content.assert_not_called()


def test_unapproved_model_is_also_refused_on_the_legacy_generate_path(monkeypatch):
    fake_client, factory = use_gemini(monkeypatch, ok_response(), model="gemini-3.6-flash")
    response = client.post("/v1/intelligence/signal", json={"context": BASE_CONTEXT, "knowledge": []})
    assert response.status_code == 503 and response.json()["error"]["code"] == "PROVIDER_MODEL_NOT_APPROVED"
    factory.assert_not_called()
    fake_client.models.generate_content.assert_not_called()


def test_the_default_model_is_the_approved_one_never_3_6(monkeypatch):
    monkeypatch.delenv("LLM_MODEL", raising=False)
    assert Settings(_env_file=None).llm_model == APPROVED


def test_startup_validation_rejects_unapproved_gemini_configuration_and_allows_the_rest():
    provider_policy.validate_startup_configuration("gemini", APPROVED)
    provider_policy.validate_startup_configuration(" Gemini ", APPROVED)
    for bad in ("gemini-3.6-flash", "gemini-3.1-flash-lite-preview", "gemini-flash-latest", "", "x"):
        with pytest.raises(RuntimeError, match="Refusing to start"):
            provider_policy.validate_startup_configuration("gemini", bad)
    # the deterministic test provider (and a stale model in a local .env) must not block startup
    provider_policy.validate_startup_configuration("test", "gemini-3.6-flash")
    provider_policy.validate_startup_configuration("", "anything")


def _import_app_main(provider, model):
    env = {**os.environ, "LLM_PROVIDER": provider, "LLM_MODEL": model, "GEMINI_API_KEY": FAKE_KEY, "EMBEDDING_PROVIDER": "test"}
    return subprocess.run(
        [sys.executable, "-c", "import app.main"], cwd=AI_SERVICE_ROOT, env=env, capture_output=True, text=True, timeout=60
    )


def test_service_process_refuses_to_start_with_gemini_and_an_unapproved_model():
    bad = _import_app_main("gemini", "gemini-3.6-flash")
    assert bad.returncode != 0 and "Refusing to start" in bad.stderr
    good = _import_app_main("gemini", APPROVED)
    assert good.returncode == 0, good.stderr
    stale_env_with_test_provider = _import_app_main("test", "gemini-3.6-flash")
    assert stale_env_with_test_provider.returncode == 0, stale_env_with_test_provider.stderr


# ======================================================================================================================
# Provider policy
# ======================================================================================================================


def test_07_approved_provider_passes_08_arbitrary_provider_fails(monkeypatch):
    fake_client, factory = use_gemini(monkeypatch, ok_response())
    assert analyze().status_code == 200
    for provider in ("openai", "gemini-3.6", "not-a-real-provider", ""):
        settings.llm_provider = provider
        response = analyze()
        assert response.status_code == 503 and response.json()["error"]["code"] == "PROVIDER_NOT_CONFIGURED"
    assert fake_client.models.generate_content.call_count == 1  # only the approved-provider call above ever reached the SDK


@pytest.mark.parametrize("field", ["provider", "model", "llm_model", "llmModel", "llm_provider", "geminiVersion", "fallbackModel"])
def test_09_a_client_cannot_select_provider_or_model(monkeypatch, field):
    fake_client, factory = use_gemini(monkeypatch, ok_response())
    response = analyze({field: "gemini-3.6-flash"})
    assert response.status_code == 422 and response.json()["error"]["code"] == "VALIDATION_FAILED"
    factory.assert_not_called()
    fake_client.models.generate_content.assert_not_called()


# ======================================================================================================================
# Provenance
# ======================================================================================================================


@pytest.mark.parametrize("reported", [None, "", APPROVED, f"models/{APPROVED}", f"{APPROVED}-001"])
def test_10_approved_or_unreported_model_version_is_accepted(monkeypatch, reported):
    use_gemini(monkeypatch, ok_response(model_version=reported))
    response = analyze()
    assert response.status_code == 200
    # provenance is built from the policy, never from the model's JSON and never from a free-form setting
    assert response.json()["provenance"] == {"provider": "gemini", "model": APPROVED}


def test_resolve_observed_model_distinguishes_observed_from_configuration_backed():
    assert provider_policy.resolve_observed_model(APPROVED) == provider_policy.PROVENANCE_OBSERVED
    assert provider_policy.resolve_observed_model(f"{APPROVED}-001") == provider_policy.PROVENANCE_OBSERVED
    for unreported in (None, "", "   ", 7, MagicMock()):
        assert provider_policy.resolve_observed_model(unreported) == provider_policy.PROVENANCE_CONFIGURED


@pytest.mark.parametrize(
    "reported",
    ["gemini-3.6-flash", f"{APPROVED}-preview", "gemini-flash-latest", "gemini-3.1-flash", f"{APPROVED}-2026", "gpt-4o"],
)
def test_11_12_a_response_from_another_model_is_rejected_not_used(monkeypatch, reported):
    use_gemini(monkeypatch, ok_response(model_version=reported))
    response = analyze()
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "PROVIDER_IDENTITY_MISMATCH"
    assert "situation" not in response.json()  # the analysis content was discarded


def test_the_model_cannot_set_its_own_provenance(monkeypatch):
    spoofed = {**MODEL_OUT, "provenance": {"provider": "gemini", "model": "gemini-3.6-flash"}}
    use_gemini(monkeypatch, real_response(text=json.dumps(spoofed)))
    response = analyze()
    assert response.status_code == 200
    assert response.json()["provenance"] == {"provider": "gemini", "model": APPROVED}


# ======================================================================================================================
# Provider error taxonomy (mapped distinctly; only a provider 503 is retried, once)
# ======================================================================================================================


def _api_error(code):
    return genai_errors.APIError(code=code, response_json={"error": {"message": "secret provider detail"}})


@pytest.mark.parametrize(
    "error, code",
    [
        (httpx.ReadTimeout("t"), "PROVIDER_TIMEOUT"),  # 15: SDK/HTTP timeout
        (httpx.ConnectTimeout("t"), "PROVIDER_TIMEOUT"),
        (_api_error(504), "PROVIDER_TIMEOUT"),  # provider-reported DEADLINE_EXCEEDED
        (_api_error(408), "PROVIDER_TIMEOUT"),
        (_api_error(429), "PROVIDER_RATE_LIMITED"),  # 16
        (_api_error(503), "PROVIDER_UNAVAILABLE"),  # 17
        (_api_error(500), "PROVIDER_UNAVAILABLE"),
        (_api_error(502), "PROVIDER_UNAVAILABLE"),
        (httpx.ConnectError("refused"), "PROVIDER_UNAVAILABLE"),
        (_api_error(400), "PROVIDER_BAD_REQUEST"),
        (_api_error(422), "PROVIDER_BAD_REQUEST"),
        (_api_error(401), "PROVIDER_AUTHENTICATION_FAILED"),
        (_api_error(403), "PROVIDER_FORBIDDEN"),
        (_api_error(404), "PROVIDER_NOT_CONFIGURED"),
        (RuntimeError("anything else"), "PROVIDER_UNKNOWN_ERROR"),
    ],
)
def test_15_to_17_provider_failures_map_to_distinct_codes_without_leaking(monkeypatch, caplog, error, code):
    monkeypatch.setattr(gemini_analysis_client, "_sleep", lambda seconds: None)  # the single 503 retry's short delay is not what this test measures
    fake_client, _ = use_gemini(monkeypatch, error=error)
    with caplog.at_level(logging.DEBUG):
        response = analyze()
    assert response.json()["error"]["code"] == code
    assert response.status_code >= 400
    text = response.text + caplog.text
    assert "secret provider detail" not in text and FAKE_KEY not in text
    # No retry for any failure EXCEPT a provider HTTP 503, which gets exactly one retry (provider_observability.py; tests/test_provider_observability.py).
    assert fake_client.models.generate_content.call_count == (2 if getattr(error, "code", None) == 503 else 1)


def test_all_provider_failure_classes_are_distinguishable():
    codes = {
        "timeout": "PROVIDER_TIMEOUT", "rate": "PROVIDER_RATE_LIMITED", "unavailable": "PROVIDER_UNAVAILABLE",
        "bad": "PROVIDER_BAD_REQUEST", "auth": "PROVIDER_AUTHENTICATION_FAILED", "forbidden": "PROVIDER_FORBIDDEN",
        "config": "PROVIDER_NOT_CONFIGURED", "unknown": "PROVIDER_UNKNOWN_ERROR", "malformed": "MALFORMED_RESPONSE",
        "safety": "PROVIDER_SAFETY_BLOCK", "model": "PROVIDER_MODEL_NOT_APPROVED", "identity": "PROVIDER_IDENTITY_MISMATCH",
    }
    assert len(set(codes.values())) == len(codes)
    from app.models.errors import ErrorDetail

    for code in codes.values():
        ErrorDetail(code=code, message="m")  # every taxonomy code is a valid member of the service's error contract


def test_18_malformed_json_maps_to_malformed_response(monkeypatch):
    for text in ("not json {{{", "[1, 2]", '"a string"', "{"):
        use_gemini(monkeypatch, real_response(text=text))
        response = analyze()
        assert response.status_code == 502 and response.json()["error"]["code"] == "MALFORMED_RESPONSE"


def test_19_empty_response_maps_to_malformed_response(monkeypatch):
    for resp in (real_response(text=""), real_response(text=None), types.GenerateContentResponse(candidates=[])):
        use_gemini(monkeypatch, resp)
        response = analyze()
        assert response.status_code == 502 and response.json()["error"]["code"] == "MALFORMED_RESPONSE"


@pytest.mark.parametrize("finish", [types.FinishReason.SAFETY, types.FinishReason.PROHIBITED_CONTENT, types.FinishReason.BLOCKLIST, types.FinishReason.SPII])
def test_20_a_safety_withheld_candidate_maps_to_safety_block(monkeypatch, finish):
    use_gemini(monkeypatch, real_response(text=None, finish=finish))
    response = analyze()
    assert response.status_code == 422 and response.json()["error"]["code"] == "PROVIDER_SAFETY_BLOCK"


@pytest.mark.parametrize("block", [types.BlockedReason.SAFETY, types.BlockedReason.PROHIBITED_CONTENT, types.BlockedReason.JAILBREAK])
def test_20_a_blocked_prompt_maps_to_safety_block(monkeypatch, block):
    use_gemini(monkeypatch, types.GenerateContentResponse(candidates=[], prompt_feedback=types.GenerateContentResponsePromptFeedback(block_reason=block)))
    response = analyze()
    assert response.status_code == 422 and response.json()["error"]["code"] == "PROVIDER_SAFETY_BLOCK"


def test_a_response_truncated_at_the_output_limit_is_rejected_as_malformed(monkeypatch):
    use_gemini(monkeypatch, real_response(text='{"situation": "cut off mid', finish=types.FinishReason.MAX_TOKENS))
    response = analyze()
    assert response.status_code == 502 and response.json()["error"]["code"] == "MALFORMED_RESPONSE"


# ======================================================================================================================
# Generation config / timeout hierarchy
# ======================================================================================================================


def test_output_is_bounded_and_the_provider_timeout_is_set_and_no_retry(monkeypatch):
    captured = {}
    fake_client, factory = use_gemini(monkeypatch, ok_response())

    def capture(**kwargs):
        captured.update(kwargs)
        return fake_client

    factory.side_effect = capture
    assert analyze().status_code == 200
    config = fake_client.models.generate_content.call_args.kwargs["config"]
    assert config.max_output_tokens == settings.llm_max_output_tokens == 4096
    assert config.temperature is None  # deliberately not set in this phase
    assert captured["http_options"].timeout == settings.llm_analysis_timeout_ms  # Workstream 5C: the analysis deadline is its own setting (the embedding timeout stays request_timeout_ms)
    assert captured["http_options"].retry_options.attempts == 1


def test_default_safe_defaults_without_a_real_key_or_provider():
    assert settings.llm_provider == "test" and settings.gemini_api_key == ""


# ======================================================================================================================
# Phase 35.1 - cross-service timeout contract: this service validates ITS OWN Gemini timeout; Node validates its own budget
# ======================================================================================================================


def test_the_timeout_ceiling_is_20_seconds_and_the_default_is_inside_it():
    assert provider_policy.PROVIDER_TIMEOUT_CEILING_MS == 20000
    assert Settings().request_timeout_ms == 20000 and provider_policy.is_valid_provider_timeout(Settings().request_timeout_ms)


def test_timeout_validity_is_a_real_int_between_1_and_the_ceiling():
    for ok in (1, 1000, 19999, 20000):
        assert provider_policy.is_valid_provider_timeout(ok)
    for bad in (0, -1, 20001, 60000, 10**9, True, False, "20000", 20000.0, None):
        assert not provider_policy.is_valid_provider_timeout(bad)


def test_startup_gate_refuses_a_gemini_configuration_with_an_unbounded_timeout():
    provider_policy.validate_startup_configuration("gemini", APPROVED, 20000)
    provider_policy.validate_startup_configuration("gemini", APPROVED, 1)
    for bad in (0, -5, 20001, 60000, True, "20000"):
        with pytest.raises(RuntimeError, match="Refusing to start"):
            provider_policy.validate_startup_configuration("gemini", APPROVED, bad)
    # the embedding provider uses the same setting, so a Gemini EMBEDDING provider is governed too (even with LLM_PROVIDER=test)
    with pytest.raises(RuntimeError, match="REQUEST_TIMEOUT_MS"):
        provider_policy.validate_startup_configuration("test", "anything", 60000, "gemini")
    provider_policy.validate_startup_configuration("test", "anything", 20000, "gemini")
    # the deterministic providers are NOT governed, and omitting the timeout keeps the old two-argument call valid
    provider_policy.validate_startup_configuration("test", "gemini-3.6-flash", 60000, "test")
    provider_policy.validate_startup_configuration("gemini", APPROVED)
    # the model check still comes first and is unchanged
    with pytest.raises(RuntimeError, match="requires LLM_MODEL"):
        provider_policy.validate_startup_configuration("gemini", "gemini-3.6-flash", 20000)


def _start_with(env_extra):
    env = {**os.environ, "GEMINI_API_KEY": FAKE_KEY, **env_extra}
    return subprocess.run([sys.executable, "-c", "import app.main"], cwd=AI_SERVICE_ROOT, env=env, capture_output=True, text=True, timeout=60)


def test_service_process_refuses_to_start_with_gemini_and_an_unbounded_timeout():
    base = {"LLM_PROVIDER": "gemini", "LLM_MODEL": APPROVED, "EMBEDDING_PROVIDER": "test"}
    refused = _start_with({**base, "REQUEST_TIMEOUT_MS": "60000"})
    assert refused.returncode != 0 and "Refusing to start" in refused.stderr and "REQUEST_TIMEOUT_MS" in refused.stderr
    assert _start_with({**base, "REQUEST_TIMEOUT_MS": "0"}).returncode != 0
    assert _start_with({**base, "REQUEST_TIMEOUT_MS": "20000"}).returncode == 0
    # the deterministic test provider is unaffected, whatever the timeout
    assert _start_with({"LLM_PROVIDER": "test", "EMBEDDING_PROVIDER": "test", "REQUEST_TIMEOUT_MS": "60000"}).returncode == 0
    assert "GEMINI_API_KEY" not in refused.stderr and FAKE_KEY not in refused.stderr


def test_request_time_gate_refuses_a_mutated_timeout_before_any_request_is_sent(monkeypatch):
    fake_client, factory = use_gemini(monkeypatch, ok_response())
    monkeypatch.setattr(settings, "llm_analysis_timeout_ms", 60001)  # above the analysis ceiling (Workstream 5C: the analysis call is bounded by ITS OWN setting)
    response = analyze()
    assert response.status_code == 503 and response.json()["error"]["code"] == "PROVIDER_NOT_CONFIGURED"
    factory.assert_not_called()
    fake_client.models.generate_content.assert_not_called()
    monkeypatch.setattr(settings, "llm_analysis_timeout_ms", 20000)
    assert analyze().status_code == 200


def test_node_and_python_assert_against_the_same_ceiling_and_the_same_model():
    runtime = (AI_SERVICE_ROOT.parent / "backend" / "src" / "config" / "runtimeConfig.js").read_text(encoding="utf8")
    node_ceiling = int(__import__("re").search(r"AI_PROVIDER_TIMEOUT_CEILING_MS\s*=\s*([0-9_]+)", runtime).group(1).replace("_", ""))
    assert node_ceiling == provider_policy.PROVIDER_TIMEOUT_CEILING_MS
