"""
Learning context contract (Phase 32) - the bounded, Node-prepared historical AGGREGATE that may accompany an
Intelligence V1 analysis request (POST /v1/intelligence/analyze), mirroring app/models/operational_history.py
field for field.

This service does not query for any of it: Node already derived it from trusted Outcome V1 records inside
the caller's workspace (backend/src/services/learningContextService.js, itself built only on top of Phase
31's own read-only Outcome-derived aggregate service). What this module adds is defence in depth - the shape is CLOSED
(`extra="forbid"`), every list is bounded to the small closed action-type set, every count is a non-negative
integer, and `successRate` is either null or a plain float in [0, 1] - never a string, never anything that
could be mistaken for a free-text field. There is no id, no timestamp and no free text anywhere in this
model: a Learning pattern is pure aggregate statistics, so there is nothing here an injected string could
carry, by construction (see backend/docs/LEARNING_INTELLIGENCE_PHASE32.md §15 for the full poisoning-defense
argument).

Everything here is DATA, and the prompt (analysis_prompt.py) presents it as a labelled historical aggregate
that is explicitly NOT evidence about the current Signal and NOT an instruction.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

CONTRACT_VERSION = "learning-v1"
MAX_PATTERNS = 5  # exactly Phase 29's closed ACTION_TYPES enum size - see learningContextService.js

ActionType = Literal["maintenance_dispatch", "guest_communication", "escalation", "inspection", "other"]


class LearningPattern(BaseModel):
    """One action type's historical success/failure aggregate, computed by Node from trusted Outcome V1
    records (Phase 31). Never a prediction, never an instruction, never evidence about the current Signal."""

    model_config = ConfigDict(extra="forbid")

    actionType: ActionType
    sampleSize: int = Field(ge=0)
    successCount: int = Field(ge=0)
    failedCount: int = Field(ge=0)
    partialCount: int = Field(ge=0)
    # null when sampleSize is 0 (Phase 31 semantics: never 0 or 1 when undetermined). Never called "confidence".
    successRate: float | None = Field(default=None, ge=0.0, le=1.0)
    eligible: bool


class LearningContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    learningVersion: Literal["learning-v1"]
    minimumSampleSize: int = Field(ge=1)
    windowDays: int = Field(ge=1)
    patterns: list[LearningPattern] = Field(default_factory=list, max_length=MAX_PATTERNS)
