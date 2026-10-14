"""
Phase 26.5 - the ONLY place in the evaluation that talks to a real embedding provider.

    cd ai-service && .venv/Scripts/python.exe ../backend/evaluation/retrieval/real/collect_embeddings.py --dry-run
    cd ai-service && .venv/Scripts/python.exe ../backend/evaluation/retrieval/real/collect_embeddings.py --execute

WHAT IT SENDS: only the texts listed in the manifest written by export-manifest.mjs (synthetic Phase 26 evaluation documents and queries).
WHAT IT NEVER CALLS: any generation endpoint. The only provider call in this file is `models.embed_content` (embeddings); there is no
`generate_content` anywhere (asserted by the validation suite).
THE KEY: read by the repository's own settings object (ai-service/.env) inside THIS process only; it is never printed, logged, written to the
output, passed to a child process or stored.

TASKS (Gemini retrieval semantics):
  documents                                  -> RETRIEVAL_DOCUMENT    (what production does for chunks)
  queries, "production" arm                  -> RETRIEVAL_DOCUMENT    (what production does today: it embeds the query with the SAME function)
  queries, "provider-recommended" arm        -> RETRIEVAL_QUERY       (Google's documented task type for a retrieval query)
Documents are embedded through the repository's existing integration (`generate_gemini_embeddings`); only the RETRIEVAL_QUERY arm needs the
small adapter below, which builds the client exactly like the existing integration (same SDK, timeout, no retries, error mapping).
"""

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path.cwd()))  # run from ai-service/

from google import genai  # noqa: E402
from google.genai import errors as genai_errors  # noqa: E402
from google.genai import types  # noqa: E402

from app.config import settings  # noqa: E402
from app.services.gemini_embedding_client import _map_embedding_provider_error, generate_gemini_embeddings  # noqa: E402

DOCUMENT_TASK = "RETRIEVAL_DOCUMENT"
QUERY_TASK = "RETRIEVAL_QUERY"
PII_PATTERNS = [re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I), re.compile(r"\+?\d[\d\s().-]{8,}\d"), re.compile(r"https?://", re.I)]


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def embed_with_task(texts: list[str], task: str) -> list[list[float]]:
    """Same client construction as generate_gemini_embeddings, with a chosen task type (embeddings only)."""
    client = genai.Client(
        api_key=settings.gemini_api_key,
        http_options=types.HttpOptions(timeout=settings.request_timeout_ms, retry_options=types.HttpRetryOptions(attempts=1)),
    )
    try:
        response = client.models.embed_content(model=settings.embedding_model, contents=texts, config=types.EmbedContentConfig(task_type=task))
    except genai_errors.APIError as exc:
        raise _map_embedding_provider_error(exc) from None
    embeddings = response.embeddings or []
    if len(embeddings) != len(texts):
        raise RuntimeError("provider returned an unexpected number of embeddings")
    return [list(item.values) if item.values else [] for item in embeddings]


def batches(items, size):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", default=str(Path("../backend/evaluation/results/phase26_5-embedding-manifest.json")))
    parser.add_argument("--out", default=str(Path("../backend/evaluation/results/phase26_5-real-embedding-cache.json")))
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--execute", action="store_true")
    args = parser.parse_args()

    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    entries = manifest["entries"]

    # ---- pre-flight (identical for dry-run and execute) ----
    problems = []
    for e in entries:
        if e["kind"] not in ("document", "query"):
            problems.append(f"unknown kind: {e['kind']}")
        if sha(e["text"]) != e["sha256"]:
            problems.append(f"hash mismatch for {e['source']}")
        if any(p.search(e["text"]) for p in PII_PATTERNS):
            problems.append(f"PII-like pattern in {e['source']}")
    if manifest.get("purpose", "").startswith("synthetic Phase 26") is False:
        problems.append("manifest is not marked synthetic")
    if problems:
        print("REFUSING: " + "; ".join(problems))
        return 2

    docs = [e for e in entries if e["kind"] == "document"]
    queries = [e for e in entries if e["kind"] == "query"]
    batch = settings.embedding_batch_size
    plan = [("documents", DOCUMENT_TASK, docs), ("queries-as-document (production arm)", DOCUMENT_TASK, queries), ("queries-as-query (provider-recommended arm)", QUERY_TASK, queries)]
    requests = sum(len(list(batches(group, batch))) for _, _, group in plan)
    print(f"provider=gemini model={settings.embedding_model} batch_size={batch} key_configured={bool(settings.gemini_api_key)}")
    print(f"dataset {manifest['datasetVersion']} sha256={manifest['datasetSha256'][:12]}...")
    for label, task, group in plan:
        print(f"  {label}: {len(group)} texts, {sum(e['chars'] for e in group)} chars, task_type={task}, requests={len(list(batches(group, batch)))}")
    print(f"TOTAL external embedding requests: {requests}; texts: {sum(len(g) for _, _, g in plan)}; generation requests: 0")
    if args.dry_run:
        print("dry run: nothing was sent")
        return 0
    if not settings.gemini_api_key:
        print("REFUSING: no embedding key configured")
        return 2
    if requests > 20:
        print("REFUSING: unexpectedly many requests")
        return 2

    out_entries = []
    calls = 0
    dimension = None
    for label, task, group in plan:
        for chunk in batches(group, batch):
            texts = [e["text"] for e in chunk]
            vectors = generate_gemini_embeddings(texts).embeddings if task == DOCUMENT_TASK else embed_with_task(texts, task)
            calls += 1
            for e, vec in zip(chunk, vectors):
                dimension = dimension or len(vec)
                if len(vec) != dimension:
                    raise RuntimeError("inconsistent embedding dimension")
                out_entries.append({"taskType": task, "kind": e["kind"], "source": e["source"], "sha256": e["sha256"], "vector": vec})
    cache = {
        "schema": 1,
        "provider": "gemini",
        "model": settings.embedding_model,
        "dimension": dimension,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "datasetVersion": manifest["datasetVersion"],
        "datasetSha256": manifest["datasetSha256"],
        "taskConfigs": {"document": DOCUMENT_TASK, "queryProductionArm": DOCUMENT_TASK, "queryProviderRecommendedArm": QUERY_TASK},
        "usage": {"embeddingRequests": calls, "generationRequests": 0, "textsSent": len(docs) + 2 * len(queries), "charactersSent": sum(e["chars"] for e in docs) + 2 * sum(e["chars"] for e in queries)},
        "entries": out_entries,
    }
    Path(args.out).write_text(json.dumps(cache), encoding="utf-8")
    print(f"done: {calls} embedding requests, dimension {dimension}, wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
