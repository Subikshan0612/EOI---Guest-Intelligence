"""
Deterministic tests for POST /v1/intelligence/signal.

Require no Gemini key, no MongoDB, no external network — the FastAPI
TestClient drives the app in-process, and the endpoint itself never calls
any external service (see app/services/deterministic_stub.py).
"""

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.main import app
from app.models.intelligence import IntelligenceResponse

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
        "property": {
            "id": "prop1",
            "available": True,
            "name": "Kolam Residency",
            "code": "KR01",
            "address": "",
            "timezone": "UTC",
            "status": "active",
        },
        "unit": {
            "id": "unit1",
            "available": True,
            "unitNumber": "204",
            "type": "suite",
            "status": "maintenance",
            "propertyId": "prop1",
        },
        "history": {"signals": []},
    }
}

VALID_RESPONSE_DICT = {
    "summary": "s",
    "findings": ["f"],
    "risk": {"level": "medium", "reason": "r"},
    "decision": {"recommendation": "d", "rationale": "r"},
    "action": {"label": "a", "recommended": [{"step": "s", "priority": "low"}]},
    "outcome": {"expected": "o"},
    "confidence": 0.5,
    "provenance": {"provider": "test", "model": "deterministic-stub"},
}


def test_intelligence_signal_success():
    response = client.post("/v1/intelligence/signal", json=VALID_REQUEST)
    assert response.status_code == 200


def test_intelligence_signal_response_structure_is_valid():
    response = client.post("/v1/intelligence/signal", json=VALID_REQUEST)
    body = response.json()

    # Re-parses the actual HTTP response body against the real response
    # contract — not just "is this JSON", but "is this a valid
    # IntelligenceResponse".
    validated = IntelligenceResponse(**body)
    # "test" is this service's own provider identity (LLM_PROVIDER=test,
    # the default) — not Node's "test-python" env value, which only means
    # "delegate to this service." Node relays this value honestly rather
    # than hard-coding a label (Phase 5 Step 4).
    assert validated.provenance.provider == "test"
    assert validated.provenance.model == "deterministic-stub"


def test_intelligence_signal_confidence_within_bounds():
    response = client.post("/v1/intelligence/signal", json=VALID_REQUEST)
    body = response.json()
    assert 0.0 <= body["confidence"] <= 1.0


def test_intelligence_signal_is_deterministic_and_reproducible():
    first = client.post("/v1/intelligence/signal", json=VALID_REQUEST).json()
    second = client.post("/v1/intelligence/signal", json=VALID_REQUEST).json()
    assert first == second


def test_intelligence_signal_grounded_in_supplied_context_only():
    response = client.post("/v1/intelligence/signal", json=VALID_REQUEST)
    body = response.json()

    # The signal's own title/severity, and the supplied property/unit
    # names, must appear — nothing else should be invented.
    assert "AC not cooling" in body["summary"]
    assert "Kolam Residency" in body["summary"]
    assert "Unit 204" in body["summary"]
    assert any("high" in finding for finding in body["findings"])
    # No guest/stay was supplied — the stub must say so, not invent one.
    assert any("No guest is linked" in finding for finding in body["findings"])
    assert any("No stay is linked" in finding for finding in body["findings"])


def test_invalid_request_missing_context_is_rejected():
    response = client.post("/v1/intelligence/signal", json={})
    assert response.status_code == 422
    body = response.json()
    assert body["error"]["code"] == "VALIDATION_FAILED"
    # Never a raw pydantic error dump, stack trace, or exception object.
    assert "traceback" not in body
    assert "exc_info" not in body


def test_invalid_request_rejects_workspace_id():
    """workspaceId must never be an accepted field on this contract —
    Python is never allowed to know tenancy."""
    tampered = {"workspaceId": "should-not-be-accepted", **VALID_REQUEST}
    response = client.post("/v1/intelligence/signal", json=tampered)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"


def test_invalid_request_rejects_unknown_context_fields():
    tampered = {
        "context": {**VALID_REQUEST["context"], "mongoInternal": "__v"},
    }
    response = client.post("/v1/intelligence/signal", json=tampered)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"


def test_response_schema_rejects_confidence_out_of_range():
    bad = {**VALID_RESPONSE_DICT, "confidence": 5}
    with pytest.raises(ValidationError):
        IntelligenceResponse(**bad)


def test_response_schema_rejects_invalid_risk_level():
    bad = {**VALID_RESPONSE_DICT, "risk": {"level": "extreme", "reason": "r"}}
    with pytest.raises(ValidationError):
        IntelligenceResponse(**bad)


def test_response_schema_rejects_invalid_action_priority():
    bad = {
        **VALID_RESPONSE_DICT,
        "action": {"label": "a", "recommended": [{"step": "s", "priority": "urgent"}]},
    }
    with pytest.raises(ValidationError):
        IntelligenceResponse(**bad)


def test_health_still_works():
    response = client.get("/v1/health")
    assert response.status_code == 200
    assert response.json() == {"status": "healthy"}
