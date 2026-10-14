"""
Configuration for the KOI AI service.

Phase 5 Step 4: `llm_provider` now actually selects behavior (see
app/routers/intelligence.py) — "test" runs the deterministic stub, "gemini"
calls the real Gemini API. The default is deliberately "test", not "gemini":
with no ai-service/.env present at all, this service must never attempt a
real network call. Real generation is opt-in only, exactly like Node's own
LLM_PROVIDER has no implicit fallback to a real provider.

All values are read from environment variables (optionally via a local
.env file, never committed). Starting the service must never require a real
API key — GEMINI_API_KEY is intentionally optional here.
"""

import os

from pydantic_settings import BaseSettings, SettingsConfigDict

from app.provider_policy import APPROVED_MODEL


class Settings(BaseSettings):
    # ai-service/.env is the ONE runtime file. A validation run (the Node suites set KOI_NO_DOTENV=1 for themselves and the services they spawn; the pytest conftest does the
    # same) must never pick up its real settings (the Gemini key, the service token), so the file is simply not read then.
    model_config = SettingsConfigDict(env_file=None if os.environ.get("KOI_NO_DOTENV") == "1" else ".env", env_file_encoding="utf-8", extra="ignore")

    ai_service_port: int = 8000
    llm_provider: str = "test"
    # Phase 34A-B: the default is the APPROVED production model (app/provider_policy.py), never an older one. With
    # LLM_PROVIDER=gemini any other value makes the service refuse to start and every Gemini call fail closed.
    llm_model: str = APPROVED_MODEL
    gemini_api_key: str = ""
    # Provider call timeout. Node's analysis timeout is deliberately LONGER (backend runtimeConfig.getAiAnalysisTimeoutMs)
    # so this service reports a provider timeout itself instead of Node cutting the call off first.
    request_timeout_ms: int = 20000
    # Workstream 5C: the deadline of the Gemini ANALYSIS call, separate from request_timeout_ms (which keeps bounding embedding and the legacy generate path at <= 20 s).
    # Bounded by provider_policy.ANALYSIS_DEADLINE_CEILING_MS; Node's analysis wait (KOI_AI_ANALYSIS_TIMEOUT_MS) must exceed the ceiling, and Node's browser-facing response
    # window (about 25 s) is independent of it (the hybrid 202 / status architecture lets the attempt continue after the window).
    # PROVISIONAL default 60 s = the ceiling (Workstream 5C: no observed completion is truncated; the evidence does not discriminate 30 / 45 / 60 s - see the 5C report).
    llm_analysis_timeout_ms: int = 60000
    # Upper bound on generated tokens for one analysis. The structured analysis observed in the Phase 33-Lite run used at
    # most ~390 output tokens (no separate thinking tokens: total = prompt + candidates), so 4096 leaves >10x headroom
    # while still bounding a runaway generation. A response cut off by this limit is rejected as malformed, never used.
    llm_max_output_tokens: int = 4096

    # Phase 6E — independent of llm_provider/llm_model above: embeddings and
    # intelligence generation are two separate concerns that happen to share
    # the same Gemini API key. "test" (deterministic, no network call) is the
    # default for the exact same reason llm_provider defaults to "test".
    embedding_provider: str = "test"
    embedding_model: str = "gemini-embedding-001"
    # Conservative initial value (Phase 6A report style): small enough to
    # keep one provider request fast and well within payload limits, large
    # enough that a typical SOP's chunk set fits in one or two batches.
    embedding_batch_size: int = 20

    # Phase 6F — the /v1/vector-similarity primitive. Independent of
    # embedding_batch_size above (a different concern: how many candidates
    # one similarity request may score in memory, not how many texts one
    # embedding request may embed). A request over this limit is rejected
    # outright, never silently truncated. Conservative starting point:
    # bounded by a document's own chunk count for now, well within what
    # pure-Python in-memory scoring handles instantly.
    similarity_max_candidates: int = 200

    # Phase 51 - OPTIONAL service-to-service credential. When set, every endpoint except /v1/health requires the matching X-KOI-Service-Token header (the Node backend
    # sends it from its own AI_SERVICE_TOKEN), and the interactive docs / OpenAPI schema are not served. It exists so the service is not an open door for anyone who can
    # reach it when the hosting platform offers no private network. Empty (the default) keeps the previous behaviour: isolation is then a network rule.
    ai_service_token: str = ""


if os.environ.get("KOI_NO_DOTENV") == "1" and os.environ.get("KOI_NO_DOTENV_REASON") != "validation":
    # Set automatically (with KOI_NO_DOTENV_REASON=validation) for test runs; anywhere else it means ai-service/.env was NOT read.
    import sys

    print("[KOI AI] KOI_NO_DOTENV is set but this is not a validation run: ai-service/.env was NOT loaded; only the process environment configures this service.", file=sys.stderr)

settings = Settings()
