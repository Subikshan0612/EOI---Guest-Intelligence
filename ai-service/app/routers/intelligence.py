"""
POST /v1/intelligence/signal

Phase 5 Step 3: deterministic stub only. This never calls Gemini or any
other model — see app/services/deterministic_stub.py.
"""

from fastapi import APIRouter

from app.models.intelligence import IntelligenceRequest, IntelligenceResponse
from app.services.deterministic_stub import generate_deterministic_intelligence

router = APIRouter()


@router.post("/v1/intelligence/signal", response_model=IntelligenceResponse)
def post_intelligence_signal(payload: IntelligenceRequest) -> IntelligenceResponse:
    return generate_deterministic_intelligence(payload.context)
