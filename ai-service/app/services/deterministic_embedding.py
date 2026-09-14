"""
Deterministic stub embedding generator.

Used when this service's own EMBEDDING_PROVIDER is "test" (see
app/routers/embeddings.py and app/config.py). Mirrors
app/services/deterministic_stub.py's role for intelligence generation: never
makes a network call, never requires an API key, and exists to prove the
Node <-> Python embedding contract independently of any real provider.

Uses hashlib.sha256 rather than Python's built-in hash() — the built-in is
salted per-process for strings (PYTHONHASHSEED) specifically to prevent
predictable output, which is the opposite of what a deterministic test
double needs. sha256 is stable across processes and Python versions: the
same text always produces the same digest, which is what makes "same input
-> identical vector" and "re-embedding is deterministic" true here.
"""

import hashlib

from app.models.embedding import EmbeddingResponse

TEST_EMBEDDING_MODEL = "deterministic-embedding-v1"

# Arbitrary but fixed — small enough to be fast, large enough to behave like
# a real embedding vector for cosine-similarity testing later. Not meant to
# resemble any real provider's dimensionality; embeddingModel is what
# prevents a real vector and a test vector from ever being compared.
TEST_EMBEDDING_DIMENSIONS = 32


def _deterministic_vector(text: str) -> list[float]:
    seed = hashlib.sha256(text.strip().encode("utf-8")).digest()

    values: list[float] = []
    counter = 0
    while len(values) < TEST_EMBEDDING_DIMENSIONS:
        # Extendable-output-style construction: re-hash the seed with an
        # incrementing counter to deterministically generate as many bytes
        # as needed, however large TEST_EMBEDDING_DIMENSIONS is.
        block = hashlib.sha256(seed + counter.to_bytes(4, "big")).digest()
        for i in range(0, len(block), 4):
            if len(values) >= TEST_EMBEDDING_DIMENSIONS:
                break
            unsigned = int.from_bytes(block[i : i + 4], "big") / 0xFFFFFFFF
            values.append(unsigned * 2 - 1)  # map [0, 1] -> [-1, 1]
        counter += 1

    magnitude = sum(component * component for component in values) ** 0.5
    if magnitude == 0:
        return values
    return [component / magnitude for component in values]


def generate_deterministic_embeddings(texts: list[str]) -> EmbeddingResponse:
    vectors = [_deterministic_vector(text) for text in texts]
    return EmbeddingResponse(embeddings=vectors, model=TEST_EMBEDDING_MODEL)
