"""
Tests for the Phase 6F vector-storage/similarity foundation:
app/services/vector_math.py (pure validation + cosine similarity) and
POST /v1/vector-similarity (the HTTP contract around it). All deterministic
— no network, no MongoDB, no provider call of any kind.
"""

import math

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.services.vector_math import cosine_similarity, is_valid_vector, vector_magnitude

client = TestClient(app)


@pytest.fixture(autouse=True)
def restore_settings():
    original = settings.similarity_max_candidates
    yield
    settings.similarity_max_candidates = original


def candidate(chunk_id: str, embedding: list[float]) -> dict:
    return {"chunkId": chunk_id, "embedding": embedding}


# =========================================================
# VECTOR VALIDATION (app/services/vector_math.is_valid_vector)
# =========================================================


def test_valid_vector_accepted():
    assert is_valid_vector([0.1, 0.2, 0.3]) is True


def test_empty_vector_rejected():
    assert is_valid_vector([]) is False


def test_non_numeric_value_rejected():
    assert is_valid_vector([0.1, "not a number", 0.3]) is False
    assert is_valid_vector([0.1, None, 0.3]) is False
    assert is_valid_vector([0.1, {"nested": True}, 0.3]) is False


def test_bool_rejected_despite_being_an_int_subclass():
    assert is_valid_vector([True, False]) is False


def test_nan_rejected():
    assert is_valid_vector([0.1, float("nan")]) is False


def test_infinity_rejected():
    assert is_valid_vector([0.1, float("inf")]) is False
    assert is_valid_vector([0.1, float("-inf")]) is False


def test_zero_vector_is_a_structurally_valid_vector():
    """Zero-ness is a similarity-time concern (cosine similarity is
    undefined for it), not a shape/finiteness concern — is_valid_vector
    only checks the latter."""
    assert is_valid_vector([0.0, 0.0, 0.0]) is True


def test_not_a_list_rejected():
    assert is_valid_vector("not a list") is False
    assert is_valid_vector(None) is False


# =========================================================
# COSINE SIMILARITY (app/services/vector_math.cosine_similarity)
# =========================================================


def test_identical_vectors_produce_similarity_one():
    assert math.isclose(cosine_similarity([1.0, 2.0, 3.0], [1.0, 2.0, 3.0]), 1.0, rel_tol=1e-9)


def test_orthogonal_vectors_produce_similarity_zero():
    assert math.isclose(cosine_similarity([1.0, 0.0], [0.0, 1.0]), 0.0, abs_tol=1e-9)


def test_opposite_vectors_produce_similarity_negative_one():
    assert math.isclose(cosine_similarity([1.0, 0.0], [-1.0, 0.0]), -1.0, rel_tol=1e-9)


def test_non_normalized_vectors_behave_correctly():
    """Cosine similarity is scale-invariant: a vector and any positive
    scalar multiple of itself must score 1.0, whether or not either is
    unit-length."""
    assert math.isclose(cosine_similarity([1.0, 2.0, 3.0], [2.0, 4.0, 6.0]), 1.0, rel_tol=1e-9)


def test_zero_vector_raises_instead_of_returning_nan_or_infinity():
    with pytest.raises(ValueError):
        cosine_similarity([1.0, 0.0], [0.0, 0.0])
    with pytest.raises(ValueError):
        cosine_similarity([0.0, 0.0], [1.0, 0.0])


def test_dimension_mismatch_raises():
    with pytest.raises(ValueError):
        cosine_similarity([1.0, 0.0], [1.0, 0.0, 0.0])


def test_cosine_similarity_is_deterministic():
    a, b = [0.3, -0.7, 1.2], [0.9, 0.1, -0.4]
    assert cosine_similarity(a, b) == cosine_similarity(a, b)


def test_vector_magnitude():
    assert math.isclose(vector_magnitude([3.0, 4.0]), 5.0)
    assert vector_magnitude([0.0, 0.0]) == 0.0


# =========================================================
# CANDIDATE CONTRACT (POST /v1/vector-similarity request validation)
# =========================================================


def test_valid_request_accepted():
    response = client.post(
        "/v1/vector-similarity",
        json={"queryEmbedding": [1.0, 0.0], "candidates": [candidate("c1", [1.0, 0.0])]},
    )
    assert response.status_code == 200


def test_empty_candidate_list_rejected():
    response = client.post("/v1/vector-similarity", json={"queryEmbedding": [1.0, 0.0], "candidates": []})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"


def test_malformed_candidate_rejected():
    response = client.post(
        "/v1/vector-similarity",
        json={"queryEmbedding": [1.0, 0.0], "candidates": [{"chunkId": "c1", "embedding": ["not", "numeric"]}]},
    )
    assert response.status_code == 422


def test_candidate_missing_chunk_id_rejected():
    response = client.post(
        "/v1/vector-similarity",
        json={"queryEmbedding": [1.0, 0.0], "candidates": [{"embedding": [1.0, 0.0]}]},
    )
    assert response.status_code == 422


def test_duplicate_candidate_ids_rejected():
    response = client.post(
        "/v1/vector-similarity",
        json={
            "queryEmbedding": [1.0, 0.0],
            "candidates": [candidate("c1", [1.0, 0.0]), candidate("c1", [0.0, 1.0])],
        },
    )
    assert response.status_code == 422


def test_candidate_dimension_mismatch_rejected():
    response = client.post(
        "/v1/vector-similarity",
        json={"queryEmbedding": [1.0, 0.0], "candidates": [candidate("c1", [1.0, 0.0, 0.0])]},
    )
    assert response.status_code == 422


def test_extra_fields_rejected():
    """No workspaceId, no arbitrary fields — extra="forbid" throughout."""
    response = client.post(
        "/v1/vector-similarity",
        json={
            "queryEmbedding": [1.0, 0.0],
            "candidates": [candidate("c1", [1.0, 0.0])],
            "workspaceId": "abc123",
        },
    )
    assert response.status_code == 422


def test_candidate_extra_field_rejected():
    response = client.post(
        "/v1/vector-similarity",
        json={
            "queryEmbedding": [1.0, 0.0],
            "candidates": [{"chunkId": "c1", "embedding": [1.0, 0.0], "workspaceId": "abc123"}],
        },
    )
    assert response.status_code == 422


def test_zero_query_embedding_rejected():
    response = client.post(
        "/v1/vector-similarity",
        json={"queryEmbedding": [0.0, 0.0], "candidates": [candidate("c1", [1.0, 0.0])]},
    )
    assert response.status_code == 422


def test_zero_candidate_embedding_rejected():
    response = client.post(
        "/v1/vector-similarity",
        json={"queryEmbedding": [1.0, 0.0], "candidates": [candidate("c1", [0.0, 0.0])]},
    )
    assert response.status_code == 422


def test_oversized_candidate_list_rejected():
    settings.similarity_max_candidates = 3
    response = client.post(
        "/v1/vector-similarity",
        json={
            "queryEmbedding": [1.0, 0.0],
            "candidates": [candidate(f"c{i}", [1.0, 0.0]) for i in range(4)],
        },
    )
    assert response.status_code == 422


def test_candidate_list_at_exact_limit_accepted():
    settings.similarity_max_candidates = 3
    response = client.post(
        "/v1/vector-similarity",
        json={
            "queryEmbedding": [1.0, 0.0],
            "candidates": [candidate(f"c{i}", [1.0, 0.0]) for i in range(3)],
        },
    )
    assert response.status_code == 200


# =========================================================
# RESULT ORDERING
# =========================================================


def test_highest_similarity_first():
    response = client.post(
        "/v1/vector-similarity",
        json={
            "queryEmbedding": [1.0, 0.0],
            "candidates": [
                candidate("low", [0.0, 1.0]),  # orthogonal -> 0.0
                candidate("high", [1.0, 0.0]),  # identical -> 1.0
                candidate("mid", [1.0, 1.0]),  # ~0.707
            ],
        },
    )
    ids_in_order = [r["chunkId"] for r in response.json()["results"]]
    assert ids_in_order == ["high", "mid", "low"]


def test_deterministic_tie_break_by_ascending_chunk_id():
    response = client.post(
        "/v1/vector-similarity",
        json={
            "queryEmbedding": [1.0, 0.0],
            "candidates": [
                candidate("zzz", [1.0, 0.0]),
                candidate("aaa", [1.0, 0.0]),
                candidate("mmm", [1.0, 0.0]),
            ],
        },
    )
    ids_in_order = [r["chunkId"] for r in response.json()["results"]]
    assert ids_in_order == ["aaa", "mmm", "zzz"]


def test_same_request_returns_same_result_order():
    payload = {
        "queryEmbedding": [0.5, 0.5, 0.2],
        "candidates": [candidate("a", [0.4, 0.6, 0.1]), candidate("b", [0.1, 0.1, 0.9]), candidate("c", [0.5, 0.5, 0.2])],
    }
    first = client.post("/v1/vector-similarity", json=payload).json()
    second = client.post("/v1/vector-similarity", json=payload).json()
    assert first == second


# =========================================================
# BOUNDARY
# =========================================================


def test_response_scores_match_direct_cosine_similarity_computation():
    query = [0.5, 0.5, 0.2]
    candidates_vectors = {"a": [0.4, 0.6, 0.1], "b": [0.1, 0.1, 0.9]}
    response = client.post(
        "/v1/vector-similarity",
        json={"queryEmbedding": query, "candidates": [candidate(cid, vec) for cid, vec in candidates_vectors.items()]},
    )
    by_id = {r["chunkId"]: r["score"] for r in response.json()["results"]}
    for chunk_id, vector in candidates_vectors.items():
        assert math.isclose(by_id[chunk_id], cosine_similarity(query, vector), rel_tol=1e-9)


def test_no_embedding_or_intelligence_module_imported_by_similarity_router():
    """Structural boundary check: the similarity primitive must not import
    anything that would let it call a provider or reach MongoDB. Checks
    actual import lines only — the module's own docstring legitimately
    mentions "MongoDB"/"embedding generation" in prose explaining what this
    endpoint deliberately does NOT do."""
    import ast
    import inspect

    from app.routers import vector_similarity

    tree = ast.parse(inspect.getsource(vector_similarity))
    imported_names = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported_names.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported_names.append(node.module)

    forbidden = ["gemini", "genai", "pymongo", "motor", "mongo", "requests", "httpx"]
    assert not any(term in name.lower() for name in imported_names for term in forbidden)
