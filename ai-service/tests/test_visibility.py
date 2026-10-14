"""
Tests for knowledge visibility (guest < staff < restricted) on the Python side.

Node is the authoritative enforcement point and filters before calling this
service; these tests prove the DEFENSIVE second layer: candidates and
knowledge above the request's authorizedLevel are ignored, never scored and
never placed in a prompt or provenance. All fixtures are synthetic.
"""

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.models.context import SignalContext
from app.models.intelligence import KnowledgeItem
from app.models.visibility import VISIBILITY_RANK, is_visible
from app.services.deterministic_embedding import TEST_EMBEDDING_MODEL, generate_deterministic_embeddings
from app.services.prompt_builder import build_intelligence_prompt
from tests.test_knowledge_grounding import BASE_CONTEXT, knowledge_item

client = TestClient(app)
LEVELS = ["guest", "staff", "restricted"]


def embed(text: str) -> list[float]:
    return generate_deterministic_embeddings([text]).embeddings[0]


def candidate(chunk_id: str, visibility: str, scope: str = "workspace") -> dict:
    return {"chunkId": chunk_id, "embedding": embed(f"text {chunk_id}"), "scope": scope, "visibility": visibility, "embeddingModel": TEST_EMBEDDING_MODEL}


@pytest.fixture(autouse=True)
def restore_settings():
    original = settings.llm_provider
    yield
    settings.llm_provider = original


# ---- the hierarchy itself -------------------------------------------------


def test_visibility_ordering():
    assert VISIBILITY_RANK["guest"] < VISIBILITY_RANK["staff"] < VISIBILITY_RANK["restricted"]


@pytest.mark.parametrize("caller", LEVELS)
@pytest.mark.parametrize("knowledge", LEVELS)
def test_is_visible_matrix(caller, knowledge):
    assert is_visible(knowledge, caller) == (VISIBILITY_RANK[caller] >= VISIBILITY_RANK[knowledge])


def test_unknown_caller_level_is_treated_as_guest_and_unknown_visibility_as_restricted():
    assert is_visible("guest", "nonsense") is True
    assert is_visible("staff", "nonsense") is False
    assert is_visible("nonsense", "staff") is False
    assert is_visible("nonsense", "restricted") is True


# ---- retrieval: candidates above the level are ignored --------------------


def _retrieve(level, candidates):
    body = {"queryText": "query", "candidates": candidates}
    if level is not None:
        body["authorizedLevel"] = level
    return client.post("/v1/knowledge-retrieval", json=body)


ALL = [candidate("g", "guest"), candidate("s", "staff"), candidate("r", "restricted")]


def test_retrieval_guest_level_scores_only_guest_candidates():
    ids = {r["chunkId"] for r in _retrieve("guest", ALL).json()["results"]}
    assert ids == {"g"}


def test_retrieval_staff_level_scores_guest_and_staff():
    ids = {r["chunkId"] for r in _retrieve("staff", ALL).json()["results"]}
    assert ids == {"g", "s"}


def test_retrieval_restricted_level_scores_all():
    ids = {r["chunkId"] for r in _retrieve("restricted", ALL).json()["results"]}
    assert ids == {"g", "s", "r"}


def test_retrieval_omitted_level_defaults_to_guest():
    ids = {r["chunkId"] for r in _retrieve(None, ALL).json()["results"]}
    assert ids == {"g"}


def test_retrieval_all_candidates_above_level_returns_empty_results_not_an_error():
    response = _retrieve("guest", [candidate("s", "staff"), candidate("r", "restricted")])
    assert response.status_code == 200
    assert response.json()["results"] == []
    assert response.json()["model"]


def test_retrieval_invalid_level_or_missing_candidate_visibility_is_rejected():
    assert _retrieve("admin", ALL).status_code == 422
    missing = {"chunkId": "x", "embedding": embed("x"), "scope": "workspace"}
    assert _retrieve("guest", [missing]).status_code == 422
    assert _retrieve("guest", [candidate("x", "public")]).status_code == 422


def test_visibility_filter_does_not_change_scores_of_visible_candidates():
    only_guest = {r["chunkId"]: r["retrievalScore"] for r in _retrieve("guest", [candidate("g", "guest")]).json()["results"]}
    mixed = {r["chunkId"]: r["retrievalScore"] for r in _retrieve("guest", ALL).json()["results"]}
    assert only_guest["g"] == mixed["g"]


def test_scope_boost_ordering_is_unchanged_by_visibility():
    query = "same text"
    unit = {"chunkId": "u", "embedding": embed(query), "scope": "unit", "visibility": "guest", "embeddingModel": TEST_EMBEDDING_MODEL}
    workspace = {"chunkId": "w", "embedding": embed(query), "scope": "workspace", "visibility": "guest", "embeddingModel": TEST_EMBEDDING_MODEL}
    response = client.post(
        "/v1/knowledge-retrieval",
        json={"queryText": query, "candidates": [workspace, unit], "authorizedLevel": "guest"},
    )
    assert [r["chunkId"] for r in response.json()["results"]] == ["u", "w"]


# ---- intelligence: knowledge above the level never reaches provenance -----


def _generate(level, items):
    settings.llm_provider = "test"
    body = {"context": BASE_CONTEXT, "knowledge": items}
    if level is not None:
        body["authorizedLevel"] = level
    return client.post("/v1/intelligence/signal", json=body)


ITEMS = [
    knowledge_item("c-guest", "workspace", visibility="guest"),
    knowledge_item("c-staff", "workspace", visibility="staff"),
    knowledge_item("c-restricted", "workspace", visibility="restricted"),
]


def _provenance_ids(response):
    return {item["chunkId"] for item in response.json().get("knowledgeProvenance", [])}


def test_intelligence_guest_level_drops_staff_and_restricted_knowledge():
    response = _generate("guest", ITEMS)
    assert response.status_code == 200
    assert _provenance_ids(response) <= {"c-guest"}


def test_intelligence_staff_level_keeps_guest_and_staff_only():
    assert _provenance_ids(_generate("staff", ITEMS)) <= {"c-guest", "c-staff"}


def test_intelligence_restricted_level_may_use_everything():
    assert _provenance_ids(_generate("restricted", ITEMS)) == {"c-guest", "c-staff", "c-restricted"}


def test_intelligence_omitted_level_defaults_to_guest():
    assert _provenance_ids(_generate(None, ITEMS)) <= {"c-guest"}


def test_intelligence_knowledge_item_requires_visibility():
    item = knowledge_item("c1", "workspace")
    del item["visibility"]
    assert _generate("restricted", [item]).status_code == 422
    assert _generate("restricted", [knowledge_item("c1", "workspace", visibility="public")]).status_code == 422


def test_intelligence_invalid_level_rejected():
    assert _generate("admin", ITEMS).status_code == 422


def test_prompt_never_contains_text_of_a_dropped_chunk():
    marker = "SYNTHETIC-HIGHER-LEVEL-MARKER"
    items = [
        knowledge_item("c-ok", "workspace", visibility="guest", text="Synthetic guest-level text."),
        knowledge_item("c-hi", "workspace", visibility="staff", text=f"Synthetic staff-level text {marker}."),
    ]
    visible = [KnowledgeItem(**i) for i in items if is_visible(i["visibility"], "guest")]
    _, prompt = build_intelligence_prompt(SignalContext(**BASE_CONTEXT), visible)
    assert marker not in prompt and "c-hi" not in prompt and "Synthetic guest-level text." in prompt


def test_visibility_value_is_not_written_into_the_prompt_label_or_text():
    item = KnowledgeItem(**knowledge_item("c1", "workspace", visibility="staff"))
    _, prompt = build_intelligence_prompt(SignalContext(**BASE_CONTEXT), [item])
    knowledge_section = prompt[prompt.index("=== RETRIEVED ORGANIZATIONAL KNOWLEDGE ==="):]
    assert "visibility" not in knowledge_section.lower()
