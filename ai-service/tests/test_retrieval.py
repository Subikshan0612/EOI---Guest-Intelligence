"""
Tests for POST /v1/knowledge-retrieval — the Phase 6G ranking endpoint.
All deterministic (EMBEDDING_PROVIDER=test, the default), no network, no
MongoDB, no real Gemini call. Embeddings are produced by the same
deterministic provider Phase 6E already tests — this file focuses on what
Phase 6G actually adds: the request contract, scope-preference scoring, and
deterministic ordering.
"""

import math

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.services.deterministic_embedding import generate_deterministic_embeddings
from app.services.vector_math import cosine_similarity

client = TestClient(app)


@pytest.fixture(autouse=True)
def restore_settings():
    original = settings.similarity_max_candidates
    yield
    settings.similarity_max_candidates = original


def embed(text: str) -> list[float]:
    return generate_deterministic_embeddings([text]).embeddings[0]


def candidate(chunk_id: str, text: str, scope: str) -> dict:
    return {"chunkId": chunk_id, "embedding": embed(text), "scope": scope}


# =========================================================
# CONTRACT VALIDATION
# =========================================================


def test_valid_request_accepted():
    response = client.post(
        "/v1/knowledge-retrieval",
        json={"queryText": "AC not cooling", "candidates": [candidate("c1", "AC not cooling", "unit")]},
    )
    assert response.status_code == 200


def test_blank_query_text_rejected():
    response = client.post(
        "/v1/knowledge-retrieval",
        json={"queryText": "   ", "candidates": [candidate("c1", "x", "unit")]},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"


def test_missing_query_text_rejected():
    response = client.post("/v1/knowledge-retrieval", json={"candidates": [candidate("c1", "x", "unit")]})
    assert response.status_code == 422


def test_empty_candidate_list_rejected():
    response = client.post("/v1/knowledge-retrieval", json={"queryText": "x", "candidates": []})
    assert response.status_code == 422


def test_invalid_scope_value_rejected():
    response = client.post(
        "/v1/knowledge-retrieval",
        json={"queryText": "x", "candidates": [{"chunkId": "c1", "embedding": embed("x"), "scope": "planet"}]},
    )
    assert response.status_code == 422


def test_duplicate_chunk_ids_rejected():
    response = client.post(
        "/v1/knowledge-retrieval",
        json={
            "queryText": "x",
            "candidates": [candidate("dup", "a", "unit"), candidate("dup", "b", "workspace")],
        },
    )
    assert response.status_code == 422


def test_zero_magnitude_candidate_rejected():
    dim = len(embed("x"))
    response = client.post(
        "/v1/knowledge-retrieval",
        json={
            "queryText": "x",
            "candidates": [{"chunkId": "c1", "embedding": [0.0] * dim, "scope": "unit"}],
        },
    )
    assert response.status_code == 422


def test_extra_field_rejected():
    """No workspaceId, no MongoDB identifiers beyond chunkId."""
    response = client.post(
        "/v1/knowledge-retrieval",
        json={
            "queryText": "x",
            "candidates": [candidate("c1", "x", "unit")],
            "workspaceId": "abc123",
        },
    )
    assert response.status_code == 422


def test_candidate_extra_field_rejected():
    response = client.post(
        "/v1/knowledge-retrieval",
        json={
            "queryText": "x",
            "candidates": [{"chunkId": "c1", "embedding": embed("x"), "scope": "unit", "documentId": "abc"}],
        },
    )
    assert response.status_code == 422


def test_candidate_count_respects_max_candidates():
    settings.similarity_max_candidates = 3
    response = client.post(
        "/v1/knowledge-retrieval",
        json={"queryText": "x", "candidates": [candidate(f"c{i}", f"text {i}", "workspace") for i in range(4)]},
    )
    assert response.status_code == 422


def test_candidate_count_at_exact_max_accepted():
    settings.similarity_max_candidates = 3
    response = client.post(
        "/v1/knowledge-retrieval",
        json={"queryText": "x", "candidates": [candidate(f"c{i}", f"text {i}", "workspace") for i in range(3)]},
    )
    assert response.status_code == 200


# =========================================================
# SCOPE PRECEDENCE (Unit > Property > Workspace)
# =========================================================


def test_unit_scope_ranks_above_equally_relevant_property_and_workspace():
    query = "AC not cooling in occupied unit"
    response = client.post(
        "/v1/knowledge-retrieval",
        json={
            "queryText": query,
            "candidates": [
                candidate("ws", query, "workspace"),
                candidate("prop", query, "property"),
                candidate("unit", query, "unit"),
            ],
        },
    )
    ids = [r["chunkId"] for r in response.json()["results"]]
    assert ids == ["unit", "prop", "ws"]


def test_property_scope_ranks_above_equally_relevant_workspace():
    query = "Housekeeping checklist for turnover"
    response = client.post(
        "/v1/knowledge-retrieval",
        json={
            "queryText": query,
            "candidates": [candidate("ws", query, "workspace"), candidate("prop", query, "property")],
        },
    )
    ids = [r["chunkId"] for r in response.json()["results"]]
    assert ids == ["prop", "ws"]


def test_broader_knowledge_not_blindly_discarded_when_clearly_more_relevant():
    """A highly relevant Workspace chunk must still outrank a barely
    relevant Unit chunk — the scope boost breaks ties, it doesn't override
    relevance."""
    query = "AC not cooling emergency escalation"
    response = client.post(
        "/v1/knowledge-retrieval",
        json={
            "queryText": query,
            "candidates": [
                candidate("unit", "completely unrelated housekeeping linen inventory", "unit"),
                candidate("ws", query, "workspace"),
            ],
        },
    )
    ids = [r["chunkId"] for r in response.json()["results"]]
    assert ids == ["ws", "unit"]


def test_scope_boost_constants_are_modest_multipliers():
    """Documents the exact policy: unit=1.15x, property=1.08x,
    workspace=1.0x, applied to similarityScore."""
    query = "identical text for every candidate"
    response = client.post(
        "/v1/knowledge-retrieval",
        json={
            "queryText": query,
            "candidates": [
                candidate("unit", query, "unit"),
                candidate("prop", query, "property"),
                candidate("ws", query, "workspace"),
            ],
        },
    )
    by_id = {r["chunkId"]: r for r in response.json()["results"]}
    similarity = by_id["ws"]["similarityScore"]  # all three have identical similarity (identical text)
    assert math.isclose(by_id["unit"]["retrievalScore"], similarity * 1.15, rel_tol=1e-6)
    assert math.isclose(by_id["prop"]["retrievalScore"], similarity * 1.08, rel_tol=1e-6)
    assert math.isclose(by_id["ws"]["retrievalScore"], similarity * 1.0, rel_tol=1e-6)


# =========================================================
# DETERMINISTIC ORDERING
# =========================================================


def test_deterministic_tie_break_by_chunk_id_when_scores_and_scope_equal():
    query = "identical text"
    response = client.post(
        "/v1/knowledge-retrieval",
        json={
            "queryText": query,
            "candidates": [candidate("zzz", query, "unit"), candidate("aaa", query, "unit"), candidate("mmm", query, "unit")],
        },
    )
    ids = [r["chunkId"] for r in response.json()["results"]]
    assert ids == ["aaa", "mmm", "zzz"]


def test_same_request_returns_same_result_order():
    payload = {
        "queryText": "AC not cooling",
        "candidates": [
            candidate("a", "AC repair procedure", "property"),
            candidate("b", "unrelated text about breakfast service", "unit"),
            candidate("c", "AC not cooling exactly", "workspace"),
        ],
    }
    first = client.post("/v1/knowledge-retrieval", json=payload).json()
    second = client.post("/v1/knowledge-retrieval", json=payload).json()
    assert first == second


def test_results_match_direct_cosine_similarity_computation():
    query_text = "AC troubleshooting"
    query_embedding = embed(query_text)
    candidates_by_id = {"a": embed("AC repair"), "b": embed("totally different topic")}

    response = client.post(
        "/v1/knowledge-retrieval",
        json={
            "queryText": query_text,
            "candidates": [
                {"chunkId": cid, "embedding": vec, "scope": "workspace"} for cid, vec in candidates_by_id.items()
            ],
        },
    )
    by_id = {r["chunkId"]: r["similarityScore"] for r in response.json()["results"]}
    for chunk_id, vector in candidates_by_id.items():
        assert math.isclose(by_id[chunk_id], cosine_similarity(query_embedding, vector), rel_tol=1e-9)


# =========================================================
# BOUNDARY
# =========================================================


def test_response_reports_the_embedding_model_used():
    response = client.post(
        "/v1/knowledge-retrieval",
        json={"queryText": "x", "candidates": [candidate("c1", "x", "unit")]},
    )
    assert response.json()["model"] == "deterministic-embedding-v1"


def test_no_mongo_import_in_retrieval_router():
    import ast
    import inspect

    from app.routers import retrieval

    tree = ast.parse(inspect.getsource(retrieval))
    imported_names = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported_names.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported_names.append(node.module)

    forbidden = ["pymongo", "motor", "mongo"]
    assert not any(term in name.lower() for name in imported_names for term in forbidden)
