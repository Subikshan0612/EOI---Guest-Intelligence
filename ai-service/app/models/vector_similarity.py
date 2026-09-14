"""
Request/response contract for POST /v1/vector-similarity.

Phase 6F: a similarity PRIMITIVE, not the Phase 6G retrieval endpoint. Node
supplies a query vector and a list of candidates it has already resolved
and tenant-scoped; this service only scores them against each other. No
workspaceId, no propertyId, no MongoDB query capability of any kind — the
only identifier here is an opaque `chunkId`, used purely to correlate a
result back to its candidate. Python never queries for it, interprets it,
or uses it to decide anything.

Deliberately minimal for this phase: only `chunkId` + `embedding` per
candidate. documentId/version/section/chunkIndex are not part of this
contract yet — Phase 6F needs nothing beyond an opaque id to return a
result Node can map back to a chunk; a richer per-candidate contract can
be introduced in Phase 6G if the actual retrieval design needs one.
"""

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.config import settings
from app.services.vector_math import is_valid_vector, vector_magnitude


class SimilarityCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chunkId: str = Field(min_length=1)
    embedding: list[float] = Field(min_length=1)

    @field_validator("embedding")
    @classmethod
    def _embedding_must_be_valid(cls, value: list[float]) -> list[float]:
        if not is_valid_vector(value):
            raise ValueError("candidate embedding must be a non-empty array of finite numbers")
        return value


class VectorSimilarityRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    queryEmbedding: list[float] = Field(min_length=1)
    candidates: list[SimilarityCandidate] = Field(min_length=1)

    @field_validator("queryEmbedding")
    @classmethod
    def _query_embedding_must_be_valid(cls, value: list[float]) -> list[float]:
        if not is_valid_vector(value):
            raise ValueError("queryEmbedding must be a non-empty array of finite numbers")
        return value

    @field_validator("candidates")
    @classmethod
    def _candidates_must_respect_max(cls, value: list[SimilarityCandidate]) -> list[SimilarityCandidate]:
        # Read settings.similarity_max_candidates at validation time, not at
        # class-definition/import time — the same lesson Phase 6E's
        # embedding_batch_size validator already applies (a static
        # Field(max_length=...) would freeze whatever value was configured
        # when this module was first imported).
        if len(value) > settings.similarity_max_candidates:
            raise ValueError(f"candidates exceeds the maximum of {settings.similarity_max_candidates}")
        return value

    @model_validator(mode="after")
    def _candidates_must_be_comparable(self) -> "VectorSimilarityRequest":
        query_dimension = len(self.queryEmbedding)
        if vector_magnitude(self.queryEmbedding) == 0:
            raise ValueError("queryEmbedding has zero magnitude and cannot be compared")

        seen_chunk_ids: set[str] = set()
        for candidate in self.candidates:
            if len(candidate.embedding) != query_dimension:
                raise ValueError("every candidate embedding must match queryEmbedding's dimensionality")
            if vector_magnitude(candidate.embedding) == 0:
                raise ValueError(f"candidate {candidate.chunkId} has a zero-magnitude embedding")
            if candidate.chunkId in seen_chunk_ids:
                raise ValueError(f"duplicate chunkId in candidates: {candidate.chunkId}")
            seen_chunk_ids.add(candidate.chunkId)

        return self


class SimilarityResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chunkId: str
    score: float


class VectorSimilarityResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    results: list[SimilarityResult]
