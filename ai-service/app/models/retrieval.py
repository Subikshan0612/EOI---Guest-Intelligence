"""
Request/response contract for POST /v1/knowledge-retrieval.

Phase 6G: ranks already-selected, already-tenant-scoped KnowledgeChunk
candidates against a fresh embedding of `queryText`, using the existing
embedding provider (app/services/embedding_service.py) and the Phase 6F
cosine-similarity primitive (app/services/vector_math.py). This is NOT a
general retrieval/RAG endpoint for arbitrary text — Node has already
resolved a Signal's trusted operational context, selected eligible
candidates from MongoDB, and labeled each with its own scope before this
is ever called. No workspaceId, no MongoDB identifier beyond an opaque
`chunkId` used purely to correlate a result back to its candidate.

`scope` is a label Node assigns per candidate, based on that candidate
chunk's OWN propertyId/unitId (already resolved and validated in Node) —
Python never determines scope from any identifier; it only applies a
fixed, documented numeric preference to whatever label it is given.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.config import settings
from app.services.vector_math import is_valid_vector, vector_magnitude

KnowledgeScope = Literal["unit", "property", "workspace"]


class RetrievalCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chunkId: str = Field(min_length=1)
    embedding: list[float] = Field(min_length=1)
    scope: KnowledgeScope

    @field_validator("embedding")
    @classmethod
    def _embedding_must_be_valid(cls, value: list[float]) -> list[float]:
        if not is_valid_vector(value):
            raise ValueError("candidate embedding must be a non-empty array of finite numbers")
        return value


class KnowledgeRetrievalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    queryText: str = Field(min_length=1)
    candidates: list[RetrievalCandidate] = Field(min_length=1)

    @field_validator("queryText")
    @classmethod
    def _query_text_must_be_non_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("queryText must be non-empty")
        return value

    @field_validator("candidates")
    @classmethod
    def _candidates_must_respect_max(cls, value: list["RetrievalCandidate"]) -> list["RetrievalCandidate"]:
        # Read settings.similarity_max_candidates at validation time — the
        # exact same setting (not a duplicate) Phase 6F's own candidate cap
        # already uses, per the Phase 6A "MAX candidates = 200" boundary.
        if len(value) > settings.similarity_max_candidates:
            raise ValueError(f"candidates exceeds the maximum of {settings.similarity_max_candidates}")
        return value

    @model_validator(mode="after")
    def _candidates_must_be_internally_consistent(self) -> "KnowledgeRetrievalRequest":
        dimension = len(self.candidates[0].embedding)
        seen_chunk_ids: set[str] = set()
        for candidate in self.candidates:
            if len(candidate.embedding) != dimension:
                raise ValueError("every candidate embedding must share the same dimensionality")
            if vector_magnitude(candidate.embedding) == 0:
                raise ValueError(f"candidate {candidate.chunkId} has a zero-magnitude embedding")
            if candidate.chunkId in seen_chunk_ids:
                raise ValueError(f"duplicate chunkId in candidates: {candidate.chunkId}")
            seen_chunk_ids.add(candidate.chunkId)
        return self


class RetrievalResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chunkId: str
    scope: KnowledgeScope
    similarityScore: float
    retrievalScore: float


class KnowledgeRetrievalResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    results: list[RetrievalResult]
    model: str = Field(min_length=1)
