"""
POST /v1/intelligence/signal

Phase 5 Step 4: this service's own LLM_PROVIDER (server-side config, never
client-controllable — the request contract has no provider field) decides
what actually generates the response:
  - "test"   (default) -> deterministic stub, no network call.
  - "gemini"            -> real Gemini call.
  - anything else       -> PROVIDER_NOT_CONFIGURED.

This mirrors the exact same server-side-only provider selection principle
already established on the Node side (backend/src/services/ai/
llmProvider.js's readConfig()).

Phase 6H: `payload.knowledge` (optional, empty by default) carries already-
retrieved, already-tenant-verified organizational knowledge from Node's
Phase 6G retrieval pipeline — passed straight through to whichever
provider function runs. This router makes no MongoDB query and no
retrieval decision of its own; it only routes.
"""

from fastapi import APIRouter

from app.config import settings
from app.exceptions import ProviderNotConfiguredError
from app.models.intelligence import IntelligenceRequest, IntelligenceResponse
from app.models.visibility import is_visible
from app.services.deterministic_stub import generate_deterministic_intelligence
from app.services.gemini_client import generate_gemini_intelligence

router = APIRouter()


@router.post("/v1/intelligence/signal", response_model=IntelligenceResponse)
def post_intelligence_signal(payload: IntelligenceRequest) -> IntelligenceResponse:
    provider = settings.llm_provider.strip().lower()

    # Defence in depth: Node has already removed knowledge above the caller's
    # level. Anything still above it is dropped here, before any prompt is
    # built, so it can never reach a provider or appear in provenance.
    knowledge = [item for item in payload.knowledge if is_visible(item.visibility, payload.authorizedLevel)]

    if provider == "test":
        return generate_deterministic_intelligence(payload.context, knowledge)

    if provider == "gemini":
        return generate_gemini_intelligence(payload.context, knowledge)

    raise ProviderNotConfiguredError()
