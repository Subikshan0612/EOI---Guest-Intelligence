"""
AI provider observability + the single 503 retry (Workstream 1 of the provider-reliability diagnostic).

Everything is synthetic and deterministic: the Gemini SDK client is always a MagicMock (tests/conftest.py's network guard also fails any
non-loopback connection), the retry delay is replaced by a recorder, and no test depends on real Gemini availability.

What is pinned here:
  - 503 is retried EXACTLY once; 504, client timeouts, every other status, transport errors and unexpected exceptions are never retried;
  - the retry is bounded and deterministic (pure `decide_retry`, attempt cap, time-budget rule), and the SDK's own retry stays off;
  - the provider failure classification (PROVIDER_503 / _504 / _OTHER / _TIMEOUT / _UNKNOWN) uses the status the provider actually reported;
  - one correlation id per request, taken from `X-KOI-Request-Id` when it is a canonical uuid, otherwise generated; distinct per request;
  - the structured events carry no prompt, output, Signal text, guest detail, header or key, and never change the public error behaviour.
"""

import json
import re
import uuid

import httpx
import pytest
from google.genai import errors as genai_errors

from app import provider_observability as obs
from app.config import settings
from app.provider_policy import ANALYSIS_DEADLINE_CEILING_MS, PROVIDER_TIMEOUT_CEILING_MS
from app.services import gemini_analysis_client
from tests.test_provider_policy import FAKE_KEY, MODEL_OUT, analyze, client, ok_response, use_gemini
from tests.test_knowledge_grounding import BASE_CONTEXT

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
EVENT_PREFIX = "[KOI AI EVENT] "


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    original = (settings.llm_provider, settings.gemini_api_key, settings.llm_model, settings.llm_max_output_tokens, settings.request_timeout_ms)
    settings.llm_provider = "test"
    sleeps: list[float] = []
    lines: list[str] = []
    monkeypatch.setattr(gemini_analysis_client, "_sleep", lambda seconds: sleeps.append(seconds))
    obs.set_event_sink(lines.append)
    yield {"sleeps": sleeps, "lines": lines}
    obs.set_event_sink(None)
    settings.llm_provider, settings.gemini_api_key, settings.llm_model, settings.llm_max_output_tokens, settings.request_timeout_ms = original


def events(isolate):
    return [json.loads(line[len(EVENT_PREFIX):]) for line in isolate["lines"] if line.startswith(EVENT_PREFIX)]


def api_error(code, message="provider detail", status=None):
    body = {"error": {"message": message}}
    if status:
        body["error"]["status"] = status
    return genai_errors.APIError(code=code, response_json=body)


def sequence(*items):
    """A side_effect that yields the given exceptions / responses in order (an exception instance is raised, anything else is returned)."""
    it = iter(items)

    def step(*args, **kwargs):
        value = next(it)
        if isinstance(value, BaseException):
            raise value
        return value

    return step


def use_sequence(monkeypatch, *items):
    fake_client, factory = use_gemini(monkeypatch, response=ok_response())
    fake_client.models.generate_content.side_effect = sequence(*items)
    return fake_client, factory


# ---- 1-3: the 503 retry ------------------------------------------------------------------------------------------------------------------------


def test_01_successful_first_attempt_makes_one_call_and_no_retry(monkeypatch, isolate):
    fake, _ = use_sequence(monkeypatch, ok_response())
    response = analyze()
    assert response.status_code == 200
    assert fake.models.generate_content.call_count == 1 and isolate["sleeps"] == []
    evs = events(isolate)
    assert [e["event"] for e in evs] == ["provider.attempt", "provider.analysis_final"]
    assert evs[0]["outcome"] == "success" and evs[0]["attempt"] == 1 and evs[0]["retryDecision"] == "none"
    assert evs[1]["finalOutcome"] == "success" and evs[1]["attempts"] == 1 and evs[1]["retried"] is False


def test_02_first_503_then_success_retries_exactly_once_and_succeeds(monkeypatch, isolate):
    fake, _ = use_sequence(monkeypatch, api_error(503, "This model is currently experiencing high demand.", "UNAVAILABLE"), ok_response())
    response = analyze()
    assert response.status_code == 200 and response.json()["situation"] == MODEL_OUT["situation"]
    assert fake.models.generate_content.call_count == 2
    assert isolate["sleeps"] == [obs.RETRY_DELAY_SECONDS]
    evs = events(isolate)
    assert [e["event"] for e in evs] == ["provider.attempt", "provider.attempt", "provider.analysis_final"]
    first, second, final = evs
    assert (first["outcome"], first["category"], first["httpStatus"], first["providerStatus"], first["retryDecision"]) == ("failure", "PROVIDER_503", 503, "UNAVAILABLE", "retry_503")
    assert first["retryDelayMs"] == 1000 and "high demand" in first["providerMessage"]
    assert (second["outcome"], second["attempt"], second["retryDecision"]) == ("success", 2, "none")
    assert final["finalOutcome"] == "success" and final["attempts"] == 2 and final["retried"] is True


def test_03_two_503s_stop_after_the_single_retry_and_return_the_existing_safe_failure(monkeypatch, isolate):
    fake, _ = use_sequence(monkeypatch, api_error(503, "high demand", "UNAVAILABLE"), api_error(503, "high demand", "UNAVAILABLE"), ok_response())
    response = analyze()
    assert response.status_code == 503 and response.json()["error"]["code"] == "PROVIDER_UNAVAILABLE"  # the unchanged public contract
    assert fake.models.generate_content.call_count == 2  # the third item (a success) is never reached: exactly one retry
    assert isolate["sleeps"] == [obs.RETRY_DELAY_SECONDS]
    evs = events(isolate)
    assert [e.get("retryDecision") for e in evs if e["event"] == "provider.attempt"] == ["retry_503", "no_retry_attempts_exhausted"]
    final = evs[-1]
    assert final["event"] == "provider.analysis_final" and final["finalOutcome"] == "failure" and final["finalCategory"] == "PROVIDER_503"
    assert final["finalTaxonomy"] == "provider_unavailable" and final["attempts"] == 2 and final["retried"] is True


# ---- 4-6: nothing else is retried --------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "error, category, code",
    [
        (api_error(504, "deadline", "DEADLINE_EXCEEDED"), "PROVIDER_504", "PROVIDER_TIMEOUT"),
        (httpx.ReadTimeout("t"), "PROVIDER_TIMEOUT", "PROVIDER_TIMEOUT"),
        (httpx.ConnectTimeout("t"), "PROVIDER_TIMEOUT", "PROVIDER_TIMEOUT"),
        (api_error(408), "PROVIDER_OTHER", "PROVIDER_TIMEOUT"),
        (api_error(400), "PROVIDER_OTHER", "PROVIDER_BAD_REQUEST"),
        (api_error(401), "PROVIDER_OTHER", "PROVIDER_AUTHENTICATION_FAILED"),
        (api_error(403), "PROVIDER_OTHER", "PROVIDER_FORBIDDEN"),
        (api_error(404), "PROVIDER_OTHER", "PROVIDER_NOT_CONFIGURED"),
        (api_error(429), "PROVIDER_OTHER", "PROVIDER_RATE_LIMITED"),
        (api_error(500), "PROVIDER_OTHER", "PROVIDER_UNAVAILABLE"),
        (api_error(502), "PROVIDER_OTHER", "PROVIDER_UNAVAILABLE"),
        (httpx.ConnectError("refused"), "PROVIDER_UNKNOWN", "PROVIDER_UNAVAILABLE"),
        (RuntimeError("anything else"), "PROVIDER_UNKNOWN", "PROVIDER_UNKNOWN_ERROR"),
    ],
)
def test_04_to_06_only_a_503_is_ever_retried(monkeypatch, isolate, error, category, code):
    fake, _ = use_sequence(monkeypatch, error, ok_response())
    response = analyze()
    assert fake.models.generate_content.call_count == 1  # the success queued behind it is never reached
    assert isolate["sleeps"] == []
    assert response.json()["error"]["code"] == code  # the public error mapping is unchanged
    attempt = [e for e in events(isolate) if e["event"] == "provider.attempt"]
    assert len(attempt) == 1 and attempt[0]["category"] == category and attempt[0]["retryDecision"] == "no_retry_not_503"
    final = events(isolate)[-1]
    assert final["finalOutcome"] == "failure" and final["attempts"] == 1 and final["retried"] is False


def test_06b_a_response_that_arrives_is_never_retried_even_if_unusable(monkeypatch, isolate):
    from tests.test_provider_policy import real_response

    fake, _ = use_sequence(monkeypatch, real_response(text=None), ok_response())
    response = analyze()
    assert response.status_code >= 400 and fake.models.generate_content.call_count == 1 and isolate["sleeps"] == []


# ---- 7: classification -------------------------------------------------------------------------------------------------------------------------


def test_07_classification_uses_the_status_the_provider_reported_and_never_invents_one():
    c = obs.classify_provider_exception
    assert (c(api_error(503, "high demand", "UNAVAILABLE")).category, c(api_error(503)).http_status) == ("PROVIDER_503", 503)
    assert (c(api_error(504)).category, c(api_error(504)).http_status) == ("PROVIDER_504", 504)
    for status in (400, 401, 403, 404, 408, 429, 500, 502):
        failure = c(api_error(status))
        assert failure.category == "PROVIDER_OTHER" and failure.http_status == status
    for exc in (httpx.ReadTimeout("x"), httpx.ConnectTimeout("x"), TimeoutError("x")):
        failure = c(exc)
        assert failure.category == "PROVIDER_TIMEOUT" and failure.http_status is None and failure.provider_status is None
    for exc in (httpx.ConnectError("x"), RuntimeError("x"), ValueError("x")):
        failure = c(exc)
        assert failure.category == "PROVIDER_UNKNOWN" and failure.http_status is None
    assert set(obs.PROVIDER_CATEGORIES) == {"PROVIDER_503", "PROVIDER_504", "PROVIDER_OTHER", "PROVIDER_TIMEOUT", "PROVIDER_UNKNOWN"}
    # an API error that reports no usable status is UNKNOWN, not a guessed number
    odd = genai_errors.APIError(code=None, response_json={"error": {"message": "x"}})
    assert c(odd).category == "PROVIDER_UNKNOWN" and c(odd).http_status is None


def test_07b_provider_message_is_kept_for_5xx_only_and_is_sanitised():
    c = obs.classify_provider_exception
    assert c(api_error(503, "This model is currently experiencing high demand.")).message == "This model is currently experiencing high demand."
    for status in (400, 401, 403, 404, 429):
        assert c(api_error(status, "Request contained: the guest's room is 204")).message is None  # a 4xx message can quote the request
    dirty = c(api_error(500, "bad key AIzaSyA-1234567890abcdefghijk and Bearer abc.def.ghi for a.b@example.com see https://x.invalid/?key=zzz\x00\n " + "x" * 400)).message
    assert dirty is not None and len(dirty) <= 200
    for leaked in ("AIzaSyA", "abc.def.ghi", "a.b@example.com", "https://", "\x00", "\n"):
        assert leaked not in dirty


# ---- 8-10: correlation id ----------------------------------------------------------------------------------------------------------------------


def test_08_a_correlation_id_is_generated_when_the_caller_sends_none(monkeypatch, isolate):
    use_sequence(monkeypatch, ok_response())
    assert analyze().status_code == 200
    evs = events(isolate)
    ids = {e["correlationId"] for e in evs}
    assert len(ids) == 1 and UUID_RE.match(ids.pop()) and evs[0]["correlationSource"] == "generated"


def test_09_the_id_sent_by_node_is_the_id_on_every_attempt_and_the_final_event(monkeypatch, isolate):
    node_id = str(uuid.uuid4())
    use_sequence(monkeypatch, api_error(503, "high demand"), ok_response())
    response = client.post("/v1/intelligence/analyze", json={"context": BASE_CONTEXT, "knowledge": []}, headers={"X-KOI-Request-Id": node_id.upper()})
    assert response.status_code == 200
    evs = events(isolate)
    assert len(evs) == 3 and {e["correlationId"] for e in evs} == {node_id}
    assert [e.get("correlationSource") for e in evs if e["event"] == "provider.attempt"] == ["node", "node"]


@pytest.mark.parametrize("hostile", ["", "not-a-uuid", "workspace-507f1f77bcf86cd799439011", "' OR 1=1 --", "x" * 500, "6acc81fa-53576853-a057f150", "\n[KOI AI EVENT] {\"forged\":true}"])
def test_09b_a_supplied_value_that_is_not_a_canonical_uuid_is_replaced_never_logged(monkeypatch, isolate, hostile):
    use_sequence(monkeypatch, ok_response())
    headers = {"X-KOI-Request-Id": hostile.replace("\n", " ")} if hostile else {}
    assert client.post("/v1/intelligence/analyze", json={"context": BASE_CONTEXT, "knowledge": []}, headers=headers).status_code == 200
    evs = events(isolate)
    assert all(UUID_RE.match(e["correlationId"]) for e in evs) and evs[0]["correlationSource"] == "generated"
    joined = "\n".join(isolate["lines"])
    assert "forged" not in joined and "workspace-" not in joined and "OR 1=1" not in joined


def test_10_different_requests_get_different_correlation_ids(monkeypatch, isolate):
    use_sequence(monkeypatch, ok_response(), ok_response(), ok_response())
    for _ in range(3):
        assert analyze().status_code == 200
    ids = [e["correlationId"] for e in events(isolate) if e["event"] == "provider.analysis_final"]
    assert len(ids) == 3 and len(set(ids)) == 3
    assert obs.resolve_correlation_id(None)[0] != obs.resolve_correlation_id(None)[0]


# ---- 11: nothing sensitive in the events -------------------------------------------------------------------------------------------------------


def test_11_events_never_contain_a_prompt_output_signal_text_guest_detail_header_or_key(monkeypatch, isolate, capsys):
    context = json.loads(json.dumps(BASE_CONTEXT))
    context["signal"]["title"] = "SIGNAL-TITLE-MARKER boiler"
    context["signal"]["description"] = "SIGNAL-TEXT-MARKER the guest Synth Person (synth@example.invalid) is upset"
    secret_error = api_error(503, "high demand. api key " + FAKE_KEY + " AIzaSyA-1234567890abcdefghijk", "UNAVAILABLE")
    out = dict(MODEL_OUT, recommendation="MODEL-OUTPUT-MARKER do something")
    from tests.test_provider_policy import real_response

    use_sequence(monkeypatch, secret_error, real_response(text=json.dumps(out)))
    headers = {"Authorization": "Bearer ACCESS-TOKEN-MARKER", "Cookie": "refresh=COOKIE-MARKER", "X-KOI-Service-Token": "SERVICE-TOKEN-MARKER"}
    response = client.post("/v1/intelligence/analyze", json={"context": context, "knowledge": []}, headers=headers)
    assert response.status_code == 200
    blob = "\n".join(isolate["lines"]) + capsys.readouterr().out
    for marker in ("SIGNAL-TITLE-MARKER", "SIGNAL-TEXT-MARKER", "synth@example.invalid", "Synth Person", "MODEL-OUTPUT-MARKER", "ACCESS-TOKEN-MARKER", "COOKIE-MARKER",
                   "SERVICE-TOKEN-MARKER", FAKE_KEY, "AIzaSyA", "mongodb", "workspaceId"):
        assert marker not in blob, marker
    assert "high demand" in blob  # the provider's own (sanitised) condition IS preserved


def test_11b_only_allowlisted_fields_can_be_logged_and_unsafe_values_are_dropped(isolate):
    obs.emit_event("provider.attempt", correlationId=str(uuid.uuid4()), prompt="the whole prompt", outputText="the model said", authorization="Bearer x", category="has spaces and a sentence")
    obs.emit_event("BAD NAME", category="PROVIDER_503")
    (event,) = events(isolate)
    assert set(event) == {"event", "correlationId"}


# ---- 12: the retry bound ---------------------------------------------------------------------------------------------------------------------------


def test_12_the_retry_is_bounded_deterministic_and_pure():
    failure_503 = obs.classify_provider_exception(api_error(503))
    assert obs.MAX_PROVIDER_ATTEMPTS == 2  # first attempt + exactly one retry
    assert obs.decide_retry(failure_503, 1, 1500) == obs.RetryDecision(True, "retry_503", obs.RETRY_DELAY_SECONDS)
    assert obs.decide_retry(failure_503, 1, 1500) == obs.decide_retry(failure_503, 1, 1500)  # deterministic: no jitter, no clock, no state
    for attempt in (2, 3, 10):
        assert obs.decide_retry(failure_503, attempt, 100).retry is False  # never a second retry, whatever the attempt number
    assert obs.decide_retry(failure_503, 1, obs.RETRY_FIRST_ATTEMPT_MAX_MS).retry is True
    assert obs.decide_retry(failure_503, 1, obs.RETRY_FIRST_ATTEMPT_MAX_MS + 1) == obs.RetryDecision(False, "no_retry_budget", 0.0)
    for exc in (api_error(504), api_error(400), api_error(429), api_error(500), httpx.ReadTimeout("x"), httpx.ConnectError("x"), RuntimeError("x")):
        assert obs.decide_retry(obs.classify_provider_exception(exc), 1, 10).retry is False


def test_12b_the_whole_retry_fits_inside_the_node_wait_and_no_timeout_was_changed():
    # worst case: first attempt (<= RETRY_FIRST_ATTEMPT_MAX_MS) + delay + one full analysis deadline (the largest PERMITTED one), against Node's default analysis wait
    # (Workstream 5C: the analysis ceiling + a 5 s margin = 65 s; it no longer follows the 20 s retrieval/embedding timeout)
    node_default_wait_ms = ANALYSIS_DEADLINE_CEILING_MS + 5000
    worst_ms = obs.RETRY_FIRST_ATTEMPT_MAX_MS + obs.RETRY_DELAY_SECONDS * 1000 + ANALYSIS_DEADLINE_CEILING_MS
    assert worst_ms <= node_default_wait_ms - 1000
    # ...and nothing else was changed: the embedding/retrieval timeout and its ceiling are as before, the output limit is as before
    assert PROVIDER_TIMEOUT_CEILING_MS == 20000 and Settings_default("request_timeout_ms") == 20000 and Settings_default("llm_max_output_tokens") == 4096


def Settings_default(name):
    from app.config import Settings

    return Settings.model_fields[name].default


def test_12c_the_sdk_client_is_still_built_with_one_attempt_and_the_unchanged_timeout(monkeypatch, isolate):
    _, factory = use_sequence(monkeypatch, api_error(503), ok_response())
    assert analyze().status_code == 200
    (call,) = factory.call_args_list  # one client for the request: both attempts reuse it
    options = call.kwargs["http_options"]
    assert options.retry_options.attempts == 1  # the SDK's own retry layer stays off: this module is the only retry
    assert options.timeout == settings.llm_analysis_timeout_ms  # Workstream 5C: the analysis call uses its own deadline setting
    assert settings.request_timeout_ms == 20000  # ...and the embedding/retrieval-side timeout is untouched


# ---- 13-15: nothing else about the analysis path changed ---------------------------------------------------------------------------------------


def test_13_the_request_to_the_provider_is_identical_on_both_attempts_and_carries_no_correlation_id(monkeypatch, isolate):
    fake, _ = use_sequence(monkeypatch, api_error(503), ok_response())
    assert analyze().status_code == 200
    first, second = fake.models.generate_content.call_args_list
    assert first.kwargs["contents"] == second.kwargs["contents"] and first.kwargs["config"] is second.kwargs["config"] and first.kwargs["model"] == second.kwargs["model"]
    assert "request-id" not in json.dumps(first.kwargs["contents"], default=str).lower()  # the id is for logs only: it never enters the prompt


def test_14_validation_of_a_received_response_is_unchanged_after_a_retry(monkeypatch, isolate):
    from tests.test_provider_policy import real_response

    use_sequence(monkeypatch, api_error(503), real_response(text="{not json"))
    response = analyze()
    assert response.status_code == 502 and response.json()["error"]["code"] == "MALFORMED_RESPONSE"  # the retry returned a response; it is validated exactly as before
    final = events(isolate)
    assert final[-1]["finalOutcome"] == "success"  # the PROVIDER call succeeded; rejection of its content is not a provider failure


def test_15_the_deterministic_test_provider_makes_no_provider_events_and_ignores_the_header():
    settings.llm_provider = "test"
    response = client.post("/v1/intelligence/analyze", json={"context": BASE_CONTEXT, "knowledge": []}, headers={"X-KOI-Request-Id": str(uuid.uuid4())})
    assert response.status_code == 200 and response.json()["provenance"]["provider"] == "test"
