"""
Phase 26.5 - OFFLINE replay of the cached real embeddings, behind the PRODUCTION ai-service application.

    cd ai-service && EVAL_EMBEDDING_CACHE=<cache.json> EVAL_QUERY_TASK=RETRIEVAL_DOCUMENT|RETRIEVAL_QUERY \
        python -m uvicorn replay_service:app --app-dir ../backend/evaluation/retrieval/real --port <p>

It imports the unchanged production `app.main:app` (its retrieval scoring, scope boost, compatibility rule, ordering and validation are all the
production code) and replaces ONLY the two calls that would reach the embedding provider:

  POST /v1/embeddings          (chunk embedding text)   -> the cached RETRIEVAL_DOCUMENT vector
  POST /v1/knowledge-retrieval (the query, embedded inside the router) -> the cached vector of the arm's query task

Lookup is by sha256 of the exact text. A text that is not in the cache raises (it never falls through to a provider). The process makes no
network connection to a non-loopback address (socket guard) and holds no API key. Nothing here can spend an external call.
"""

import hashlib
import json
import os
import socket

_LOOPBACK = {"127.0.0.1", "::1", "localhost", "0.0.0.0", ""}
_real_connect = socket.socket.connect


def _guarded_connect(self, address):
    host = str(address[0]) if isinstance(address, tuple) and address else str(address)
    if self.family in (socket.AF_INET, socket.AF_INET6) and host not in _LOOPBACK and not host.startswith("127."):
        raise RuntimeError(f"replay service: connection to a non-loopback host ({host}) is forbidden")
    return _real_connect(self, address)


socket.socket.connect = _guarded_connect

os.environ["LLM_PROVIDER"] = "test"
os.environ["EMBEDDING_PROVIDER"] = "test"
os.environ["GEMINI_API_KEY"] = ""

from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402  (production application, unchanged)
from app.models.embedding import EmbeddingResponse  # noqa: E402
import app.routers.embeddings as embeddings_router  # noqa: E402
import app.routers.retrieval as retrieval_router  # noqa: E402

_cache = json.loads(open(os.environ["EVAL_EMBEDDING_CACHE"], encoding="utf-8").read())
_query_task = os.environ.get("EVAL_QUERY_TASK", "RETRIEVAL_DOCUMENT")
if _query_task not in ("RETRIEVAL_DOCUMENT", "RETRIEVAL_QUERY"):
    raise RuntimeError("EVAL_QUERY_TASK must be RETRIEVAL_DOCUMENT or RETRIEVAL_QUERY")
_index = {(e["taskType"], e["sha256"]): e["vector"] for e in _cache["entries"]}


def _replay(texts: list[str], task: str) -> EmbeddingResponse:
    vectors = []
    for text in texts:
        key = (task, hashlib.sha256(text.encode("utf-8")).hexdigest())
        if key not in _index:
            raise RuntimeError(f"replay cache has no {task} embedding for this text (sha256 {key[1][:12]}...)")
        vectors.append(_index[key])
    return EmbeddingResponse(embeddings=vectors, model=_cache["model"])


@app.get("/v1/eval-replay-info")
def _eval_replay_info() -> dict:
    """Identity of THIS process (evaluation only): which query task it replays and the per-spawn nonce the harness generated for it."""
    return {
        "queryTask": _query_task,
        "nonce": os.environ.get("EVAL_RUN_NONCE"),
        "model": _cache["model"],
        "cacheEntries": len(_index),
        # what this process could reach: no key, test providers only (so the only generation path is the deterministic stub), socket guard installed
        "llmProvider": settings.llm_provider,
        "embeddingProvider": settings.embedding_provider,
        "keyConfigured": bool(settings.gemini_api_key),
        "socketGuardInstalled": socket.socket.connect is _guarded_connect,
    }


embeddings_router.generate_embeddings = lambda texts: _replay(texts, "RETRIEVAL_DOCUMENT")
retrieval_router.generate_embeddings = lambda texts: _replay(texts, _query_task)
