"""
Tests for the LLM_PROVIDER branching logic and the real Gemini client's
error handling — all deterministic, none require a real Gemini API call or
network access.

The "provider not configured"/"unsupported provider" cases are tested by
overriding `app.config.settings` directly (fails fast, before any network
call is attempted). The actual Gemini SDK call is exercised with a
monkeypatched client so the error-mapping and response-parsing logic is
proven without ever leaving this process.
"""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from google.genai import errors as genai_errors

from app.config import settings
from app.main import app
from app.services import gemini_client

client = TestClient(app)

VALID_REQUEST = {
    "context": {
        "signal": {
            "id": "sig1",
            "type": "maintenance",
            "source": "system",
            "severity": "high",
            "status": "new",
            "title": "AC not cooling",
            "description": "Warm air since last night.",
            "occurredAt": "2026-01-01T00:00:00.000Z",
            "detectedAt": "2026-01-01T00:00:00.000Z",
            "propertyId": "prop1",
            "unitId": "unit1",
            "guestId": None,
            "stayId": None,
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
        },
        "guest": None,
        "stay": None,
        "property": None,
        "unit": None,
        "history": {"signals": []},
    }
}


@pytest.fixture(autouse=True)
def restore_settings():
    """Every test below mutates the shared `settings` singleton — restore it
    afterward so tests never leak configuration into each other."""
    original_provider = settings.llm_provider
    original_key = settings.gemini_api_key
    yield
    settings.llm_provider = original_provider
    settings.gemini_api_key = original_key


def test_default_provider_is_test_not_gemini():
    """A service with no configuration at all must never attempt a real
    call — this is the single most important safety property of this
    module."""
    assert settings.llm_provider == "test"


def test_unconfigured_gemini_provider_without_key_returns_not_configured():
    settings.llm_provider = "gemini"
    settings.gemini_api_key = ""

    response = client.post("/v1/intelligence/signal", json=VALID_REQUEST)

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "PROVIDER_NOT_CONFIGURED"


def test_unsupported_provider_value_returns_not_configured():
    settings.llm_provider = "not-a-real-provider"

    response = client.post("/v1/intelligence/signal", json=VALID_REQUEST)

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "PROVIDER_NOT_CONFIGURED"


def test_gemini_client_maps_api_error_without_leaking_details(monkeypatch):
    """Simulates a real Gemini SDK failure (e.g. bad model/key) and proves
    the error is mapped to the safe contract without ever surfacing the
    provider's raw response body."""

    def _raise(*args, **kwargs):
        raise genai_errors.APIError(code=404, response_json={"error": {"message": "super secret internal detail"}})

    fake_client = MagicMock()
    fake_client.models.generate_content.side_effect = _raise
    monkeypatch.setattr(gemini_client.genai, "Client", lambda **kwargs: fake_client)

    settings.llm_provider = "gemini"
    settings.gemini_api_key = "fake-key-for-this-test-only"

    response = client.post("/v1/intelligence/signal", json=VALID_REQUEST)

    assert response.status_code == 502
    body = response.json()
    assert body["error"]["code"] == "PROVIDER_ERROR"
    assert "super secret internal detail" not in str(body)


def test_gemini_client_rejects_malformed_json_response(monkeypatch):
    fake_response = MagicMock()
    fake_response.text = "not valid json {{{"
    fake_client = MagicMock()
    fake_client.models.generate_content.return_value = fake_response
    monkeypatch.setattr(gemini_client.genai, "Client", lambda **kwargs: fake_client)

    settings.llm_provider = "gemini"
    settings.gemini_api_key = "fake-key-for-this-test-only"

    response = client.post("/v1/intelligence/signal", json=VALID_REQUEST)

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "MALFORMED_RESPONSE"


def test_gemini_client_rejects_response_missing_required_fields(monkeypatch):
    fake_response = MagicMock()
    fake_response.text = '{"summary": "only a summary, nothing else"}'
    fake_client = MagicMock()
    fake_client.models.generate_content.return_value = fake_response
    monkeypatch.setattr(gemini_client.genai, "Client", lambda **kwargs: fake_client)

    settings.llm_provider = "gemini"
    settings.gemini_api_key = "fake-key-for-this-test-only"

    response = client.post("/v1/intelligence/signal", json=VALID_REQUEST)

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "MALFORMED_RESPONSE"


def test_gemini_client_succeeds_with_well_formed_response(monkeypatch):
    fake_response = MagicMock()
    fake_response.text = (
        '{"summary": "s", "findings": ["f"], '
        '"risk": {"level": "high", "reason": "r"}, '
        '"decision": {"recommendation": "d", "rationale": "r"}, '
        '"action": {"label": "a", "recommended": [{"step": "s", "priority": "high"}]}, '
        '"outcome": {"expected": "o"}, "confidence": 0.8}'
    )
    fake_client = MagicMock()
    fake_client.models.generate_content.return_value = fake_response
    monkeypatch.setattr(gemini_client.genai, "Client", lambda **kwargs: fake_client)

    settings.llm_provider = "gemini"
    settings.gemini_api_key = "fake-key-for-this-test-only"

    response = client.post("/v1/intelligence/signal", json=VALID_REQUEST)

    assert response.status_code == 200
    body = response.json()
    assert body["provenance"]["provider"] == "gemini"
    assert body["provenance"]["model"] == settings.llm_model
    assert body["risk"]["level"] == "high"


def test_deterministic_stub_still_reports_honest_provenance():
    settings.llm_provider = "test"

    response = client.post("/v1/intelligence/signal", json=VALID_REQUEST)

    assert response.status_code == 200
    assert response.json()["provenance"]["provider"] == "test"
