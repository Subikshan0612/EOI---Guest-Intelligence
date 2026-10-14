"""
Test-provider isolation (Phase 21).

A local ai-service/.env may configure REAL providers (and a real API key), and pydantic-settings lets that file supply values the
process environment does not. This conftest runs BEFORE any test module imports the app, so it:

  1. forces the deterministic test providers and an EMPTY API key in the process environment (which takes precedence over .env);
  2. installs a network guard: any attempt to open a socket to a NON-loopback address fails the test immediately and is recorded,
     so even a test that (mis)configures a real provider can never reach Gemini or any external API;
  3. asserts at session start and session end that the providers are still "test" and that no external connection was attempted.

Nothing here prints or stores a key.
"""

import os
import socket

os.environ["LLM_PROVIDER"] = "test"
os.environ["EMBEDDING_PROVIDER"] = "test"
os.environ["GEMINI_API_KEY"] = ""
# The real runtime file (ai-service/.env) also holds the service credential (AI_SERVICE_TOKEN): tests run without it (test_service_token.py turns it on explicitly), and the file is not read at all.
os.environ["AI_SERVICE_TOKEN"] = ""
os.environ["KOI_NO_DOTENV"] = "1"
os.environ["KOI_NO_DOTENV_REASON"] = "validation"
# Phase 34A-B: a local ai-service/.env may name another model (it still says gemini-3.6-flash in places). The process
# environment outranks it, so the suite always runs against the approved production model; the policy tests below set
# unapproved models explicitly. The literal is deliberate: if the approved id ever changes this must change with it.
os.environ["LLM_MODEL"] = "gemini-3.1-flash-lite"

import pytest  # noqa: E402

_LOOPBACK = {"127.0.0.1", "::1", "localhost", "0.0.0.0", ""}
_external_attempts: list[str] = []
_real_connect = socket.socket.connect
_real_connect_ex = socket.socket.connect_ex


def _host_of(address) -> str:
    return str(address[0]) if isinstance(address, tuple) and address else str(address)


def _guard(real):
    def guarded(self, address):
        host = _host_of(address)
        if self.family in (socket.AF_INET, socket.AF_INET6) and host not in _LOOPBACK and not host.startswith("127."):
            _external_attempts.append(host)
            raise RuntimeError(f"test network guard: connection to a non-loopback host ({host}) is forbidden in tests")
        return real(self, address)

    return guarded


socket.socket.connect = _guard(_real_connect)
socket.socket.connect_ex = _guard(_real_connect_ex)


def pytest_sessionstart(session):
    from app.config import settings

    assert settings.llm_provider == "test", "tests must run with LLM_PROVIDER=test"
    assert settings.embedding_provider == "test", "tests must run with EMBEDDING_PROVIDER=test"
    assert settings.gemini_api_key == "", "tests must run with an empty GEMINI_API_KEY"


def pytest_sessionfinish(session, exitstatus):
    assert not _external_attempts, f"external network connection attempted during tests: {_external_attempts}"


@pytest.fixture(autouse=True)
def _no_external_network():
    before = len(_external_attempts)
    yield
    assert len(_external_attempts) == before, "a test attempted an external network connection"
