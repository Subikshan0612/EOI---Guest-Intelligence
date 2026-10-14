"""
Tests for Intelligence V1 (POST /v1/intelligence/analyze).

Everything is synthetic and deterministic; no test calls a real provider. The
Gemini branch is exercised with a monkeypatched client, exactly like
tests/test_gemini_client.py. Run with EMBEDDING_PROVIDER=test LLM_PROVIDER=test
in the process environment (a local ai-service/.env may configure real
providers, and process environment takes precedence over it).
"""

import json
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import settings
from app.main import app
from app.models.analysis import AnalysisResponse
from app.models.context import SignalContext
from app.models.intelligence import KnowledgeItem
from app.services import gemini_analysis_client
from app.services.analysis_prompt import ANALYSIS_SYSTEM_PROMPT, build_analysis_prompt
from tests.test_knowledge_grounding import BASE_CONTEXT, knowledge_item

client = TestClient(app)


@pytest.fixture(autouse=True)
def restore_settings():
    original = (settings.llm_provider, settings.gemini_api_key, settings.llm_model)
    settings.llm_provider = "test"
    yield
    settings.llm_provider, settings.gemini_api_key, settings.llm_model = original


def analyze(knowledge=None, level=None, context=None):
    body = {"context": context or BASE_CONTEXT, "knowledge": knowledge or []}
    if level is not None:
        body["authorizedLevel"] = level
    return client.post("/v1/intelligence/analyze", json=body)


def item(chunk_id, visibility="guest", **kw):
    return knowledge_item(chunk_id, "property", visibility=visibility, sectionPath=[f"Doc > {chunk_id}"], **kw)


GOOD = {
    "situation": "The AC in Unit 204 is reported as not cooling.",
    "evidence": ["Signal 'AC not cooling' has severity high."],
    "impact": "Not available beyond the recorded severity.",
    "recommendation": "Consider the documented maintenance guidance.",
    "confidence": "medium",
    "provenance": {"provider": "test", "model": "m"},
}


# ---- the closed response contract ----------------------------------------


def test_valid_analysis_contract_accepts_exactly_the_specified_fields():
    parsed = AnalysisResponse(**GOOD)
    assert parsed.confidence == "medium" and parsed.usedKnowledgeChunkIds == []


@pytest.mark.parametrize("bad", ["HIGH", "certain", "very high", "", None, 0.9, 1, 90, "90%", True, ["high"]])
def test_confidence_accepts_only_high_medium_low(bad):
    with pytest.raises(ValidationError):
        AnalysisResponse(**{**GOOD, "confidence": bad})


@pytest.mark.parametrize("level", ["high", "medium", "low"])
def test_each_valid_confidence_level_is_accepted(level):
    assert AnalysisResponse(**{**GOOD, "confidence": level}).confidence == level


@pytest.mark.parametrize("extra", [
    {"action": "send_email"}, {"actions": [{"tool": "refund"}]}, {"toolCalls": []}, {"sendMessage": "hi"},
    {"reservationChange": {"stayId": "x"}}, {"payment": 10}, {"dbWrite": True}, {"confidenceScore": 0.9},
])
def test_no_field_can_carry_an_action_or_operation(extra):
    with pytest.raises(ValidationError):
        AnalysisResponse(**{**GOOD, **extra})


@pytest.mark.parametrize("field", ["situation", "evidence", "impact", "recommendation", "confidence", "provenance"])
def test_required_fields_are_required(field):
    body = {k: v for k, v in GOOD.items() if k != field}
    with pytest.raises(ValidationError):
        AnalysisResponse(**body)


def test_blank_text_and_blank_or_oversized_evidence_are_rejected():
    for field in ("situation", "impact", "recommendation"):
        with pytest.raises(ValidationError):
            AnalysisResponse(**{**GOOD, field: "   "})
    with pytest.raises(ValidationError):
        AnalysisResponse(**{**GOOD, "evidence": []})
    with pytest.raises(ValidationError):
        AnalysisResponse(**{**GOOD, "evidence": ["ok", " "]})
    with pytest.raises(ValidationError):
        AnalysisResponse(**{**GOOD, "evidence": ["x" * 1001]})
    with pytest.raises(ValidationError):
        AnalysisResponse(**{**GOOD, "evidence": ["e"] * 13})


# ---- deterministic (test-provider) analysis: grounded, honest, closed -----


def test_test_provider_returns_a_valid_structured_analysis_without_a_network_call():
    response = analyze([item("c1")], level="guest")
    assert response.status_code == 200
    body = response.json()
    # Phase 28: evidenceRefs/contradictions are new, additive response fields (both default to an empty list
    # when a provider omits them) - this set is updated to the new closed contract, not weakened: the
    # assertion still fails on any OTHER/unexpected key.
    # Phase 34C: claims / urgency / recommendedActionType are three more additive fields (claims is empty and the other two
    # null when a provider states none) - the set is extended, not loosened: any OTHER key still fails this assertion.
    assert set(body) == {"situation", "evidence", "impact", "recommendation", "confidence", "usedKnowledgeChunkIds", "provenance", "evidenceRefs", "contradictions", "claims", "urgency", "recommendedActionType"}
    assert body["provenance"] == {"provider": "test", "model": "deterministic-stub"}
    assert body["confidence"] in {"high", "medium", "low"}


def test_analysis_is_deterministic():
    assert analyze([item("c1")], level="guest").json() == analyze([item("c1")], level="guest").json()


def test_operational_facts_come_only_from_the_supplied_context():
    body = analyze([], level="guest").json()
    text = json.dumps(body)
    assert "AC not cooling" in text and "high" in text  # supplied signal title and severity
    assert "No guest is linked" in text and "No stay is linked" in text  # absence acknowledged, not invented
    assert "Kolam Residency" in body["situation"] and "Unit 204" in body["situation"]  # from the supplied property/unit


def test_no_invented_guest_history_or_completed_actions():
    body = analyze([item("c1")], level="guest").json()
    lowered = (body["recommendation"] + " " + body["situation"] + " " + body["impact"]).lower()
    for claim in ("was contacted", "has contacted", "were contacted", "has been resolved", "was resolved", "is resolved", "already", "has been fixed", "technician arrived", "guest was refunded"):
        assert claim not in lowered
    assert "has not taken or requested any action" in body["recommendation"]
    assert "recommendation only" in body["recommendation"]


def test_no_knowledge_is_acknowledged_and_lowers_confidence():
    body = analyze([], level="guest").json()
    assert body["confidence"] == "low"
    assert body["usedKnowledgeChunkIds"] == []
    assert any("No relevant documented Business Knowledge was retrieved" in e for e in body["evidence"])
    # RAG miss: the recommendation leads with the operational step; it is not the miss message and states no policy
    assert body["recommendation"].split("]", 1)[-1].lstrip().startswith("A person could consider")
    assert body["recommendation"].lower().count("no documented guidance") == 1  # noted once, briefly, after the operational step - never the opening


def test_knowledge_grounds_the_recommendation_and_is_cited():
    body = analyze([item("c1", section="Housekeeping"), item("c2", section="Maintenance")], level="guest").json()
    assert body["confidence"] == "medium"
    assert body["usedKnowledgeChunkIds"] == ["c1", "c2"]
    assert "Doc > c1" in body["recommendation"] and "Doc > c2" in body["recommendation"]
    assert any("Documented guidance retrieved: 'Doc > c1'" in e for e in body["evidence"])


def test_test_provider_never_claims_high_confidence():
    for knowledge in ([], [item("c1")], [item(f"c{i}") for i in range(5)]):
        assert analyze(knowledge, level="guest").json()["confidence"] != "high"


def test_knowledge_above_the_authorized_level_is_dropped_before_analysis():
    knowledge = [item("g", "guest"), item("s", "staff"), item("r", "restricted")]
    assert analyze(knowledge, level="guest").json()["usedKnowledgeChunkIds"] == ["g"]
    assert analyze(knowledge, level="staff").json()["usedKnowledgeChunkIds"] == ["g", "s"]
    assert analyze(knowledge, level="restricted").json()["usedKnowledgeChunkIds"] == ["g", "s", "r"]
    assert analyze(knowledge).json()["usedKnowledgeChunkIds"] == ["g"]  # omitted level -> guest
    body = json.dumps(analyze(knowledge, level="guest").json())
    assert "Doc > s" not in body and "Doc > r" not in body


def test_invalid_level_or_missing_item_visibility_is_rejected():
    assert analyze([item("g")], level="admin").status_code == 422
    missing = knowledge_item("c1", "property")
    del missing["visibility"]
    assert analyze([missing], level="restricted").status_code == 422


def test_request_cannot_choose_the_provider_or_smuggle_fields():
    body = {"context": BASE_CONTEXT, "knowledge": [], "provider": "gemini", "llm_provider": "gemini"}
    assert client.post("/v1/intelligence/analyze", json=body).status_code == 422


def test_unsupported_provider_returns_not_configured():
    settings.llm_provider = "not-a-real-provider"
    response = analyze()
    assert response.status_code == 503 and response.json()["error"]["code"] == "PROVIDER_NOT_CONFIGURED"


def test_gemini_provider_without_a_key_returns_not_configured():
    settings.llm_provider = "gemini"
    settings.gemini_api_key = ""
    response = analyze()
    assert response.status_code == 503 and response.json()["error"]["code"] == "PROVIDER_NOT_CONFIGURED"


# ---- the grounded prompt ---------------------------------------------------


def test_prompt_states_every_grounding_rule():
    for fragment in [
        "only source of operational facts", "only as documented business guidance", "Do not invent facts", "Do not invent policies",
        "Do not invent guest history", "Do not invent actions that were already taken", "Do not claim any staff member contacted anyone",
        "Do not claim a maintenance issue is resolved", "Do not manufacture prices, timings, policies, or procedures",
        "say plainly that it is unavailable", "Keep evidence and interpretation separate", "ground the recommendation in it",
        "Never expose restricted or internal information",
    ]:
        assert fragment in ANALYSIS_SYSTEM_PROMPT, fragment


def test_prompt_forbids_numeric_confidence_and_any_action_field():
    assert '"high", "medium", "low"' in ANALYSIS_SYSTEM_PROMPT and "NOT a probability" in ANALYSIS_SYSTEM_PROMPT
    assert "never output a number or percentage" in ANALYSIS_SYSTEM_PROMPT
    assert "There is no field for actions, tool calls, messages" in ANALYSIS_SYSTEM_PROMPT


def test_prompt_keeps_operational_context_and_business_knowledge_separate():
    _, user = build_analysis_prompt(SignalContext(**BASE_CONTEXT), [KnowledgeItem(**item("c1", text="Synthetic guidance line."))])
    assert user.index("=== OPERATIONAL CONTEXT ===") < user.index("=== BUSINESS KNOWLEDGE ===")
    assert "AC not cooling" in user[: user.index("=== BUSINESS KNOWLEDGE ===")]
    assert "Synthetic guidance line." in user[user.index("=== BUSINESS KNOWLEDGE ==="):]
    assert "Synthetic guidance line." not in user[: user.index("=== BUSINESS KNOWLEDGE ===")]


def test_prompt_without_knowledge_says_none_was_retrieved():
    _, user = build_analysis_prompt(SignalContext(**BASE_CONTEXT), [])
    assert "No organizational knowledge was retrieved" in user


def test_prompt_never_contains_dropped_knowledge_or_visibility_labels():
    seen = {}

    def fake_generate(context, knowledge):
        seen["prompt"] = build_analysis_prompt(context, knowledge)[1]
        return AnalysisResponse(**GOOD)

    import app.routers.analysis as router
    original = router.generate_deterministic_analysis
    router.generate_deterministic_analysis = fake_generate
    try:
        analyze([item("ok", "guest", text="Guest-level guidance."), item("hi", "staff", text="STAFF-ONLY-MARKER guidance.")], level="guest")
    finally:
        router.generate_deterministic_analysis = original
    assert "STAFF-ONLY-MARKER" not in seen["prompt"] and "hi" not in seen["prompt"].split("=== BUSINESS KNOWLEDGE ===")[1]
    assert "Guest-level guidance." in seen["prompt"]
    assert "visibility" not in seen["prompt"].split("=== BUSINESS KNOWLEDGE ===")[1].lower()


# ---- the real-provider branch (monkeypatched; no network) ------------------


def _gemini(monkeypatch, raw):
    fake_response = MagicMock()
    fake_response.text = raw if isinstance(raw, str) else json.dumps(raw)
    fake_client = MagicMock()
    fake_client.models.generate_content.return_value = fake_response
    monkeypatch.setattr(gemini_analysis_client.genai, "Client", lambda **kwargs: fake_client)
    settings.llm_provider = "gemini"
    settings.gemini_api_key = "fake-key-for-this-test-only"
    return fake_client


MODEL_OUT = {
    "situation": "AC in Unit 204 reported as not cooling.", "evidence": ["Signal severity is high."], "impact": "Not available.",
    "recommendation": "Consider the documented maintenance guidance.", "confidence": "medium", "usedKnowledgeChunkIds": ["c1"],
}


def test_gemini_branch_returns_a_validated_analysis_with_server_side_provenance(monkeypatch):
    _gemini(monkeypatch, MODEL_OUT)
    body = analyze([item("c1")], level="guest").json()
    assert body["situation"].startswith("AC in Unit 204") and body["confidence"] == "medium"
    assert body["usedKnowledgeChunkIds"] == ["c1"]
    assert body["provenance"]["provider"] == "gemini"


def test_gemini_branch_ignores_fields_the_model_adds_such_as_actions(monkeypatch):
    _gemini(monkeypatch, {**MODEL_OUT, "action": "refund the guest", "toolCalls": [{"name": "send_email"}], "sendMessage": "hi", "provenance": {"provider": "spoofed", "model": "x"}})
    response = analyze([item("c1")], level="guest")
    body = response.json()
    assert response.status_code == 200
    assert not ({"action", "toolCalls", "sendMessage"} & set(body))
    assert body["provenance"]["provider"] == "gemini"  # never taken from the model's output


def test_gemini_branch_drops_chunk_ids_that_were_not_supplied(monkeypatch):
    _gemini(monkeypatch, {**MODEL_OUT, "usedKnowledgeChunkIds": ["c1", "invented", "s-dropped"]})
    body = analyze([item("c1"), item("s-dropped", "staff")], level="guest").json()
    assert body["usedKnowledgeChunkIds"] == ["c1"]  # 'invented' was never supplied; 's-dropped' was above the level


@pytest.mark.parametrize("bad_confidence", [0.9, "0.9", "90%", "certain", "HIGH", None])
def test_gemini_branch_rejects_a_non_enum_confidence_as_malformed(monkeypatch, bad_confidence):
    _gemini(monkeypatch, {**MODEL_OUT, "confidence": bad_confidence})
    response = analyze([item("c1")], level="guest")
    assert response.status_code == 502 and response.json()["error"]["code"] == "MALFORMED_RESPONSE"


def test_gemini_branch_rejects_malformed_or_incomplete_output(monkeypatch):
    for raw in ("not json {{{", "[1,2]", "", json.dumps({"situation": "only this"})):
        _gemini(monkeypatch, raw)
        response = analyze([item("c1")], level="guest")
        assert response.status_code == 502 and response.json()["error"]["code"] == "MALFORMED_RESPONSE"


def test_gemini_branch_prompt_carries_only_authorized_knowledge(monkeypatch):
    fake = _gemini(monkeypatch, MODEL_OUT)
    analyze([item("c1", "guest", text="Guest guidance."), item("c2", "restricted", text="RESTRICTED-MARKER text.")], level="guest")
    call = fake.models.generate_content.call_args.kwargs
    assert "RESTRICTED-MARKER" not in call["contents"] and "Guest guidance." in call["contents"]
    assert call["config"].system_instruction == ANALYSIS_SYSTEM_PROMPT


def test_gemini_branch_maps_provider_errors_without_leaking_details(monkeypatch):
    from google.genai import errors as genai_errors

    fake_client = MagicMock()
    fake_client.models.generate_content.side_effect = genai_errors.APIError(code=429, response_json={"error": {"message": "secret detail"}})
    monkeypatch.setattr(gemini_analysis_client.genai, "Client", lambda **kwargs: fake_client)
    settings.llm_provider = "gemini"
    settings.gemini_api_key = "fake-key-for-this-test-only"
    response = analyze()
    assert response.status_code == 502 and "secret detail" not in response.text


# ---- hardening: guest privacy, exact statuses, impact, confidence -----------

STAY_CONFIRMED = {
    "id": "stay1", "available": True, "guestId": "g1", "propertyId": "prop1", "unitId": "unit1", "reservationId": "R-1",
    "checkIn": "2026-09-24T06:30:00.000Z", "checkOut": "2026-09-27T05:30:00.000Z", "status": "confirmed", "adults": 2, "children": 0, "source": "",
}
GUEST_WITH_PII = {
    "id": "g1", "available": True, "firstName": "Synthfirst", "lastName": "Synthlast", "email": "synth@example.invalid", "phone": "10001 20002",
    "recentStays": [STAY_CONFIRMED],
}


def context_with(guest=None, stay=None):
    return {**BASE_CONTEXT, "guest": guest, "stay": stay}


def user_prompt(context_dict):
    return build_analysis_prompt(SignalContext(**context_dict), [])[1]


def test_guest_name_email_and_phone_never_reach_the_prompt_even_if_the_caller_sent_them():
    prompt = user_prompt(context_with(GUEST_WITH_PII, STAY_CONFIRMED))
    for leaked in ("Synthfirst", "Synthlast", "synth@example.invalid", "20002"):
        assert leaked not in prompt
    for key in ('"firstName"', '"lastName"', '"email"', '"phone"'):
        assert key not in prompt  # not even as null-valued keys


def test_guest_identifier_availability_and_stays_are_still_in_the_prompt():
    prompt = user_prompt(context_with(GUEST_WITH_PII, STAY_CONFIRMED))
    assert '"id": "g1"' in prompt and '"available": true' in prompt and '"recentStays"' in prompt
    assert '"reservationId": "R-1"' in prompt and "2026-09-24T06:30:00.000Z" in prompt and "2026-09-27T05:30:00.000Z" in prompt


def test_recorded_stay_status_reaches_the_prompt_exactly_as_supplied():
    prompt = user_prompt(context_with(None, STAY_CONFIRMED))
    assert '"status": "confirmed"' in prompt
    assert "checked_in" not in prompt and "checked in" not in prompt.lower()


def test_prompt_with_no_guest_is_unchanged_in_shape():
    assert '"guest": null' in user_prompt(context_with(None, None))


def test_system_prompt_prohibits_inferring_stay_states_from_dates():
    for fragment in [
        "State every operational status exactly as recorded", "for example, a stay whose status is \"confirmed\" is a confirmed stay",
        "Never infer", "checked in", "checked out", "arrived", "departed", "in-house", "occupied", "from dates, times",
        "Only a supplied field that explicitly records that state establishes it",
    ]:
        assert fragment in ANALYSIS_SYSTEM_PROMPT, fragment


def test_system_prompt_prohibits_inferring_that_an_event_happened_because_it_is_plausible():
    assert "Never infer that an event occurred because its date or time would make it plausible" in ANALYSIS_SYSTEM_PROMPT


def test_system_prompt_requires_recorded_facts_to_be_separated_and_gaps_to_be_stated():
    assert "Separate recorded facts from interpretation" in ANALYSIS_SYSTEM_PROMPT
    assert "not established" in ANALYSIS_SYSTEM_PROMPT and "do not resolve the gap yourself" in ANALYSIS_SYSTEM_PROMPT


def test_system_prompt_requires_impact_to_separate_known_from_not_established():
    for fragment in [
        "KNOWN", "NOT ESTABLISHED", "directly supplied by the Signal or the operational context, or supported by the supplied Business Knowledge",
        "duration", "severity", "guest discomfort", "dissatisfaction",
        "Do not present generic hospitality consequences as established facts",
        "clearly labelled as a potential or possible impact",
    ]:
        assert fragment in ANALYSIS_SYSTEM_PROMPT, fragment


def test_confidence_definitions_are_the_tightened_evidence_quality_rules():
    high = ANALYSIS_SYSTEM_PROMPT[ANALYSIS_SYSTEM_PROMPT.index("HIGH:"):ANALYSIS_SYSTEM_PROMPT.index("MEDIUM:")]
    medium = ANALYSIS_SYSTEM_PROMPT[ANALYSIS_SYSTEM_PROMPT.index("MEDIUM:"):ANALYSIS_SYSTEM_PROMPT.index("LOW:")]
    low = ANALYSIS_SYSTEM_PROMPT[ANALYSIS_SYSTEM_PROMPT.index("LOW:"):]
    assert "directly supported" in high and "directly grounded in relevant Business Knowledge" in high and "no meaningful unresolved factual inference" in high
    assert "one or more material operational facts remain unavailable, ambiguous, or require limited interpretation" in medium
    assert "sparse, absent, weak, or mostly unavailable" in low
    assert "evidence quality" in ANALYSIS_SYSTEM_PROMPT and "NOT a probability" in ANALYSIS_SYSTEM_PROMPT
    assert "An unsupported factual inference prevents HIGH" in ANALYSIS_SYSTEM_PROMPT


def test_confidence_enum_and_no_numeric_output_rules_are_kept():
    assert '"high", "medium", "low"' in ANALYSIS_SYSTEM_PROMPT and "never output a number or percentage" in ANALYSIS_SYSTEM_PROMPT


def test_all_original_grounding_rules_are_still_present():
    for fragment in ["only source of operational facts", "Do not invent facts", "Do not invent policies", "Do not invent actions that were already taken", "Do not claim any staff member contacted anyone", "Never expose restricted or internal information", "There is no field for actions"]:
        assert fragment in ANALYSIS_SYSTEM_PROMPT


def test_test_provider_states_the_recorded_status_exactly_and_never_infers_a_state():
    body = analyze([], level="guest", context=context_with(None, STAY_CONFIRMED)).json()
    text = json.dumps(body).lower()
    assert "status 'confirmed'" in text
    for inferred in ("checked in", "checked-in", "in-house", "currently staying", "active stay", "arrived", "occupied"):
        assert inferred not in text


def test_test_provider_impact_separates_what_is_recorded_from_what_is_not_available():
    impact = analyze([], level="guest").json()["impact"]
    assert "records severity" in impact and "not available" in impact
