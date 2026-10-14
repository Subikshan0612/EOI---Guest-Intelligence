"""
Phase 32 - Learning context contract for POST /v1/intelligence/analyze.

Synthetic and deterministic; no real provider is called. Run with EMBEDDING_PROVIDER=test LLM_PROVIDER=test in
the process environment. Mirrors tests/test_operational_history.py's own structure and conventions exactly.
"""

import json

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import settings
from app.main import app
from app.models.analysis import EvidenceType
from app.models.context import SignalContext
from app.models.intelligence import KnowledgeItem
from app.models.learning import LearningContext
from app.services.analysis_prompt import ANALYSIS_SYSTEM_PROMPT, build_analysis_prompt
from tests.test_analysis import item
from tests.test_knowledge_grounding import BASE_CONTEXT

client = TestClient(app)

PATTERN = {"actionType": "maintenance_dispatch", "sampleSize": 17, "successCount": 11, "failedCount": 3, "partialCount": 1, "successRate": 0.7333, "eligible": True}
LEARNING = {"learningVersion": "learning-v1", "minimumSampleSize": 5, "windowDays": 90, "patterns": [PATTERN]}


@pytest.fixture(autouse=True)
def force_test_provider():
    original = (settings.llm_provider, settings.gemini_api_key)
    settings.llm_provider = "test"
    settings.gemini_api_key = ""
    yield
    settings.llm_provider, settings.gemini_api_key = original


def post(learning=None, **extra):
    body = {"context": BASE_CONTEXT, "knowledge": [], "authorizedLevel": "staff", **extra}
    if learning is not None:
        body["learning"] = learning
    return client.post("/v1/intelligence/analyze", json=body)


def test_request_without_learning_is_still_valid_backward_compatible():
    assert post().status_code == 200


def test_request_with_valid_learning_is_accepted_and_the_stub_reports_only_counts():
    response = post(LEARNING)
    assert response.status_code == 200
    text = json.dumps(response.json())
    assert "1 historical Learning pattern(s) (1 at/above the minimum sample size of 5)" in text
    assert "0.7333" not in text  # the stub never repeats the raw successRate as prose


def test_zero_sample_and_ineligible_pattern_is_accepted():
    pattern = {"actionType": "other", "sampleSize": 0, "successCount": 0, "failedCount": 0, "partialCount": 0, "successRate": None, "eligible": False}
    response = post({**LEARNING, "patterns": [pattern]})
    assert response.status_code == 200


@pytest.mark.parametrize(
    "mutate",
    [
        lambda l: {**l, "learningVersion": "learning-v2"},
        lambda l: {**l, "workspaceId": "w"},
        lambda l: {**l, "patterns": [PATTERN] * 6},  # over MAX_PATTERNS (5)
        lambda l: {**l, "minimumSampleSize": 0},
        lambda l: {**l, "windowDays": 0},
        lambda l: {**l, "patterns": [{**PATTERN, "actionType": "not_a_real_type"}]},
        lambda l: {**l, "patterns": [{**PATTERN, "sampleSize": -1}]},
        lambda l: {**l, "patterns": [{**PATTERN, "successRate": 1.5}]},
        lambda l: {**l, "patterns": [{**PATTERN, "successRate": -0.1}]},
        lambda l: {**l, "patterns": [{**PATTERN, "patternKey": "abc123"}]},  # Phase 31 field, not in this contract
        lambda l: {**l, "patterns": [{**PATTERN, "firstObservedAt": "2026-01-01T00:00:00Z"}]},
        lambda l: {**l, "patterns": [{**PATTERN, "actionType": PATTERN["actionType"] + " OR 1=1"}]},
        lambda l: {k: v for k, v in l.items() if k != "learningVersion"},
        lambda l: "not an object",
    ],
)
def test_malformed_or_unexpected_learning_fails_closed_with_a_validation_error(mutate):
    assert post(mutate(LEARNING)).status_code == 422


def test_learning_model_is_closed_and_bounded():
    with pytest.raises(ValidationError):
        LearningContext(**{**LEARNING, "extra": 1})
    assert LearningContext(**LEARNING).patterns[0].actionType == "maintenance_dispatch"


def test_there_is_no_learning_evidence_type():
    # Phase 32 spec: Learning is never a citable evidence type (decision documented in the Phase 32 doc §9).
    assert set(EvidenceType.__args__) == {"operational", "historical", "knowledge"}


def prompt(learning=None, knowledge=None, description="Warm air"):
    context = {**BASE_CONTEXT, "signal": {**BASE_CONTEXT["signal"], "description": description}}
    return build_analysis_prompt(
        SignalContext(**context),
        [KnowledgeItem(**k) for k in (knowledge or [])],
        None,
        LearningContext(**learning) if learning else None,
    )


def test_layout_adds_a_separate_labelled_learning_section_between_signal_input_and_knowledge():
    _, user = prompt(LEARNING, [item("c1", text="Synthetic guidance line.")])
    order = [user.index(f"=== {name} ===") for name in ("OPERATIONAL CONTEXT", "SIGNAL INPUT", "LEARNING CONTEXT (HISTORICAL AGGREGATE)", "BUSINESS KNOWLEDGE")]
    assert order == sorted(order)
    learning_part = user[user.index("=== LEARNING CONTEXT (HISTORICAL AGGREGATE) ==="): user.index("=== BUSINESS KNOWLEDGE ===")]
    assert "maintenance_dispatch" in learning_part and "0.7333" in learning_part
    assert "Synthetic guidance line." not in learning_part


def test_without_learning_the_section_is_absent():
    _, user = prompt(None)
    assert "LEARNING CONTEXT" not in user


def test_learning_present_without_history_still_uses_the_sectioned_layout():
    # Phase 32: learning alone (no operationalHistory) is enough to trigger the separated-sections layout.
    _, user = prompt(LEARNING)
    assert "=== SIGNAL INPUT ===" in user and "=== LEARNING CONTEXT (HISTORICAL AGGREGATE) ===" in user
    assert "=== OPERATIONAL HISTORY ===" not in user


def test_system_prompt_states_learning_is_not_evidence_and_current_evidence_wins():
    assert "LEARNING CONTEXT" in ANALYSIS_SYSTEM_PROMPT
    assert "NOT evidence about the current Signal" in ANALYSIS_SYSTEM_PROMPT
    assert "current evidence, not the historical pattern" in ANALYSIS_SYSTEM_PROMPT
    assert "no \"learning\" evidenceRef type" in ANALYSIS_SYSTEM_PROMPT
    assert "must be treated as effectively no evidence at all" in ANALYSIS_SYSTEM_PROMPT
    assert "Never restate a pattern's successRate as your own `confidence`" in ANALYSIS_SYSTEM_PROMPT


def test_learning_json_has_no_free_text_field_to_neutralize():
    # Every field in LearningPattern is a closed Literal enum, int, bool or bounded float - there is no
    # free-text string field an injected sentence could occupy (unlike knowledge text / historical situation
    # text, both of which DO need the _neutralize() treatment this module deliberately skips for Learning).
    from app.models.learning import ActionType, LearningPattern

    assert LearningPattern.model_fields["actionType"].annotation is ActionType
    assert set(ActionType.__args__) == {"maintenance_dispatch", "guest_communication", "escalation", "inspection", "other"}
    for name in ("sampleSize", "successCount", "failedCount", "partialCount"):
        assert LearningPattern.model_fields[name].annotation is int
    assert LearningPattern.model_fields["eligible"].annotation is bool
