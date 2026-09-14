"""
Tests for POST /v1/embeddings — the EMBEDDING_PROVIDER branching logic, the
deterministic test provider, and the real Gemini embedding client's error
handling. All deterministic, none require a real Gemini API call or network
access (mirrors tests/test_gemini_client.py's own approach exactly).
"""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from google.genai import errors as genai_errors

from app.config import settings
from app.main import app
from app.services import deterministic_embedding, gemini_embedding_client

client = TestClient(app)


@pytest.fixture(autouse=True)
def restore_settings():
    """Every test below mutates the shared `settings` singleton — restore it
    afterward so tests never leak configuration into each other."""
    original_provider = settings.embedding_provider
    original_key = settings.gemini_api_key
    original_batch_size = settings.embedding_batch_size
    yield
    settings.embedding_provider = original_provider
    settings.gemini_api_key = original_key
    settings.embedding_batch_size = original_batch_size


# =========================================================
# PYTHON CONTRACT
# =========================================================


def test_default_provider_is_test_not_gemini():
    """A service with no configuration at all must never attempt a real
    call — the same safety property test_gemini_client.py proves for
    intelligence generation."""
    assert settings.embedding_provider == "test"


def test_valid_embedding_request():
    settings.embedding_provider = "test"

    response = client.post("/v1/embeddings", json={"texts": ["chunk text 1", "chunk text 2"]})

    assert response.status_code == 200
    body = response.json()
    assert len(body["embeddings"]) == 2
    assert body["model"] == deterministic_embedding.TEST_EMBEDDING_MODEL


def test_empty_texts_array_rejected():
    response = client.post("/v1/embeddings", json={"texts": []})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"


def test_blank_text_rejected():
    response = client.post("/v1/embeddings", json={"texts": ["valid text", "   "]})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"


def test_missing_texts_field_rejected():
    response = client.post("/v1/embeddings", json={})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"


def test_extra_field_rejected():
    """No workspaceId, no MongoDB identifiers, no arbitrary fields — the
    request contract has extra="forbid"."""
    response = client.post("/v1/embeddings", json={"texts": ["x"], "workspaceId": "abc123"})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"


def test_oversized_batch_rejected():
    settings.embedding_batch_size = 5
    response = client.post("/v1/embeddings", json={"texts": ["x"] * 6})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"


def test_batch_at_exact_limit_accepted():
    settings.embedding_provider = "test"
    settings.embedding_batch_size = 5

    response = client.post("/v1/embeddings", json={"texts": ["x"] * 5})

    assert response.status_code == 200
    assert len(response.json()["embeddings"]) == 5


def test_unsupported_provider_value_returns_not_configured():
    settings.embedding_provider = "not-a-real-provider"

    response = client.post("/v1/embeddings", json={"texts": ["x"]})

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "PROVIDER_NOT_CONFIGURED"


def test_vector_dimensionality_is_consistent():
    settings.embedding_provider = "test"

    response = client.post("/v1/embeddings", json={"texts": ["short", "a slightly longer piece of text"]})

    dims = {len(vector) for vector in response.json()["embeddings"]}
    assert len(dims) == 1


# =========================================================
# DETERMINISTIC TEST PROVIDER
# =========================================================


def test_deterministic_provider_same_text_same_vector():
    v1 = deterministic_embedding.generate_deterministic_embeddings(["hello"]).embeddings[0]
    v2 = deterministic_embedding.generate_deterministic_embeddings(["hello"]).embeddings[0]
    assert v1 == v2


def test_deterministic_provider_ordered_batch_identical():
    r1 = deterministic_embedding.generate_deterministic_embeddings(["a", "b", "c"])
    r2 = deterministic_embedding.generate_deterministic_embeddings(["a", "b", "c"])
    assert r1.embeddings == r2.embeddings


def test_deterministic_provider_different_text_different_vector():
    r = deterministic_embedding.generate_deterministic_embeddings(["hello", "goodbye"])
    assert r.embeddings[0] != r.embeddings[1]


def test_deterministic_provider_predictable_dimensionality():
    r = deterministic_embedding.generate_deterministic_embeddings(["a", "bb", "ccc"])
    assert all(len(v) == deterministic_embedding.TEST_EMBEDDING_DIMENSIONS for v in r.embeddings)


def test_deterministic_provider_values_are_numeric_and_normalized():
    import math

    r = deterministic_embedding.generate_deterministic_embeddings(["hello world"])
    vector = r.embeddings[0]
    assert all(isinstance(v, float) and math.isfinite(v) for v in vector)
    magnitude = math.sqrt(sum(v * v for v in vector))
    assert math.isclose(magnitude, 1.0, rel_tol=1e-6)


def test_repeated_identical_request_returns_identical_vectors():
    settings.embedding_provider = "test"

    r1 = client.post("/v1/embeddings", json={"texts": ["repeat me"]})
    r2 = client.post("/v1/embeddings", json={"texts": ["repeat me"]})

    assert r1.json()["embeddings"] == r2.json()["embeddings"]


# =========================================================
# GEMINI PROVIDER (monkeypatched — no real network call)
# =========================================================


def test_gemini_embedding_unconfigured_without_key_returns_not_configured():
    settings.embedding_provider = "gemini"
    settings.gemini_api_key = ""

    response = client.post("/v1/embeddings", json={"texts": ["x"]})

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "PROVIDER_NOT_CONFIGURED"


def test_gemini_embedding_maps_api_error_without_leaking_details(monkeypatch):
    def _raise(*args, **kwargs):
        raise genai_errors.APIError(code=404, response_json={"error": {"message": "super secret internal detail"}})

    fake_client = MagicMock()
    fake_client.models.embed_content.side_effect = _raise
    monkeypatch.setattr(gemini_embedding_client.genai, "Client", lambda **kwargs: fake_client)

    settings.embedding_provider = "gemini"
    settings.gemini_api_key = "fake-key-for-this-test-only"

    response = client.post("/v1/embeddings", json={"texts": ["x"]})

    assert response.status_code == 502
    body = response.json()
    assert body["error"]["code"] == "PROVIDER_ERROR"
    assert "super secret internal detail" not in str(body)


def test_gemini_embedding_rejects_mismatched_vector_count(monkeypatch):
    fake_item = MagicMock()
    fake_item.values = [0.1, 0.2, 0.3]
    fake_response = MagicMock()
    fake_response.embeddings = [fake_item]  # only 1, for 2 requested texts
    fake_client = MagicMock()
    fake_client.models.embed_content.return_value = fake_response
    monkeypatch.setattr(gemini_embedding_client.genai, "Client", lambda **kwargs: fake_client)

    settings.embedding_provider = "gemini"
    settings.gemini_api_key = "fake-key-for-this-test-only"

    response = client.post("/v1/embeddings", json={"texts": ["x", "y"]})

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "MALFORMED_RESPONSE"


def test_gemini_embedding_rejects_inconsistent_dimensionality(monkeypatch):
    item_a = MagicMock()
    item_a.values = [0.1, 0.2, 0.3]
    item_b = MagicMock()
    item_b.values = [0.1, 0.2]  # different dimensionality
    fake_response = MagicMock()
    fake_response.embeddings = [item_a, item_b]
    fake_client = MagicMock()
    fake_client.models.embed_content.return_value = fake_response
    monkeypatch.setattr(gemini_embedding_client.genai, "Client", lambda **kwargs: fake_client)

    settings.embedding_provider = "gemini"
    settings.gemini_api_key = "fake-key-for-this-test-only"

    response = client.post("/v1/embeddings", json={"texts": ["x", "y"]})

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "MALFORMED_RESPONSE"


def test_gemini_embedding_succeeds_with_well_formed_response(monkeypatch):
    item_a = MagicMock()
    item_a.values = [0.1, 0.2, 0.3]
    item_b = MagicMock()
    item_b.values = [0.4, 0.5, 0.6]
    fake_response = MagicMock()
    fake_response.embeddings = [item_a, item_b]
    fake_client = MagicMock()
    fake_client.models.embed_content.return_value = fake_response
    monkeypatch.setattr(gemini_embedding_client.genai, "Client", lambda **kwargs: fake_client)

    settings.embedding_provider = "gemini"
    settings.gemini_api_key = "fake-key-for-this-test-only"

    response = client.post("/v1/embeddings", json={"texts": ["x", "y"]})

    assert response.status_code == 200
    body = response.json()
    assert body["embeddings"] == [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]
    assert body["model"] == settings.embedding_model
