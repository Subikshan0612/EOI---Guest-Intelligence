"""
Operational history contract (Phase 27) - the bounded, Node-prepared historical context that may accompany
an Intelligence V1 analysis request (POST /v1/intelligence/analyze).

Mirrors backend/src/services/operationalContextContract.js field for field. This service does not query for
any of it: Node already selected it inside the caller's workspace and visibility ceiling. What this module
adds is defence in depth - the shape is CLOSED (`extra="forbid"`), every list and string is bounded, and a
request that carries anything else (a database filter, a collection name, a workspace id, a reviewer
identity, an unbounded list) is rejected with a validation error before any prompt is built.

Everything here is DATA. The prompt (analysis_prompt.py) presents it as untrusted recorded material, never
as instructions.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

CONTRACT_VERSION = "operational-context-v1"
MAX_HISTORICAL_INTELLIGENCE = 3
MAX_HISTORICAL_DECISIONS = 3
MAX_HISTORY_TEXT = 400
MAX_ID = 64
MAX_ISO = 40

MatchedBy = list[Literal["stay", "guest", "unit"]]


class HistoricalIntelligence(BaseModel):
    """A PRIOR analysis of a related Signal. AI-generated, unverified, and never a statement of fact about
    the current Signal."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["prior_ai_analysis"]
    signalId: str = Field(min_length=1, max_length=MAX_ID)
    matchedBy: MatchedBy = Field(min_length=1, max_length=3)
    recordedAt: str | None = Field(default=None, max_length=MAX_ISO)
    situation: str = Field(min_length=1, max_length=MAX_HISTORY_TEXT)
    recommendation: str = Field(min_length=1, max_length=MAX_HISTORY_TEXT)
    confidence: Literal["high", "medium", "low"]


class HistoricalDecision(BaseModel):
    """A prior Decision a person approved or rejected. The status is a recorded fact; the description is
    the earlier AI recommendation's text."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["human_reviewed_decision"]
    signalId: str = Field(min_length=1, max_length=MAX_ID)
    matchedBy: MatchedBy = Field(min_length=1, max_length=3)
    status: Literal["approved", "rejected"]
    priority: Literal["low", "medium", "high", "critical"]
    description: str = Field(min_length=1, max_length=MAX_HISTORY_TEXT)
    reviewedAt: str | None = Field(default=None, max_length=MAX_ISO)


class OperationalHistory(BaseModel):
    model_config = ConfigDict(extra="forbid")

    contractVersion: Literal["operational-context-v1"]
    intelligence: list[HistoricalIntelligence] = Field(default_factory=list, max_length=MAX_HISTORICAL_INTELLIGENCE)
    decisions: list[HistoricalDecision] = Field(default_factory=list, max_length=MAX_HISTORICAL_DECISIONS)
