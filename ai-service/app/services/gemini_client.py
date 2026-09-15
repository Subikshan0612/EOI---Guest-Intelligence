"""
Real Gemini invocation (Phase 5 Step 4).

Used only when this service's own LLM_PROVIDER=gemini (see
app/routers/intelligence.py and app/config.py — the default remains "test",
so a service with no configuration never reaches this module). Uses the
official `google-genai` Python SDK, mirroring the existing Node
implementation (backend/src/services/ai/llmProvider.js) call-for-call:
same structured-output mechanism, same no-retry policy, same timeout, same
"never trust the raw response until it's re-validated" discipline.

Never logs or returns the API key, the raw Gemini error object, its
message, or its response body — only a fixed, safe message and (server-side
only) the exception's type/status code.
"""

import json
import logging

from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import ValidationError

from app.config import settings
from app.exceptions import MalformedResponseError, ProviderError, ProviderNotConfiguredError
from app.models.context import SignalContext
from app.models.intelligence import IntelligenceResponse, KnowledgeItem, KnowledgeProvenanceItem, Provenance
from app.services.prompt_builder import build_intelligence_prompt

logger = logging.getLogger(__name__)

# Mirrors backend/src/services/ai/intelligenceSchema.js's INTELLIGENCE_JSON_SCHEMA,
# translated into Gemini's schema dialect (uppercase type names, no
# additionalProperties). Kept in sync by hand with the Pydantic
# IntelligenceResponse contract below and with Node's own schema — the same
# two-schemas-one-contract tradeoff Node already accepted for its
# OpenAI/Gemini schema pair.
GEMINI_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "summary": {"type": "STRING"},
        "findings": {"type": "ARRAY", "items": {"type": "STRING"}},
        "risk": {
            "type": "OBJECT",
            "properties": {
                "level": {"type": "STRING", "format": "enum", "enum": ["low", "medium", "high", "critical"]},
                "reason": {"type": "STRING"},
            },
            "required": ["level", "reason"],
        },
        "decision": {
            "type": "OBJECT",
            "properties": {
                "recommendation": {"type": "STRING"},
                "rationale": {"type": "STRING"},
            },
            "required": ["recommendation", "rationale"],
        },
        "action": {
            "type": "OBJECT",
            "properties": {
                "label": {"type": "STRING"},
                "recommended": {
                    "type": "ARRAY",
                    "items": {
                        "type": "OBJECT",
                        "properties": {
                            "step": {"type": "STRING"},
                            "priority": {"type": "STRING", "format": "enum", "enum": ["low", "medium", "high"]},
                        },
                        "required": ["step", "priority"],
                    },
                },
            },
            "required": ["label", "recommended"],
        },
        "outcome": {
            "type": "OBJECT",
            "properties": {"expected": {"type": "STRING"}},
            "required": ["expected"],
        },
        "confidence": {"type": "NUMBER"},
        # Phase 6H — the model's own claim of which supplied KnowledgeItems
        # it relied on, by chunkId. Never trusted as-is: generate_gemini_
        # intelligence() below intersects this against the KnowledgeItems
        # Node actually supplied before building knowledgeProvenance, so a
        # hallucinated or out-of-scope chunkId can never surface. Empty
        # array is valid and expected when no supplied knowledge was used.
        "usedKnowledgeChunkIds": {"type": "ARRAY", "items": {"type": "STRING"}},
    },
    "required": [
        "summary",
        "findings",
        "risk",
        "decision",
        "action",
        "outcome",
        "confidence",
        "usedKnowledgeChunkIds",
    ],
}


def _map_provider_error(exc: Exception) -> Exception:
    """Maps a google-genai SDK exception to a safe internal error. Never
    forwards exc.message/exc.details (Gemini's raw response body) — only
    exc.code/type are ever logged, server-side only."""
    code = getattr(exc, "code", None)
    logger.error("Gemini provider error: %s code=%s", type(exc).__name__, code)

    if code in (400, 401, 403, 404):
        return ProviderError("AI provider is not configured correctly.")
    if code == 429:
        return ProviderError("AI provider is currently rate-limited. Try again shortly.")
    return ProviderError()


def _build_knowledge_provenance(
    used_chunk_ids: object, supplied_knowledge: list[KnowledgeItem]
) -> list[KnowledgeProvenanceItem]:
    """
    Intersects the model's own claimed `usedKnowledgeChunkIds` against the
    KnowledgeItems Node actually supplied in this request. A chunkId the
    model invents, misremembers, or copies from outside this request
    simply has no matching supplied item and is dropped — the model cannot
    manufacture provenance for a document it wasn't given. Every surviving
    item's fields are copied from Node's own supplied KnowledgeItem, never
    from the model's output.
    """
    if not isinstance(used_chunk_ids, list):
        return []

    supplied_by_id = {item.chunkId: item for item in supplied_knowledge}
    provenance = []
    seen = set()
    for claimed_id in used_chunk_ids:
        if not isinstance(claimed_id, str) or claimed_id in seen:
            continue
        item = supplied_by_id.get(claimed_id)
        if item is None:
            continue
        seen.add(claimed_id)
        provenance.append(
            KnowledgeProvenanceItem(
                chunkId=item.chunkId,
                knowledgeDocumentId=item.knowledgeDocumentId,
                version=item.version,
                scope=item.scope,
                section=item.section,
                chunkIndex=item.chunkIndex,
                similarityScore=item.similarityScore,
                retrievalScore=item.retrievalScore,
            )
        )
    return provenance


def generate_gemini_intelligence(
    context: SignalContext, knowledge: list[KnowledgeItem] | None = None
) -> IntelligenceResponse:
    if not settings.gemini_api_key:
        raise ProviderNotConfiguredError()

    knowledge = knowledge or []
    system_prompt, user_prompt = build_intelligence_prompt(context, knowledge)

    # No retries (attempts=1) — matches Node's llmProvider.js exactly, to
    # avoid silently multiplying free-tier API usage on a transient error.
    client = genai.Client(
        api_key=settings.gemini_api_key,
        http_options=types.HttpOptions(
            timeout=settings.request_timeout_ms,
            retry_options=types.HttpRetryOptions(attempts=1),
        ),
    )

    try:
        response = client.models.generate_content(
            model=settings.llm_model,
            contents=user_prompt,
            config=types.GenerateContentConfig(
                system_instruction=system_prompt,
                response_mime_type="application/json",
                response_schema=GEMINI_RESPONSE_SCHEMA,
            ),
        )
    except genai_errors.APIError as exc:
        raise _map_provider_error(exc) from None
    except Exception as exc:  # noqa: BLE001 - last-resort safety net, never re-raised raw
        logger.error("Gemini provider error (unexpected): %s", type(exc).__name__)
        raise ProviderError() from None

    text = response.text
    if not text:
        raise MalformedResponseError("AI provider returned an empty response.")

    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        raise MalformedResponseError("AI provider returned a malformed response.") from None

    if not isinstance(raw, dict):
        raise MalformedResponseError("AI provider returned a malformed response.")

    try:
        return IntelligenceResponse(
            summary=raw.get("summary"),
            findings=raw.get("findings"),
            risk=raw.get("risk"),
            decision=raw.get("decision"),
            action=raw.get("action"),
            outcome=raw.get("outcome"),
            confidence=raw.get("confidence"),
            # Provenance is attached here, by the code that actually knows
            # which provider/model was called — never trusted from the
            # model's own JSON output.
            provenance=Provenance(provider="gemini", model=settings.llm_model),
            # Built by intersecting the model's claim against what Node
            # actually supplied — never trusted from the model's raw output
            # directly (see _build_knowledge_provenance's docstring).
            knowledgeProvenance=_build_knowledge_provenance(raw.get("usedKnowledgeChunkIds"), knowledge),
        )
    except ValidationError:
        raise MalformedResponseError(
            "AI provider returned a response that did not match the expected contract."
        ) from None
