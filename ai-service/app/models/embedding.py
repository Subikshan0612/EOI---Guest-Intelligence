"""
Request/response contract for POST /v1/embeddings.

Deliberately minimal and separate from the intelligence contract
(app/models/intelligence.py): this service receives only `texts` here — no
workspaceId, no MongoDB identifiers, no tenant concept of any kind. Node
alone decides which chunks' text to send and persists the response against
the right KnowledgeChunk rows; this service has no way to even express that
concept, which is the point.
"""

import math

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.config import settings


class EmbeddingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    texts: list[str] = Field(min_length=1)

    @field_validator("texts")
    @classmethod
    def _texts_must_be_non_blank(cls, value: list[str]) -> list[str]:
        if any(not text.strip() for text in value):
            raise ValueError("each text must be non-empty")
        return value

    @field_validator("texts")
    @classmethod
    def _texts_must_respect_batch_size(cls, value: list[str]) -> list[str]:
        # Read settings.embedding_batch_size at validation time, not at
        # class-definition/import time — a Field(max_length=...) constraint
        # would freeze whatever value was configured when this module was
        # first imported, making EMBEDDING_BATCH_SIZE effectively immutable
        # at runtime (and untestable without restarting the process).
        if len(value) > settings.embedding_batch_size:
            raise ValueError(f"texts exceeds the maximum batch size of {settings.embedding_batch_size}")
        return value


class EmbeddingResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    embeddings: list[list[float]] = Field(min_length=1)
    model: str = Field(min_length=1)

    @field_validator("embeddings")
    @classmethod
    def _embeddings_must_be_well_formed(cls, value: list[list[float]]) -> list[list[float]]:
        if any(len(vector) == 0 for vector in value):
            raise ValueError("each embedding vector must be non-empty")

        dimension = len(value[0])
        if any(len(vector) != dimension for vector in value):
            raise ValueError("all embedding vectors must have the same dimensionality")

        for vector in value:
            for component in vector:
                if not math.isfinite(component):
                    raise ValueError("embedding values must be finite numeric data")

        return value
