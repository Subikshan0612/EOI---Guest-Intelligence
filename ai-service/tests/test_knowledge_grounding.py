"""
Tests for Phase 6H — knowledge-grounded intelligence.

Covers: the grounded prompt itself (structure, separation, instructions),
the request/response contract extension (KnowledgeItem/knowledgeProvenance),
the deterministic stub's honest knowledge echo, and the real Gemini path's
defense against invented/out-of-scope provenance (monkeypatched — no
network call, matching tests/test_gemini_client.py's own approach).
"""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from google.genai import errors as genai_errors

from app.config import settings
from app.main import app
from app.models.context import SignalContext
from app.models.intelligence import KnowledgeItem
from app.services import gemini_client
from app.services.prompt_builder import SYSTEM_PROMPT, build_intelligence_prompt

client = TestClient(app)

BASE_CONTEXT = {
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
    "property": {
        "id": "prop1", "available": True, "name": "Kolam Residency", "code": "KR01",
        "address": "", "timezone": "UTC", "status": "active",
    },
    "unit": {
        "id": "unit1", "available": True, "unitNumber": "204", "type": "suite",
        "status": "maintenance", "propertyId": "prop1",
    },
    "history": {"signals": []},
}


def knowledge_item(chunk_id: str, scope: str, text: str = "Example only. Synthetic SOP text for testing.", **overrides) -> dict:
    base = {
        "chunkId": chunk_id,
        "knowledgeDocumentId": f"doc-{chunk_id}",
        "version": 1,
        "scope": scope,
        "section": "AC Troubleshooting",
        "chunkIndex": 0,
        "text": text,
        "similarityScore": 0.9,
        "retrievalScore": 0.95,
    }
    base.update(overrides)
    return base


@pytest.fixture(autouse=True)
def restore_settings():
    original = settings.llm_provider
    yield
    settings.llm_provider = original


# =========================================================
# PROMPT STRUCTURE (test the actual prompt, not just object existence)
# =========================================================


def _build(knowledge_items):
    context = SignalContext(**BASE_CONTEXT)
    items = [KnowledgeItem(**item) for item in knowledge_items]
    return build_intelligence_prompt(context, items)


def test_prompt_separates_operational_context_from_knowledge_sections():
    _, user_prompt = _build([knowledge_item("c1", "unit")])
    context_pos = user_prompt.index("=== OPERATIONAL CONTEXT ===")
    knowledge_pos = user_prompt.index("=== RETRIEVED ORGANIZATIONAL KNOWLEDGE ===")
    assert context_pos < knowledge_pos
    # The Signal's own facts live before the knowledge section, not mixed into it.
    assert "AC not cooling" in user_prompt[:knowledge_pos]


def test_prompt_includes_knowledge_provenance_inline():
    _, user_prompt = _build([knowledge_item("c1", "unit", section="AC Troubleshooting")])
    knowledge_section = user_prompt[user_prompt.index("=== RETRIEVED ORGANIZATIONAL KNOWLEDGE ==="):]
    assert "c1" in knowledge_section
    assert "doc-c1" in knowledge_section
    assert "unit" in knowledge_section
    assert "AC Troubleshooting" in knowledge_section
    assert "Example only. Synthetic SOP text for testing." in knowledge_section


def test_prompt_with_relevant_unit_knowledge():
    _, user_prompt = _build([knowledge_item("c1", "unit")])
    assert "scope: unit" in user_prompt


def test_prompt_with_relevant_property_knowledge():
    _, user_prompt = _build([knowledge_item("c1", "property")])
    assert "scope: property" in user_prompt


def test_prompt_with_relevant_workspace_knowledge():
    _, user_prompt = _build([knowledge_item("c1", "workspace")])
    assert "scope: workspace" in user_prompt


def test_prompt_with_multiple_knowledge_chunks():
    _, user_prompt = _build([knowledge_item("c1", "unit"), knowledge_item("c2", "workspace")])
    assert "c1" in user_prompt and "c2" in user_prompt
    assert "doc-c1" in user_prompt and "doc-c2" in user_prompt


def test_prompt_with_no_knowledge_says_so_explicitly_and_never_fabricates():
    _, user_prompt = _build([])
    knowledge_section = user_prompt[user_prompt.index("=== RETRIEVED ORGANIZATIONAL KNOWLEDGE ==="):]
    assert "No organizational knowledge was retrieved" in knowledge_section
    assert "do not assume, invent" in knowledge_section


def test_system_prompt_never_lets_knowledge_be_presented_as_observed_fact():
    assert "never itself evidence that something happened" in SYSTEM_PROMPT or "never state that a knowledge instruction was observed" in SYSTEM_PROMPT.lower() or "guidance, not an observed fact" in SYSTEM_PROMPT.lower()


def test_system_prompt_instructs_against_inventing_policy():
    assert "do not invent a policy" in SYSTEM_PROMPT.lower()


def test_system_prompt_preserves_uncertainty_for_missing_operational_data():
    assert "preserve that uncertainty" in SYSTEM_PROMPT.lower()


def test_system_prompt_addresses_conflicting_knowledge():
    assert "conflict" in SYSTEM_PROMPT.lower()


def test_system_prompt_states_scope_precedence():
    assert "unit-level guidance is the most specific" in SYSTEM_PROMPT.lower() or "prefer the more specific scope" in SYSTEM_PROMPT.lower()


# =========================================================
# CONTRACT
# =========================================================


def test_knowledge_item_rejects_workspace_id():
    """Structural tenant boundary: cross-workspace knowledge cannot even be
    expressed in this contract, let alone reach Gemini."""
    with pytest.raises(Exception):
        KnowledgeItem(**{**knowledge_item("c1", "unit"), "workspaceId": "should-not-be-accepted"})


def test_intelligence_request_accepts_knowledge_and_defaults_to_empty():
    from app.models.intelligence import IntelligenceRequest

    request_without_knowledge = IntelligenceRequest(context=BASE_CONTEXT)
    assert request_without_knowledge.knowledge == []

    request_with_knowledge = IntelligenceRequest(context=BASE_CONTEXT, knowledge=[knowledge_item("c1", "unit")])
    assert len(request_with_knowledge.knowledge) == 1


# =========================================================
# DETERMINISTIC STUB — provenance preservation
# =========================================================


def test_deterministic_stub_echoes_supplied_knowledge_as_provenance():
    settings.llm_provider = "test"
    response = client.post(
        "/v1/intelligence/signal",
        json={"context": BASE_CONTEXT, "knowledge": [knowledge_item("c1", "unit"), knowledge_item("c2", "property")]},
    )
    assert response.status_code == 200
    provenance = response.json()["knowledgeProvenance"]
    assert {item["chunkId"] for item in provenance} == {"c1", "c2"}
    assert all(item["knowledgeDocumentId"].startswith("doc-") for item in provenance)


def test_deterministic_stub_with_no_knowledge_reports_empty_provenance():
    settings.llm_provider = "test"
    response = client.post("/v1/intelligence/signal", json={"context": BASE_CONTEXT, "knowledge": []})
    assert response.status_code == 200
    assert response.json()["knowledgeProvenance"] == []
    assert any("No organizational knowledge was supplied" in f for f in response.json()["findings"])


def test_deterministic_provider_still_works_without_knowledge_field_at_all():
    """Backward compatibility: a caller that never sends `knowledge` at all
    (the pre-Phase-6H shape) still gets a valid response."""
    settings.llm_provider = "test"
    response = client.post("/v1/intelligence/signal", json={"context": BASE_CONTEXT})
    assert response.status_code == 200
    assert response.json()["knowledgeProvenance"] == []


def test_conflicting_knowledge_is_not_silently_resolved_by_the_stub():
    """Two knowledge items addressing the same topic from different scopes
    — the stub (which does no relevance/conflict judgment) reports both,
    preserving both instead of picking a winner on its own."""
    settings.llm_provider = "test"
    conflicting = [
        knowledge_item("unit-c", "unit", text="Example only. Unit 204 uses a non-standard HVAC controller."),
        knowledge_item("ws-c", "workspace", text="Example only. Escalate all AC failures immediately."),
    ]
    response = client.post("/v1/intelligence/signal", json={"context": BASE_CONTEXT, "knowledge": conflicting})
    provenance_ids = {item["chunkId"] for item in response.json()["knowledgeProvenance"]}
    assert provenance_ids == {"unit-c", "ws-c"}


# =========================================================
# GEMINI PATH — provenance cannot be invented (monkeypatched, no network)
# =========================================================


def _mock_gemini_response(text: str):
    fake_response = MagicMock()
    fake_response.text = text
    fake_client = MagicMock()
    fake_client.models.generate_content.return_value = fake_response
    return fake_client


GEMINI_FIELDS = (
    '"summary": "s", "findings": ["f"], '
    '"risk": {"level": "high", "reason": "r"}, '
    '"decision": {"recommendation": "d", "rationale": "r"}, '
    '"action": {"label": "a", "recommended": [{"step": "s", "priority": "high"}]}, '
    '"outcome": {"expected": "o"}, "confidence": 0.8'
)


def test_gemini_provenance_intersects_claimed_usage_with_supplied_knowledge(monkeypatch):
    fake_client = _mock_gemini_response(
        "{" + GEMINI_FIELDS + ', "usedKnowledgeChunkIds": ["c1"]}'
    )
    monkeypatch.setattr(gemini_client.genai, "Client", lambda **kwargs: fake_client)
    settings.llm_provider = "gemini"
    settings.gemini_api_key = "fake-key-for-this-test-only"

    response = client.post(
        "/v1/intelligence/signal",
        json={"context": BASE_CONTEXT, "knowledge": [knowledge_item("c1", "unit"), knowledge_item("c2", "workspace")]},
    )
    provenance = response.json()["knowledgeProvenance"]
    assert [item["chunkId"] for item in provenance] == ["c1"]
    settings.gemini_api_key = ""


def test_gemini_cannot_invent_a_chunk_id_that_was_never_supplied(monkeypatch):
    """The model cannot be the authority for which documents were
    retrieved — a claimed chunkId with no matching supplied KnowledgeItem
    must never surface as provenance."""
    fake_client = _mock_gemini_response(
        "{" + GEMINI_FIELDS + ', "usedKnowledgeChunkIds": ["c1", "invented-chunk-id-not-supplied"]}'
    )
    monkeypatch.setattr(gemini_client.genai, "Client", lambda **kwargs: fake_client)
    settings.llm_provider = "gemini"
    settings.gemini_api_key = "fake-key-for-this-test-only"

    response = client.post(
        "/v1/intelligence/signal",
        json={"context": BASE_CONTEXT, "knowledge": [knowledge_item("c1", "unit")]},
    )
    provenance = response.json()["knowledgeProvenance"]
    assert [item["chunkId"] for item in provenance] == ["c1"]
    assert "invented-chunk-id-not-supplied" not in str(provenance)
    settings.gemini_api_key = ""


def test_gemini_response_missing_used_knowledge_field_degrades_safely(monkeypatch):
    """A mocked/malformed response with no usedKnowledgeChunkIds field at
    all must not crash — it just means nothing is reported as used."""
    fake_client = _mock_gemini_response("{" + GEMINI_FIELDS + "}")
    monkeypatch.setattr(gemini_client.genai, "Client", lambda **kwargs: fake_client)
    settings.llm_provider = "gemini"
    settings.gemini_api_key = "fake-key-for-this-test-only"

    response = client.post(
        "/v1/intelligence/signal",
        json={"context": BASE_CONTEXT, "knowledge": [knowledge_item("c1", "unit")]},
    )
    assert response.status_code == 200
    assert response.json()["knowledgeProvenance"] == []
    settings.gemini_api_key = ""


def test_gemini_provider_provenance_remains_trusted_and_untouched_by_knowledge(monkeypatch):
    fake_client = _mock_gemini_response("{" + GEMINI_FIELDS + ', "usedKnowledgeChunkIds": []}')
    monkeypatch.setattr(gemini_client.genai, "Client", lambda **kwargs: fake_client)
    settings.llm_provider = "gemini"
    settings.gemini_api_key = "fake-key-for-this-test-only"

    response = client.post(
        "/v1/intelligence/signal",
        json={"context": BASE_CONTEXT, "knowledge": [knowledge_item("c1", "unit")]},
    )
    body = response.json()
    assert body["provenance"]["provider"] == "gemini"
    assert body["provenance"]["model"] == settings.llm_model
    settings.gemini_api_key = ""


def test_malformed_gemini_response_still_handled_correctly_with_knowledge_present(monkeypatch):
    fake_response = MagicMock()
    fake_response.text = "not valid json {{{"
    fake_client = MagicMock()
    fake_client.models.generate_content.return_value = fake_response
    monkeypatch.setattr(gemini_client.genai, "Client", lambda **kwargs: fake_client)
    settings.llm_provider = "gemini"
    settings.gemini_api_key = "fake-key-for-this-test-only"

    response = client.post(
        "/v1/intelligence/signal",
        json={"context": BASE_CONTEXT, "knowledge": [knowledge_item("c1", "unit")]},
    )
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "MALFORMED_RESPONSE"
    settings.gemini_api_key = ""
