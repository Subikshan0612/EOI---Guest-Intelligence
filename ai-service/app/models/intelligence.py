"""
Request/response contract for POST /v1/intelligence/signal.

The response shape mirrors KOI's existing structured intelligence contract
(backend/src/services/ai/intelligenceSchema.js) field-for-field — this is a
deliberate shared contract, not a parallel one. Node re-validates every
field on its own side after receiving this response; Python's validation
here does not replace that boundary.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.models.context import SignalContext

RiskLevel = Literal["low", "medium", "high", "critical"]
ActionPriority = Literal["low", "medium", "high"]


class IntelligenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    context: SignalContext


class Risk(BaseModel):
    model_config = ConfigDict(extra="forbid")

    level: RiskLevel
    reason: str


class Decision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    recommendation: str
    rationale: str


class ActionStep(BaseModel):
    model_config = ConfigDict(extra="forbid")

    step: str
    priority: ActionPriority


class Action(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str
    recommended: list[ActionStep] = Field(default_factory=list)


class Outcome(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected: str


class Provenance(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str
    model: str


class IntelligenceResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str
    findings: list[str] = Field(default_factory=list)
    risk: Risk
    decision: Decision
    action: Action
    outcome: Outcome
    confidence: float = Field(ge=0.0, le=1.0)
    provenance: Provenance
