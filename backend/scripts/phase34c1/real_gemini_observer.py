"""
Phase 34C.1 test tooling - NOT production code, never imported by the application.

Starts the REAL ai-service app (app.main:app, unchanged) on a local port and wraps the single `generate_content` call of the
existing Gemini path with a passive observer. It is not a second Gemini client: the same SDK client object makes the same call
with the same arguments; the observer only RECORDS what went out and what came back, so a verification run can state the exact
model sent, the model_version the API reports, finish reason, token usage and latency.

What it records per call (JSON lines in P34C1_OBSERVER_LOG): the model argument, a few non-secret config fields, the prompt
(synthetic fixtures only), the SDK-level duration, the response's model_version / finish_reason / usage_metadata and the raw
response text. It NEVER records the API key or any client constructor argument, headers or environment.

It also writes one "startup" line stating the configured provider/model and whether the Phase 34A-B policy approves it, so the
harness can refuse to send anything unless the outbound model is exactly the approved one.
"""

import json
import os
import sys
import time

AI_SERVICE_ROOT = os.getcwd()
sys.path.insert(0, AI_SERVICE_ROOT)
LOG_PATH = os.environ["P34C1_OBSERVER_LOG"]
PORT = int(os.environ["P34C1_PORT"])


def write(record: dict) -> None:
    with open(LOG_PATH, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def enum_name(value):
    return getattr(value, "name", None) or (value if isinstance(value, str) else None)


from google import genai  # noqa: E402

_RealClient = genai.Client


class _ObservedModels:
    def __init__(self, real_models):
        self._real = real_models

    def generate_content(self, *args, **kwargs):
        config = kwargs.get("config")
        schema = getattr(config, "response_schema", None)
        record = {
            "kind": "call",
            "wallClock": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
            "modelArg": kwargs.get("model"),
            "config": {
                "maxOutputTokens": getattr(config, "max_output_tokens", None),
                "temperature": getattr(config, "temperature", None),
                "responseMimeType": getattr(config, "response_mime_type", None),
                "schemaRequired": schema.get("required") if isinstance(schema, dict) else None,
            },
            "promptChars": len(kwargs.get("contents") or ""),
            "prompt": kwargs.get("contents"),
        }
        started = time.perf_counter()
        try:
            response = self._real.generate_content(*args, **kwargs)
        except BaseException as exc:  # recorded, then re-raised unchanged for the production error mapping
            record.update(sdkMs=round((time.perf_counter() - started) * 1000), error={"type": type(exc).__name__, "code": getattr(exc, "code", None)})
            write(record)
            raise
        usage = getattr(response, "usage_metadata", None)
        candidates = getattr(response, "candidates", None) or []
        try:
            text = response.text
        except Exception:  # noqa: BLE001
            text = None
        record.update(
            sdkMs=round((time.perf_counter() - started) * 1000),
            modelVersion=getattr(response, "model_version", None),
            finishReason=enum_name(getattr(candidates[0], "finish_reason", None)) if candidates else None,
            promptBlockReason=enum_name(getattr(getattr(response, "prompt_feedback", None), "block_reason", None)),
            usage={
                "promptTokens": getattr(usage, "prompt_token_count", None),
                "candidateTokens": getattr(usage, "candidates_token_count", None),
                "totalTokens": getattr(usage, "total_token_count", None),
                "thoughtsTokens": getattr(usage, "thoughts_token_count", None),
            },
            text=text,
        )
        write(record)
        return response

    def __getattr__(self, name):
        return getattr(self._real, name)


class _ObservedClient:
    def __init__(self, *args, **kwargs):  # the constructor arguments (which include the key) are passed on, never stored
        self._client = _RealClient(*args, **kwargs)
        self.models = _ObservedModels(self._client.models)

    def __getattr__(self, name):
        return getattr(self._client, name)


genai.Client = _ObservedClient

from app.config import settings  # noqa: E402
from app.provider_policy import APPROVED_MODEL, APPROVED_PROVIDER, is_approved_model  # noqa: E402

write(
    {
        "kind": "startup",
        "configuredProvider": settings.llm_provider,
        "configuredModel": settings.llm_model,
        "approvedProvider": APPROVED_PROVIDER,
        "approvedModel": APPROVED_MODEL,
        "policyApprovesConfiguredModel": is_approved_model(settings.llm_model),
        "keyConfigured": bool(settings.gemini_api_key),  # a boolean only
        "requestTimeoutMs": settings.request_timeout_ms,
        "maxOutputTokens": settings.llm_max_output_tokens,
    }
)

import uvicorn  # noqa: E402
from app.main import app  # noqa: E402  (the unchanged production app; startup validation runs on import)

uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
