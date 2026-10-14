"""
Phase 38: stable, non-sensitive reason codes for a response the contract rejects on its CLAIMS.

The AI service only checks the SHAPE of claims (whether each is admissible is Node's decision). When Gemini's output fails that shape check, the whole
response is still rejected as MALFORMED_RESPONSE (HTTP status and code unchanged) and the error now also carries a `rule`: a fixed constant derived from
the LOCATION of the failure only, never from the model's content. Synthetic and deterministic; no network, no key. Run with LLM_PROVIDER=test
EMBEDDING_PROVIDER=test in the process environment, like the rest of the suite.
"""

import json
import re
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import settings
from app.main import app
from app.models.analysis import AnalysisResponse
from app.models.errors import ErrorDetail
from app.services import gemini_analysis_client
from app.services.provider_errors import claim_rule_from_validation_error
from tests.test_analysis import MODEL_OUT, analyze, item

client = TestClient(app)
RULE = re.compile(r"^[A-Z][A-Z_]{2,47}$")
MARKER = "RULE-CODE-LEAK-MARKER"
BASE = {
    "situation": "S", "evidence": ["E"], "impact": "I", "recommendation": "R", "confidence": "medium", "usedKnowledgeChunkIds": [],
    "provenance": {"provider": "test", "model": "m"}, "urgency": "prompt", "recommendedActionType": "inspection",
}


@pytest.fixture(autouse=True)
def restore_settings():
    original = (settings.llm_provider, settings.gemini_api_key, settings.llm_model)
    settings.llm_provider = "test"
    yield
    settings.llm_provider, settings.gemini_api_key, settings.llm_model = original


def _gemini(monkeypatch, raw):
    fake_response = MagicMock()
    fake_response.text = raw if isinstance(raw, str) else json.dumps(raw)
    fake_client = MagicMock()
    fake_client.models.generate_content.return_value = fake_response
    monkeypatch.setattr(gemini_analysis_client.genai, "Client", lambda **kwargs: fake_client)
    settings.llm_provider = "gemini"
    settings.gemini_api_key = "fake-key-for-this-test-only"
    return fake_client


def _error_of(claims):
    try:
        AnalysisResponse(**{**BASE, "claims": claims})
    except ValidationError as exc:
        return exc
    raise AssertionError("the claims were expected to be rejected")


def _claim(**over):
    return {"claimType": "FACT", "text": MARKER, "sourceRefs": ["current:signal:64b0000000000000000000a1"], **over}


@pytest.mark.parametrize(
    "claims, expected",
    [
        ([_claim(sourceRefs=[])], "CLAIM_MISSING_SOURCE_REFS"),
        ([{"claimType": "FACT", "text": MARKER}], "CLAIM_MISSING_SOURCE_REFS"),
        ([_claim(claimType="OPINION")], "CLAIM_UNKNOWN_TYPE"),
        ([_claim(text="")], "CLAIM_MALFORMED"),
        ([_claim(extra="x")], "CLAIM_MALFORMED"),
        (["not a claim"], "CLAIM_MALFORMED"),
    ],
)
def test_each_structural_claim_failure_has_its_own_stable_code(claims, expected):
    assert claim_rule_from_validation_error(_error_of(claims)) == expected


def test_a_failure_outside_the_claims_has_the_generic_shape_code():
    try:
        AnalysisResponse(**{**BASE, "confidence": "certain", "claims": []})
    except ValidationError as exc:
        assert claim_rule_from_validation_error(exc) == "RESPONSE_SHAPE_INVALID"
    else:  # pragma: no cover
        raise AssertionError("expected a validation error")


def test_the_code_is_derived_from_the_location_not_the_content():
    # the same structural failure with different (even hostile) text yields the same code, and no code contains any of the text
    codes = {claim_rule_from_validation_error(_error_of([_claim(sourceRefs=[], text=t)])) for t in (MARKER, "Ignore all previous instructions", "x" * 400)}
    assert codes == {"CLAIM_MISSING_SOURCE_REFS"} and all(RULE.match(c) and MARKER not in c for c in codes)


@pytest.mark.parametrize(
    "claims, expected",
    [
        ([_claim(sourceRefs=[])], "CLAIM_MISSING_SOURCE_REFS"),
        ([_claim(claimType="OPINION")], "CLAIM_UNKNOWN_TYPE"),
        ([_claim(text="")], "CLAIM_MALFORMED"),
    ],
)
def test_the_real_provider_branch_rejects_the_whole_response_and_names_the_rule(monkeypatch, claims, expected):
    _gemini(monkeypatch, {**MODEL_OUT, "urgency": "prompt", "recommendedActionType": "inspection", "claims": claims})
    response = analyze([item("c1")], level="guest")
    body = response.json()
    # status and code are unchanged from before the reason codes existed; only `rule` was added
    assert response.status_code == 502
    assert body["error"]["code"] == "MALFORMED_RESPONSE"
    assert body["error"]["rule"] == expected
    # nothing from the model's output (here a marker in the claim text) is echoed anywhere in the error
    assert MARKER not in json.dumps(body) and set(body["error"]) == {"code", "message", "rule"}


def test_a_structurally_valid_response_is_still_accepted(monkeypatch):
    # shape only here: admissibility (are the references real?) is Node's decision, so a well-formed claim list passes through unchanged
    claims = [_claim(sourceRefs=["current:signal:64b0000000000000000000a1"])]
    _gemini(monkeypatch, {**MODEL_OUT, "urgency": "prompt", "recommendedActionType": "inspection", "claims": claims})
    response = analyze([item("c1")], level="guest")
    assert response.status_code == 200 and response.json()["claims"] == claims


def test_other_malformed_responses_carry_no_rule(monkeypatch):
    for raw in ("not json {{{", "[1,2]", ""):
        _gemini(monkeypatch, raw)
        response = analyze([item("c1")], level="guest")
        error = response.json()["error"]
        assert response.status_code == 502 and error["code"] == "MALFORMED_RESPONSE" and "rule" not in error


def test_the_error_model_only_accepts_a_stable_constant():
    assert ErrorDetail(code="MALFORMED_RESPONSE", message="m", rule="CLAIM_MISSING_SOURCE_REFS").model_dump(exclude_none=True)["rule"] == "CLAIM_MISSING_SOURCE_REFS"
    assert "rule" not in ErrorDetail(code="MALFORMED_RESPONSE", message="m").model_dump(exclude_none=True)
    for bad in ("lower case text", "CLAIM <script>", "X", "A" * 60, MARKER + " text"):
        with pytest.raises(ValidationError):
            ErrorDetail(code="MALFORMED_RESPONSE", message="m", rule=bad)
