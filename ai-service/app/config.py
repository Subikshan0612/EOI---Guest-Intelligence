"""
Configuration for the KOI AI service.

Phase 5 scope: this only defines the settings the service needs to exist and
report its own health. Nothing here calls Gemini or any other provider yet —
see README.md for what this service does and does not own at this step.

All values are read from environment variables (optionally via a local
.env file, never committed). Starting the service must never require a real
API key — GEMINI_API_KEY is intentionally optional here.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    ai_service_port: int = 8000
    llm_provider: str = "gemini"
    llm_model: str = "gemini-3.6-flash"
    gemini_api_key: str = ""
    request_timeout_ms: int = 20000


settings = Settings()
