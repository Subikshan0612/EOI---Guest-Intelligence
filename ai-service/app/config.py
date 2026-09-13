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


settings = Settings()
