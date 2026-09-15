"""
Request/response contract for POST /v1/intelligence/signal.

The response shape mirrors KOI's existing structured intelligence contract
(backend/src/services/ai/intelligenceSchema.js) field-for-field — this is a
deliberate shared contract, not a parallel one. Node re-validates every
field on its own side after receiving this response; Python's validation
here does not replace that boundary.

Phase 6H adds `knowledge` to the request and `knowledgeProvenance` to the
response — both optional, both defaulting to an empty list, so every
existing caller/fixture that sends/expects neither keeps working exactly
as before (see ai-service/tests/test_intelligence.py's VALID_REQUEST/
VALID_RESPONSE_DICT, unmodified). `KnowledgeItem` reuses the Phase 6G
`KnowledgeScope` literal rather than redefining it.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.models.context import SignalContext
from app.models.retrieval import KnowledgeScope

RiskLevel = Literal["low", "medium", "high", "critical"]
ActionPriority = Literal["low", "medium", "high"]


class KnowledgeItem(BaseModel):
    """
    One piece of already-retrieved, already-tenant-verified organizational
    knowledge, supplied by Node for grounding — the exact same shape Phase
    6G's retrieval result already carries, plus the chunk's own `text`
    (which the standalone retrieval endpoint doesn't need to return, but
    prompt construction does). Python never queries for this text itself.
    """

    model_config = ConfigDict(extra="forbid")

    chunkId: str = Field(min_length=1)
    knowledgeDocumentId: str = Field(min_length=1)
    version: int = Field(ge=1)
    scope: KnowledgeScope
    section: str = ""
    chunkIndex: int = Field(ge=0)
    text: str = Field(min_length=1)
    similarityScore: float
    retrievalScore: float


class IntelligenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    context: SignalContext
    # Optional and empty by default — the "no relevant knowledge" case
    # (Phase 6G returned zero results, or knowledge retrieval was never
    # run) must remain fully supported, not treated as a degraded request.
    knowledge: list[KnowledgeItem] = Field(default_factory=list)


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


class KnowledgeProvenanceItem(BaseModel):
    """
    One knowledge chunk that materially influenced this result — built by
    intersecting the model's own claimed usage against the `KnowledgeItem`s
    Node actually supplied in the request (see generate_gemini_intelligence
    and generate_deterministic_intelligence). Every field here is copied
    from Node's own supplied KnowledgeItem, never from the model's output —
    the model can only "vote" on which chunkId it used, it cannot supply
    its own document metadata.
    """

    model_config = ConfigDict(extra="forbid")

    chunkId: str
    knowledgeDocumentId: str
    version: int
    scope: KnowledgeScope
    section: str
    chunkIndex: int
    similarityScore: float
    retrievalScore: float


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
    # Optional, empty by default — every existing caller/fixture that
    # expects a response without this field keeps validating unchanged.
    knowledgeProvenance: list[KnowledgeProvenanceItem] = Field(default_factory=list)
