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
from app.models.visibility import Visibility
from app.services.vector_math import is_valid_vector, vector_magnitude

KnowledgeScope = Literal["unit", "property", "workspace"]


class RetrievalCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chunkId: str = Field(min_length=1)
    embedding: list[float] = Field(min_length=1)
    scope: KnowledgeScope
    # The candidate chunk's own visibility, assigned by Node. Required: a
    # candidate that does not say what it is cannot be authorized.
    visibility: Visibility
    # Phase 25: the embedding model that produced THIS vector (persisted on the
    # chunk by Node). Required: a vector that does not say which vector space it
    # lives in cannot be compared, so it is never scored (see routers/retrieval.py).
    embeddingModel: str = Field(min_length=1)

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
    # The level Node authorized this request for. Candidates above it are
    # ignored (defence in depth - Node has already filtered). Defaults to the
    # lowest level so an omitted value can only ever see less.
    authorizedLevel: Visibility = "guest"

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
        # Phase 25: candidates are NO LONGER required to share one dimensionality. Compatibility is decided
        # per candidate against the QUERY embedding (same model AND same dimension); an incompatible
        # candidate is skipped and counted, never compared. Structural defects still reject the request.
        seen_chunk_ids: set[str] = set()
        for candidate in self.candidates:
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

    # Every COMPATIBLE, visible candidate that was scored (Phase 25: no relevance threshold here - the
    # server-side minimum similarity is applied, authoritatively, by Node; see backend knowledgeRetrievalService.js).
    results: list[RetrievalResult]
    # The model that embedded the QUERY.
    model: str = Field(min_length=1)
    # Phase 25 diagnostics (counts only): candidates that were visible and considered, and how many of
    # those were skipped because their embedding model or dimension does not match the query embedding.
    evaluatedCandidates: int = Field(default=0, ge=0)
    incompatibleCandidates: int = Field(default=0, ge=0)
