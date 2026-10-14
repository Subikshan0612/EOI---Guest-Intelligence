"""
Real-provider branch of Intelligence V1 (POST /v1/intelligence/analyze).

Used only when this service's own LLM_PROVIDER=gemini. It reuses the SAME
provider plumbing, timeout, no-retry policy, and safe error mapping as the
existing generate path (app/services/gemini_client.py) - it is not a second
provider integration, only a second prompt and response schema on the same
one. The default provider stays "test", so an unconfigured service never
reaches this module, and no real generation is enabled by adding it.

Trust discipline (same as the existing path):
  - only the WHITELISTED keys of the model's JSON are ever read; any extra
    key the model emits (an "action", a "sendMessage", anything) is ignored,
    never passed on, so the response cannot carry an operation;
  - `usedKnowledgeChunkIds` is intersected with the chunks Node actually
    supplied - an id the model invents is dropped;
  - (Phase 28) `evidenceRefs` / `contradictions` are filtered the same way, using
    evidence_reference_index.py built from this SAME request's context/
    operationalHistory/knowledge - a malformed or unauthorized reference is
    dropped, never passed on. This is defense in depth only: Node's own
    check (analysisSchema.js) is the authoritative, fail-closed one and does
    not trust that this filtering ran;
  - provenance (provider/model) is attached here, never taken from the model. (Phase 34A-B) It comes from the APPROVED
    provider policy (app/provider_policy.py), not from a free-form setting: the configured model must equal the approved
    model BEFORE any request is made, and the model version the API reports on the response (when it reports one) must
    match too, otherwise the response is discarded. Where the API reports no version the provenance is
    configuration-backed, not a server-side attestation.
"""

import json
import os
import time

from google import genai
from google.genai import types
from pydantic import ValidationError

from app import provider_observability as obs
from app.config import settings
from app.exceptions import MalformedResponseError, ProviderNotConfiguredError
from app.models.analysis import (
    MAX_CONTRADICTION_REFS,
    MAX_CONTRADICTIONS,
    MAX_EVIDENCE_REFS,
    MIN_CONTRADICTION_REFS,
    AnalysisResponse,
    Contradiction,
    EvidenceRef,
)
from app.models.context import SignalContext
from app.models.intelligence import KnowledgeItem, Provenance
from app.models.learning import LearningContext
from app.models.operational_history import OperationalHistory
from app.services.analysis_prompt import build_analysis_prompt
from app.provider_policy import APPROVED_PROVIDER, require_approved_gemini_model, require_bounded_analysis_deadline, resolve_observed_model
from app.services.evidence_reference_index import EvidenceReferenceIndex
from app.services.provider_errors import claim_rule_from_validation_error, classify_unusable_response, map_provider_exception

# Evidence reference / contradiction fields are intentionally an OBJECT with every field OPTIONAL: Gemini's
# structured-output schema has no true tagged-union support, so the per-type "exactly these fields" rule is
# enforced afterwards by EvidenceRef's own validator (a malformed combination is simply dropped below, the
# same "ignore, never pass on" trust discipline as every other raw model field here).
_EVIDENCE_REF_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "type": {"type": "STRING", "format": "enum", "enum": ["operational", "historical", "knowledge"]},
        "field": {"type": "STRING", "format": "enum", "enum": ["signal", "property", "unit", "guest", "stay", "historySignal"]},
        "refId": {"type": "STRING"},
        "kind": {"type": "STRING", "format": "enum", "enum": ["prior_ai_analysis", "human_reviewed_decision"]},
        "signalId": {"type": "STRING"},
        "chunkId": {"type": "STRING"},
    },
}
# Phase 34C: a claim is {claimType, text, sourceRefs}. The references are opaque strings the application issued and listed in
# the prompt ("Citable refs"); the model never invents them, and Node rejects any it does not recognize.
_CLAIM_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "claimType": {
            "type": "STRING",
            "format": "enum",
            "enum": ["FACT", "HISTORICAL_PATTERN", "BUSINESS_GUIDANCE", "LEARNING_OBSERVATION", "RECOMMENDATION"],
        },
        "text": {"type": "STRING"},
        "sourceRefs": {"type": "ARRAY", "items": {"type": "STRING"}},
    },
    "required": ["claimType", "text", "sourceRefs"],
}
GEMINI_ANALYSIS_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "situation": {"type": "STRING"},
        "evidence": {"type": "ARRAY", "items": {"type": "STRING"}},
        "impact": {"type": "STRING"},
        "recommendation": {"type": "STRING"},
        "confidence": {"type": "STRING", "format": "enum", "enum": ["high", "medium", "low"]},
        "usedKnowledgeChunkIds": {"type": "ARRAY", "items": {"type": "STRING"}},
        "claims": {"type": "ARRAY", "items": _CLAIM_SCHEMA},
        "urgency": {"type": "STRING", "format": "enum", "enum": ["immediate", "prompt", "routine"]},
        "recommendedActionType": {
            "type": "STRING",
            "format": "enum",
            "enum": ["maintenance_dispatch", "guest_communication", "escalation", "inspection", "other"],
        },
        "evidenceRefs": {"type": "ARRAY", "items": _EVIDENCE_REF_SCHEMA},
        "contradictions": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "type": {
                        "type": "STRING",
                        "format": "enum",
                        "enum": ["signal_vs_historical", "operational_vs_historical", "knowledge_vs_operational", "historical_vs_historical"],
                    },
                    "description": {"type": "STRING"},
                    "evidenceRefs": {"type": "ARRAY", "items": _EVIDENCE_REF_SCHEMA},
                },
                "required": ["type", "description", "evidenceRefs"],
            },
        },
    },
    "required": [
        "situation", "evidence", "impact", "recommendation", "confidence", "usedKnowledgeChunkIds",
        "claims", "urgency", "recommendedActionType",
    ],
}


def _supplied_ids_only(claimed: object, supplied: list[KnowledgeItem]) -> list[str]:
    if not isinstance(claimed, list):
        return []
    supplied_ids = {item.chunkId for item in supplied}
    kept: list[str] = []
    for claimed_id in claimed:
        if isinstance(claimed_id, str) and claimed_id in supplied_ids and claimed_id not in kept:
            kept.append(claimed_id)
    return kept


def _authorized_evidence_refs(claimed: object, index: EvidenceReferenceIndex, limit: int) -> list[EvidenceRef]:
    """Defense in depth only (Node is the authoritative, fail-closed check): a reference that is malformed or
    not present in the supplied context/operationalHistory/knowledge is dropped here, never passed on, the
    same trust discipline this file already applies to `usedKnowledgeChunkIds`."""
    if not isinstance(claimed, list):
        return []
    kept: list[EvidenceRef] = []
    for item in claimed:
        if not isinstance(item, dict) or len(kept) >= limit:
            continue
        try:
            ref = EvidenceRef(**item)
        except ValidationError:
            continue
        if index.authorizes(ref):
            kept.append(ref)
    return kept


def _authorized_contradictions(claimed: object, index: EvidenceReferenceIndex) -> list[Contradiction]:
    if not isinstance(claimed, list):
        return []
    kept: list[Contradiction] = []
    for item in claimed:
        if not isinstance(item, dict) or len(kept) >= MAX_CONTRADICTIONS:
            continue
        refs = _authorized_evidence_refs(item.get("evidenceRefs"), index, MAX_CONTRADICTION_REFS)
        if len(refs) < MIN_CONTRADICTION_REFS:
            continue  # too few of its references survived filtering to remain a well-formed contradiction
        try:
            kept.append(Contradiction(type=item.get("type"), description=item.get("description"), evidenceRefs=refs))
        except ValidationError:
            continue
    return kept


_sleep = time.sleep  # indirection so the retry delay is testable without waiting


def _call_gemini_with_one_503_retry(client, *, model, contents, config, correlation_id: str, correlation_source: str):
    """
    The ONE place the analysis path calls the provider. At most two attempts, and the second happens only for a provider HTTP 503 that
    answered quickly (provider_observability.decide_retry: pure, deterministic). Every other failure - 504, a client-side timeout, any
    other status, a transport error, an unexpected exception - is classified and raised exactly as before, on the first attempt, with no retry.
    The SDK's own retry stays disabled (HttpRetryOptions(attempts=1) on the client), so there is exactly one retry layer and its bound is the
    constant MAX_PROVIDER_ATTEMPTS. Each attempt writes one safe structured event (no prompt, output, Signal text, header or key).
    """
    started = time.monotonic()
    attempt = 0
    while True:
        attempt += 1
        attempt_started = time.monotonic()
        try:
            response = client.models.generate_content(model=model, contents=contents, config=config)
        except Exception as exc:  # noqa: BLE001 - classified into the provider taxonomy, never re-raised raw
            elapsed_ms = (time.monotonic() - attempt_started) * 1000
            failure = obs.classify_provider_exception(exc)
            decision = obs.decide_retry(failure, attempt, elapsed_ms)
            obs.emit_event(
                "provider.attempt", correlationId=correlation_id, correlationSource=correlation_source, provider=APPROVED_PROVIDER, model=model, attempt=attempt,
                maxAttempts=obs.MAX_PROVIDER_ATTEMPTS, outcome="failure", category=failure.category, httpStatus=failure.http_status,
                providerStatus=failure.provider_status, exceptionClass=failure.exception_class, durationMs=elapsed_ms, retryDecision=decision.reason,
                retryDelayMs=decision.delay_seconds * 1000 if decision.retry else None, providerMessage=failure.message,
            )
            if decision.retry:
                _sleep(decision.delay_seconds)
                continue
            mapped = map_provider_exception(exc)
            obs.emit_event(
                "provider.analysis_final", correlationId=correlation_id, provider=APPROVED_PROVIDER, model=model, attempts=attempt, retried=attempt > 1,
                finalOutcome="failure", finalCategory=failure.category, finalTaxonomy=getattr(mapped, "taxonomy", None),
                totalDurationMs=(time.monotonic() - started) * 1000,
            )
            raise mapped from None
        elapsed_ms = (time.monotonic() - attempt_started) * 1000
        obs.emit_event(
            "provider.attempt", correlationId=correlation_id, correlationSource=correlation_source, provider=APPROVED_PROVIDER, model=model, attempt=attempt,
            maxAttempts=obs.MAX_PROVIDER_ATTEMPTS, outcome="success", durationMs=elapsed_ms, retryDecision="none",
        )
        obs.emit_event(
            "provider.analysis_final", correlationId=correlation_id, provider=APPROVED_PROVIDER, model=model, attempts=attempt, retried=attempt > 1,
            finalOutcome="success", totalDurationMs=(time.monotonic() - started) * 1000,
        )
        return response


def generate_gemini_analysis(
    context: SignalContext,
    knowledge: list[KnowledgeItem] | None = None,
    operational_history: OperationalHistory | None = None,
    learning_context: LearningContext | None = None,
    correlation_id: str | None = None,
) -> AnalysisResponse:
    # Phase 34A-B: the model policy comes first. An unapproved model never reaches a request, and never "falls back".
    model = require_approved_gemini_model(settings.llm_model)
    # Phase 35.1 / Workstream 5C: and the ANALYSIS deadline (its own setting, not the 20 s embedding/retrieval timeout) must be inside the cross-service
    # contract (checked again here: `settings` is mutable).
    provider_timeout_ms = require_bounded_analysis_deadline(settings.llm_analysis_timeout_ms)
    if not settings.gemini_api_key:
        raise ProviderNotConfiguredError()

    knowledge = knowledge or []
    # Observability only: the id the Node backend sent (a canonical uuid) or a fresh random one; it is never an input to any decision.
    correlation_id, correlation_source = obs.resolve_correlation_id(correlation_id)
    # Phase 32: GEMINI_ANALYSIS_SCHEMA below is UNCHANGED by `learning_context` - there is no output field for
    # it, so the model is structurally unable to return a Learning-related value even if it tried.
    system_prompt, user_prompt = build_analysis_prompt(context, knowledge, operational_history, learning_context)

    client = genai.Client(
        api_key=settings.gemini_api_key,
        http_options=types.HttpOptions(
            timeout=provider_timeout_ms,
            retry_options=types.HttpRetryOptions(attempts=1),
        ),
    )

    response = _call_gemini_with_one_503_retry(
        client,
        model=model,
        contents=user_prompt,
        config=types.GenerateContentConfig(
            system_instruction=system_prompt,
            response_mime_type="application/json",
            response_schema=GEMINI_ANALYSIS_SCHEMA,
            max_output_tokens=settings.llm_max_output_tokens,
        ),
        correlation_id=correlation_id,
        correlation_source=correlation_source,
    )

    # Phase 33 (evaluation-only): surfaces real token usage for the real-model evaluation harness ONLY - never
    # in the public response contract (AnalysisResponse has no usage field and never will), and silent unless
    # the harness explicitly opts in via PHASE33_LOG_USAGE=true in its own spawned process environment. Normal
    # application traffic never sets this and never prints anything here.
    if os.environ.get("PHASE33_LOG_USAGE") == "true":
        usage = getattr(response, "usage_metadata", None)
        if usage is not None:
            print(
                f"[PHASE33_USAGE] prompt={getattr(usage, 'prompt_token_count', None)} "
                f"candidates={getattr(usage, 'candidates_token_count', None)} "
                f"total={getattr(usage, 'total_token_count', None)}",
                flush=True,
            )

    # Phase 34A-B: identity first (a response from another model is never read), then "why is there no usable text"
    # (a blocked/withheld/truncated response is reported as exactly that), then the contract checks below.
    resolve_observed_model(getattr(response, "model_version", None))
    unusable = classify_unusable_response(response)
    if unusable is not None:
        raise unusable

    text = response.text
    if not text:
        raise MalformedResponseError("AI provider returned an empty response.")
    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        raise MalformedResponseError("AI provider returned a malformed response.") from None
    if not isinstance(raw, dict):
        raise MalformedResponseError("AI provider returned a malformed response.")

    index = EvidenceReferenceIndex(context, operational_history, [item.chunkId for item in knowledge])
    try:
        return AnalysisResponse(
            situation=raw.get("situation"),
            evidence=raw.get("evidence"),
            impact=raw.get("impact"),
            recommendation=raw.get("recommendation"),
            confidence=raw.get("confidence"),
            usedKnowledgeChunkIds=_supplied_ids_only(raw.get("usedKnowledgeChunkIds"), knowledge),
            provenance=Provenance(provider=APPROVED_PROVIDER, model=model),
            evidenceRefs=_authorized_evidence_refs(raw.get("evidenceRefs"), index, MAX_EVIDENCE_REFS),
            contradictions=_authorized_contradictions(raw.get("contradictions"), index),
            # Phase 34C: shape only here (a malformed claim, urgency or action type rejects the whole response as
            # malformed - nothing is silently dropped). Whether each claim is ADMISSIBLE is Node's decision.
            claims=raw.get("claims") or [],
            urgency=raw.get("urgency"),
            recommendedActionType=raw.get("recommendedActionType"),
        )
    except ValidationError as exc:
        # Phase 38: the response is still rejected whole; the error now also names WHICH structural rule failed (a stable constant derived from the
        # error location only - e.g. a claim without source references), so the sourceless-claim case is diagnosable without any model text.
        raise MalformedResponseError(
            "AI provider returned a response that did not match the expected contract.", rule=claim_rule_from_validation_error(exc)
        ) from None
