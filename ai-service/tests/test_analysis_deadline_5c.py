"""
Workstream 5C - the Gemini ANALYSIS deadline is its own, separately bounded setting.

What is pinned here (everything synthetic: the Gemini SDK is always a MagicMock, no network, no key):
  - LLM_ANALYSIS_TIMEOUT_MS has its own ceiling (60 s) and its own start-up / request-time gates, and the 20 s ceiling of REQUEST_TIMEOUT_MS is NOT loosened by it;
  - the analysis call is built with the analysis deadline, the EMBEDDING call keeps REQUEST_TIMEOUT_MS (so a longer analysis deadline never lengthens retrieval);
  - the Workstream 1 503 retry rule is unchanged and still fits inside Node's analysis wait for EVERY permitted deadline;
  - with a 30 / 45 / 60 s deadline: 503 -> success is exactly two provider calls, 503 -> 503 exactly two then the existing failure, 504 / timeout / 4xx exactly one, never a third;
  - Node and Python assert against the same two ceilings.
"""

import re
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pytest

from app import provider_observability as obs
from app import provider_policy
from app.config import Settings, settings
from app.services import gemini_analysis_client, gemini_embedding_client
from tests.test_provider_observability import api_error, use_sequence
from tests.test_provider_policy import APPROVED, FAKE_KEY, analyze, ok_response, use_gemini

AI_SERVICE_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_CONFIG = (AI_SERVICE_ROOT.parent / "backend" / "src" / "config" / "runtimeConfig.js").read_text(encoding="utf8")
DEADLINES = (30000, 45000, 60000)


@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    original = (settings.llm_provider, settings.gemini_api_key, settings.llm_model, settings.request_timeout_ms, settings.llm_analysis_timeout_ms)
    settings.llm_provider = "test"
    sleeps: list[float] = []
    lines: list[str] = []
    monkeypatch.setattr(gemini_analysis_client, "_sleep", lambda seconds: sleeps.append(seconds))
    obs.set_event_sink(lines.append)
    yield {"sleeps": sleeps, "lines": lines}
    obs.set_event_sink(None)
    settings.llm_provider, settings.gemini_api_key, settings.llm_model, settings.request_timeout_ms, settings.llm_analysis_timeout_ms = original


# ---- 1. two settings, two ceilings ---------------------------------------------------------------------------------------------------------------


def test_01_two_separate_ceilings_and_defaults_inside_them():
    assert provider_policy.PROVIDER_TIMEOUT_CEILING_MS == 20000  # REQUEST_TIMEOUT_MS: embedding / retrieval side: still short
    assert provider_policy.ANALYSIS_DEADLINE_CEILING_MS == 60000  # LLM_ANALYSIS_TIMEOUT_MS: the one call allowed to be slow
    assert provider_policy.is_valid_analysis_deadline(Settings().llm_analysis_timeout_ms)
    assert Settings().request_timeout_ms == 20000  # unchanged


def test_02_analysis_deadline_validity_is_a_real_int_between_1_and_its_ceiling():
    for ok in (1, 20000, 30000, 45000, 60000):
        assert provider_policy.is_valid_analysis_deadline(ok)
    for bad in (0, -1, 60001, 10**9, True, False, "60000", 60000.0, None):
        assert not provider_policy.is_valid_analysis_deadline(bad)
    # a longer analysis deadline does not make a longer REQUEST_TIMEOUT_MS valid
    for bad in (20001, 30000, 45000, 60000):
        assert not provider_policy.is_valid_provider_timeout(bad)


def test_03_startup_gate_bounds_each_setting_by_its_own_ceiling():
    provider_policy.validate_startup_configuration("gemini", APPROVED, 20000, "test", 60000)
    provider_policy.validate_startup_configuration("gemini", APPROVED, 20000, "gemini", 45000)
    with pytest.raises(RuntimeError, match="LLM_ANALYSIS_TIMEOUT_MS"):
        provider_policy.validate_startup_configuration("gemini", APPROVED, 20000, "test", 60001)
    with pytest.raises(RuntimeError, match="LLM_ANALYSIS_TIMEOUT_MS"):
        provider_policy.validate_startup_configuration("gemini", APPROVED, 20000, "test", 0)
    with pytest.raises(RuntimeError, match="REQUEST_TIMEOUT_MS"):
        provider_policy.validate_startup_configuration("gemini", APPROVED, 60000, "test", 60000)  # the long analysis deadline does not licence a long retrieval timeout
    # the deterministic provider is not governed; an embedding-only Gemini configuration does not govern the analysis deadline
    provider_policy.validate_startup_configuration("test", "anything", 20000, "test", 10**9)
    provider_policy.validate_startup_configuration("test", "anything", 20000, "gemini", 10**9)


def _start_with(env_extra):
    import os

    env = {**os.environ, "GEMINI_API_KEY": FAKE_KEY, "KOI_NO_DOTENV": "1", "KOI_NO_DOTENV_REASON": "validation", **env_extra}
    return subprocess.run([sys.executable, "-c", "import app.main"], cwd=AI_SERVICE_ROOT, env=env, capture_output=True, text=True, timeout=60)


def test_04_service_process_enforces_both_gates():
    base = {"LLM_PROVIDER": "gemini", "LLM_MODEL": APPROVED, "EMBEDDING_PROVIDER": "test"}
    assert _start_with({**base, "LLM_ANALYSIS_TIMEOUT_MS": "60000"}).returncode == 0
    assert _start_with({**base, "LLM_ANALYSIS_TIMEOUT_MS": "45000", "REQUEST_TIMEOUT_MS": "20000"}).returncode == 0
    refused = _start_with({**base, "LLM_ANALYSIS_TIMEOUT_MS": "60001"})
    assert refused.returncode != 0 and "Refusing to start" in refused.stderr and "LLM_ANALYSIS_TIMEOUT_MS" in refused.stderr and FAKE_KEY not in refused.stderr
    assert _start_with({**base, "LLM_ANALYSIS_TIMEOUT_MS": "0"}).returncode != 0
    still = _start_with({**base, "LLM_ANALYSIS_TIMEOUT_MS": "60000", "REQUEST_TIMEOUT_MS": "60000"})
    assert still.returncode != 0 and "REQUEST_TIMEOUT_MS" in still.stderr  # the 20 s ceiling of the retrieval-side timeout is NOT loosened
    assert _start_with({"LLM_PROVIDER": "test", "EMBEDDING_PROVIDER": "test", "LLM_ANALYSIS_TIMEOUT_MS": "999999"}).returncode == 0


# ---- 2. which call uses which timeout ------------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("deadline", DEADLINES)
def test_05_the_analysis_call_uses_the_analysis_deadline_and_the_embedding_call_keeps_the_short_one(monkeypatch, isolate, deadline):
    monkeypatch.setattr(settings, "llm_analysis_timeout_ms", deadline)
    monkeypatch.setattr(settings, "request_timeout_ms", 20000)
    _, factory = use_gemini(monkeypatch, ok_response())
    assert analyze().status_code == 200
    (call,) = factory.call_args_list
    assert call.kwargs["http_options"].timeout == deadline and call.kwargs["http_options"].retry_options.attempts == 1

    embed_client = MagicMock()
    embed_client.models.embed_content.return_value = MagicMock(embeddings=[MagicMock(values=[0.1, 0.2])])
    embed_factory = MagicMock(return_value=embed_client)
    monkeypatch.setattr(gemini_embedding_client.genai, "Client", embed_factory)
    settings.gemini_api_key = FAKE_KEY
    try:
        gemini_embedding_client.generate_gemini_embeddings(["a"])
    except Exception:  # noqa: BLE001 - only the construction of the client matters here, not the shape of the mocked response
        pass
    (embed_call,) = embed_factory.call_args_list
    assert embed_call.kwargs["http_options"].timeout == 20000  # a longer analysis deadline never lengthens an embedding call


# ---- 3. the 503 retry rule is unchanged and still fits ---------------------------------------------------------------------------------------------


def test_06_the_retry_rule_is_exactly_the_workstream_1_rule():
    assert obs.MAX_PROVIDER_ATTEMPTS == 2 and obs.RETRY_DELAY_SECONDS == 1.0 and obs.RETRY_FIRST_ATTEMPT_MAX_MS == 3000


def test_07_the_retry_fits_inside_nodes_wait_for_every_permitted_deadline():
    node_margin = int(re.search(r"ANALYSIS_TIMEOUT_MARGIN_MS\s*=\s*([0-9_]+)", RUNTIME_CONFIG).group(1).replace("_", ""))
    node_wait = provider_policy.ANALYSIS_DEADLINE_CEILING_MS + node_margin
    for deadline in range(1, provider_policy.ANALYSIS_DEADLINE_CEILING_MS + 1, 997):
        worst = obs.RETRY_FIRST_ATTEMPT_MAX_MS + int(obs.RETRY_DELAY_SECONDS * 1000) + deadline
        assert worst <= node_wait - 1000, deadline
    assert obs.RETRY_FIRST_ATTEMPT_MAX_MS + int(obs.RETRY_DELAY_SECONDS * 1000) + provider_policy.ANALYSIS_DEADLINE_CEILING_MS <= node_wait - 1000


@pytest.mark.parametrize("deadline", DEADLINES)
def test_08_provider_call_counts_with_a_long_deadline(monkeypatch, isolate, deadline):
    monkeypatch.setattr(settings, "llm_analysis_timeout_ms", deadline)
    cases = [
        ("503 then success", [api_error(503), ok_response()], 200, 2),
        ("503 then 503", [api_error(503), api_error(503)], 503, 2),
        ("504", [api_error(504)], 504, 1),
        ("client timeout", [httpx.ReadTimeout("x")], 504, 1),
        ("400", [api_error(400)], None, 1),
        ("401", [api_error(401)], None, 1),
        ("403", [api_error(403)], None, 1),
        ("429", [api_error(429)], None, 1),
        ("500", [api_error(500)], None, 1),
    ]
    for label, items, status, calls in cases:
        isolate["sleeps"].clear()
        fake_client, _ = use_sequence(monkeypatch, *items, ok_response())  # a spare success at the end: a third attempt would "work" and be counted
        response = analyze()
        assert fake_client.models.generate_content.call_count == calls, (label, deadline)
        if status is not None:
            assert response.status_code == status, (label, deadline)
        else:
            assert response.status_code >= 400, (label, deadline)
        assert len(isolate["sleeps"]) == (1 if label.startswith("503") else 0), (label, deadline)  # the one retry delay, only after a 503


# ---- 4. Node and Python assert against the same numbers --------------------------------------------------------------------------------------------


def test_09_node_and_python_share_both_ceilings():
    node_analysis_ceiling = int(re.search(r"AI_ANALYSIS_DEADLINE_CEILING_MS\s*=\s*([0-9_]+)", RUNTIME_CONFIG).group(1).replace("_", ""))
    node_provider_ceiling = int(re.search(r"AI_PROVIDER_TIMEOUT_CEILING_MS\s*=\s*([0-9_]+)", RUNTIME_CONFIG).group(1).replace("_", ""))
    assert node_analysis_ceiling == provider_policy.ANALYSIS_DEADLINE_CEILING_MS
    assert node_provider_ceiling == provider_policy.PROVIDER_TIMEOUT_CEILING_MS
