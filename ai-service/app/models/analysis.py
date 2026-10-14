"""
Response contract for POST /v1/intelligence/analyze - Intelligence V1.

The request reuses IntelligenceRequest (context, knowledge, authorizedLevel):
the same trusted, Node-assembled, visibility-filtered inputs as the existing
generate endpoint. This contract is deliberately small and closed:

    situation        what is happening, from the operational context only
    evidence         the specific supplied facts / knowledge the analysis rests on
    impact           the consequence, as far as the supplied facts support it
    recommendation   what documented guidance says to do - a recommendation only
    confidence       "high" | "medium" | "low" - an evidence-quality class, never a probability
    usedKnowledgeChunkIds  which supplied chunks the analysis actually relied on
    evidenceRefs     (Phase 28) structured, typed references the analysis cites - shape-checked
                     here, AUTHORIZED against the request's own context/operationalHistory/knowledge
                     only on the Node side (backend/src/services/ai/analysisSchema.js +
                     evidenceReferenceIndex.js). This module never decides authorization.
    contradictions   (Phase 28) bounded, typed contradictions, each citing >=2 of the references above

`extra="forbid"`: there is no field through which an action, a tool call, a
message, or any other business operation can be expressed. The service
recommends; it never executes.

Confidence stays the existing three-value CLASS, not a number: the system prompt explicitly forbids a
numeric or percentage confidence, and this is enforced structurally (`Literal["high","medium","low"]`) -
a float, NaN or Infinity fails typing before any range check could even run. See
backend/docs/PHASE28_EVIDENCE_HARDENING.md for why this was not changed to a numeric score.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models.intelligence import IntelligenceRequest, Provenance
from app.models.learning import LearningContext
from app.models.operational_history import OperationalHistory

ConfidenceLevel = Literal["high", "medium", "low"]

MAX_EVIDENCE_ITEMS = 12
MAX_TEXT_CHARS = 2000
MAX_EVIDENCE_CHARS = 1000
MAX_EVIDENCE_REFS = 20
MAX_CONTRADICTIONS = 5
MAX_CONTRADICTION_DESCRIPTION_CHARS = 300
MIN_CONTRADICTION_REFS = 2
MAX_CONTRADICTION_REFS = 6
MAX_REF_ID_CHARS = 64

# Phase 34C claim-level provenance. The model states WHAT KIND of claim each statement is and WHICH application-supplied
# references support it; the application (Node, backend/src/services/ai/claimValidator.js) decides whether that pairing is
# admissible. Nothing here is trusted: it is shape only.
ClaimType = Literal["FACT", "HISTORICAL_PATTERN", "BUSINESS_GUIDANCE", "LEARNING_OBSERVATION", "RECOMMENDATION"]
Urgency = Literal["immediate", "prompt", "routine"]
# The closed Action V1 vocabulary (backend/src/models/Action.js ACTION_TYPES, app/models/learning.py ActionType).
RecommendedActionType = Literal["maintenance_dispatch", "guest_communication", "escalation", "inspection", "other"]
MAX_CLAIMS = 12
MAX_CLAIM_TEXT_CHARS = 500
MAX_CLAIM_SOURCE_REFS = 8
MAX_SOURCE_REF_CHARS = 128

EvidenceType = Literal["operational", "historical", "knowledge"]
OperationalField = Literal["signal", "property", "unit", "guest", "stay", "historySignal"]
HistoricalKind = Literal["prior_ai_analysis", "human_reviewed_decision"]
ContradictionType = Literal[
    "signal_vs_historical", "operational_vs_historical", "knowledge_vs_operational", "historical_vs_historical"
]


def _non_blank(value: str) -> str:
    if not value.strip():
        raise ValueError("must not be blank")
    return value


class AnalysisRequest(IntelligenceRequest):
    """Phase 27: the Intelligence V1 request. Identical to IntelligenceRequest plus one OPTIONAL, closed,
    bounded field. Absent = the previous contract (backward compatible); present = the prompt uses the
    separated layout (operational context / signal input / operational history / business knowledge).

    Phase 32: `learning` is a SECOND, independently optional, closed, bounded field - Node's own
    KOI_LEARNING_CONTEXT_ENABLED flag decides whether it is ever sent (default off); this service does not
    decide that, it only accepts the field's shape when present. Absent (the default) = this request is
    byte-for-byte identical to the pre-Phase-32 contract."""

    operationalHistory: OperationalHistory | None = None
    learning: LearningContext | None = None


class EvidenceRef(BaseModel):
    """One typed, structural reference into data the backend already supplied. `extra="forbid"` plus the
    validator below mean a reference can ONLY carry exactly the fields its own `type` needs - never a mix,
    never an extra database-shaped field, never free text. This model checks SHAPE only; whether the
    identifier it names was actually supplied is a Node-side check (this service has no way to know, since
    it never queries anything itself)."""

    model_config = ConfigDict(extra="forbid")

    type: EvidenceType
    field: OperationalField | None = None
    refId: str | None = Field(default=None, max_length=MAX_REF_ID_CHARS)
    kind: HistoricalKind | None = None
    signalId: str | None = Field(default=None, max_length=MAX_REF_ID_CHARS)
    chunkId: str | None = Field(default=None, max_length=MAX_REF_ID_CHARS)

    @model_validator(mode="after")
    def _shape_matches_type(self) -> "EvidenceRef":
        if self.type == "operational":
            ok = self.field is not None and self.refId not in (None, "") and self.kind is None and self.signalId is None and self.chunkId is None
        elif self.type == "historical":
            ok = self.kind is not None and self.signalId not in (None, "") and self.field is None and self.refId is None and self.chunkId is None
        else:
            ok = self.chunkId not in (None, "") and self.field is None and self.refId is None and self.kind is None and self.signalId is None
        if not ok:
            raise ValueError(f'an evidence reference of type "{self.type}" must carry exactly its own fields, nothing else')
        return self


class Claim(BaseModel):
    """One claim the analysis makes, with the application-supplied references it rests on (Phase 34C). `extra="forbid"`:
    a claim carries exactly {claimType, text, sourceRefs}. The references are opaque strings the APPLICATION issued (see
    app/services/evidence_envelope.py); this model checks shape only - whether a reference exists, belongs to this
    request, and is of a class the claim type may rest on is decided by Node."""

    model_config = ConfigDict(extra="forbid")

    claimType: ClaimType
    text: str = Field(min_length=1, max_length=MAX_CLAIM_TEXT_CHARS)
    sourceRefs: list[str] = Field(min_length=1, max_length=MAX_CLAIM_SOURCE_REFS)

    _text_not_blank = field_validator("text")(_non_blank)

    @field_validator("sourceRefs")
    @classmethod
    def _refs_valid(cls, refs: list[str]) -> list[str]:
        for ref in refs:
            if not ref.strip() or len(ref) > MAX_SOURCE_REF_CHARS:
                raise ValueError("a source reference must be a non-blank string of bounded length")
        if len(set(refs)) != len(refs):
            raise ValueError("source references must not repeat within a claim")
        return refs


class Contradiction(BaseModel):
    """A candidate contradiction the analysis reports. It is itself untrusted model output - the LLM may
    identify it, but every one of its evidenceRefs is checked by Node exactly like a top-level reference
    before persistence (see analysisSchema.js). No free-form / unbounded contradiction shape is allowed."""

    model_config = ConfigDict(extra="forbid")

    type: ContradictionType
    description: str = Field(min_length=1, max_length=MAX_CONTRADICTION_DESCRIPTION_CHARS)
    evidenceRefs: list[EvidenceRef] = Field(min_length=MIN_CONTRADICTION_REFS, max_length=MAX_CONTRADICTION_REFS)

    _description_not_blank = field_validator("description")(_non_blank)


class AnalysisResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    situation: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    evidence: list[str] = Field(min_length=1, max_length=MAX_EVIDENCE_ITEMS)
    impact: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    recommendation: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    confidence: ConfidenceLevel
    usedKnowledgeChunkIds: list[str] = Field(default_factory=list)
    provenance: Provenance
    # Phase 28 - both OPTIONAL/additive: every pre-Phase-28 caller/fixture that omits them keeps validating.
    evidenceRefs: list[EvidenceRef] = Field(default_factory=list, max_length=MAX_EVIDENCE_REFS)
    contradictions: list[Contradiction] = Field(default_factory=list, max_length=MAX_CONTRADICTIONS)
    # Phase 34C - all three OPTIONAL/additive (a provider that omits them still validates here; Node REQUIRES them for the
    # real provider and checks every one - see backend/src/services/ai/{claimValidator,safetyPolicy}.js).
    claims: list[Claim] = Field(default_factory=list, max_length=MAX_CLAIMS)
    urgency: Urgency | None = None
    recommendedActionType: RecommendedActionType | None = None

    _situation_not_blank = field_validator("situation", "impact", "recommendation")(_non_blank)

    @field_validator("evidence")
    @classmethod
    def _evidence_items_valid(cls, items: list[str]) -> list[str]:
        for item in items:
            if not item.strip():
                raise ValueError("evidence items must not be blank")
            if len(item) > MAX_EVIDENCE_CHARS:
                raise ValueError(f"evidence items must be at most {MAX_EVIDENCE_CHARS} characters")
        return items
