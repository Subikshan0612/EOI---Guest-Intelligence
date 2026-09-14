"""
Phase 6F — pure vector validation and cosine similarity.

No MongoDB, no HTTP, no provider calls, no side effects. This is the
reusable "is this vector safe to compare" boundary that app/models/
embedding.py's response validator already partially implements — extracted
here so the similarity contract (app/models/vector_similarity.py) can
reuse the exact same rule rather than duplicating it, and so cosine
similarity itself is a small, independently testable primitive.

Stored embeddings are never rewritten or renormalized by anything in this
module — KnowledgeChunk.embedding keeps exactly what the embedding
provider produced (Phase 6E). Normalization here, where it happens, is
purely arithmetic (division inside the cosine similarity formula itself)
and never mutates or returns a "normalized copy" of the input.
"""

import math


def is_valid_vector(vector) -> bool:
    """
    A vector is valid if it is a non-empty list of finite numbers.

    Rejects: not a list; empty; any non-numeric element (None, str, dict,
    list, ...); NaN or +/-Infinity (both fail math.isfinite). `bool` is
    explicitly rejected too — Python's bool is an int subclass, so `True`/
    `False` would otherwise silently pass as 1/0.
    """
    if not isinstance(vector, list) or len(vector) == 0:
        return False

    for value in vector:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return False
        if not math.isfinite(value):
            return False

    return True


def vector_magnitude(vector: list[float]) -> float:
    return math.sqrt(sum(component * component for component in vector))


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """
    dot(A, B) / (||A|| * ||B||)

    Pure, deterministic, no I/O, no randomness. Never returns NaN or
    Infinity: the two ways this formula is undefined are both rejected
    explicitly with a ValueError instead —
      - mismatched dimensionality (the dot product isn't defined), and
      - either vector having zero magnitude (division by zero).

    This function does not re-validate element-level shape/finiteness
    (use is_valid_vector() first for untrusted input) — it stays a small,
    single-purpose arithmetic primitive. In practice, callers going through
    POST /v1/vector-similarity never reach either ValueError below, because
    VectorSimilarityRequest already rejects both conditions at the request
    level; the checks here exist so this function is also safe to call
    directly (e.g. from tests, or a future caller) without that request
    layer in front of it.
    """
    if len(a) != len(b):
        raise ValueError("cannot compute cosine similarity for vectors of different dimensionality")

    magnitude_a = vector_magnitude(a)
    magnitude_b = vector_magnitude(b)
    if magnitude_a == 0 or magnitude_b == 0:
        raise ValueError("cannot compute cosine similarity for a zero-magnitude vector")

    dot_product = sum(x * y for x, y in zip(a, b))
    return dot_product / (magnitude_a * magnitude_b)
