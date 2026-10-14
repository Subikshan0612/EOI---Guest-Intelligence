"""
POST /v1/intelligence/analyze - Intelligence V1.

Same trusted inputs as /v1/intelligence/signal (Node-assembled context, Node-
retrieved and Node-authorized knowledge, the authorizedLevel Node enforced),
a different, closed output contract (app/models/analysis.py). Provider
selection is this service's own LLM_PROVIDER, exactly like the existing
endpoint: "test" -> deterministic analysis (no network call), "gemini" ->
the real provider, anything else -> PROVIDER_NOT_CONFIGURED. It is never
client-controllable and never hard-codes a provider.

Defence in depth: knowledge above the request's authorizedLevel is dropped
before any prompt is built. Node has already filtered; this only guards
against a Node bug. This router makes no MongoDB query and no retrieval
decision, and it executes nothing - it returns an analysis.
"""

from fastapi import APIRouter, Request

from app.config import settings
from app.provider_observability import CORRELATION_HEADER
from app.exceptions import ProviderNotConfiguredError
from app.models.analysis import AnalysisRequest, AnalysisResponse
from app.models.visibility import is_visible
from app.services.deterministic_analysis import generate_deterministic_analysis
from app.services.gemini_analysis_client import generate_gemini_analysis

router = APIRouter()


@router.post("/v1/intelligence/analyze", response_model=AnalysisResponse)
def post_intelligence_analyze(payload: AnalysisRequest, request: Request) -> AnalysisResponse:
    provider = settings.llm_provider.strip().lower()
    knowledge = [item for item in payload.knowledge if is_visible(item.visibility, payload.authorizedLevel)]

    # Phase 27: the history is passed only when the request carries it, so a request without it takes exactly
    # the pre-Phase-27 call shape. Phase 32: `learning` is passed through the same way, independently.
    extra = {} if payload.operationalHistory is None else {"operational_history": payload.operationalHistory}
    if payload.learning is not None:
        extra["learning_context"] = payload.learning

    if provider == "test":
        return generate_deterministic_analysis(payload.context, knowledge, **extra)

    if provider == "gemini":
        # Observability only: the correlation id Node sent (validated and, if absent or malformed, replaced inside the client); never a decision input.
        return generate_gemini_analysis(payload.context, knowledge, correlation_id=request.headers.get(CORRELATION_HEADER), **extra)

    raise ProviderNotConfiguredError()
