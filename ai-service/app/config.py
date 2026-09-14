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

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    ai_service_port: int = 8000
    llm_provider: str = "test"
    llm_model: str = "gemini-3.6-flash"
    gemini_api_key: str = ""
    request_timeout_ms: int = 20000

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


settings = Settings()
