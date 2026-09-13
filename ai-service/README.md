# KOI AI Service

Python/FastAPI AI-orchestration service for KOI (Kolam Operational Intelligence).

## What this is

This is the foundation of KOI's Phase 5 AI service boundary — a small, single-purpose
Python service that sits between the existing Node/Express backend and an LLM provider
(Gemini). It is a **sibling** of `backend/` and `frontend/`, not a replacement for either.

## What this service owns

- AI orchestration (prompt construction, model invocation) — real, as of Phase 5 Step 4
  (`app/services/gemini_client.py`), alongside the deterministic stub from Step 3
  (`app/services/deterministic_stub.py`). Which one runs is decided entirely by this
  service's own `LLM_PROVIDER` env var — never by the caller.
- AI-specific processing of an already-assembled operational context.
- Future retrieval/RAG orchestration, if and when that phase is authorized.
- Future agent orchestration, if and when that phase is authorized.

## What this service does NOT own

- Operational data or MongoDB access — this service has no database connection and
  never will directly own one without a compelling, explicitly-authorized reason.
- Tenant/workspace isolation — that boundary is enforced entirely in Node
  (`backend/src/services/signalContextService.js` and `queryHelpers.js`).
- Context assembly (Signal/Guest/Stay/Property/Unit/history) — Node assembles this and
  will pass it to this service as an already-validated payload; this service never
  queries for it independently.
- The public API surface consumed by the React frontend — the frontend only ever talks
  to Node (`POST /api/signals/:id/intelligence`); it has no knowledge this service exists.
- Authentication/authorization — handled upstream in Node when it is eventually added.

## Current Phase 5 scope (Step 4)

**Real Gemini execution now lives here**, reached only via Node's
`POST /api/signals/:id/intelligence`:

```
Node assembleSignalContext() -> aiServiceClient.js -> POST /v1/intelligence/signal
  -> this service's own LLM_PROVIDER decides:
       "test"   -> deterministic stub (no network call) — the default
       "gemini" -> real call via the official google-genai SDK
  -> validated IntelligenceResponse -> Node re-validates -> React
```

This service still does not: talk to MongoDB, know about tenants/workspaces, or persist
anything. Node's own pre-Step-4 direct Gemini implementation was removed in Phase 5 Step 5's
cleanup once it became genuinely dead code (nothing routed `LLM_PROVIDER=gemini` to it any
more). `backend/src/services/ai/llmProvider.js` still exists and is still used, but only for
its `openai` (direct Node→OpenAI, unaffected by any of this) and `test` (Node-level
deterministic fixture) branches — it has no Gemini code or Gemini dependency left.

## Responsibility split (Node vs. this service)

| | Node/Express (`backend/`) | AI service (`ai-service/`) |
|---|---|---|
| Operational data / MongoDB | ✅ owns | ❌ never |
| Tenant/workspace isolation | ✅ owns | ❌ never |
| Context assembly | ✅ owns | ❌ never (receives it) |
| Public API for the frontend | ✅ owns | ❌ never |
| Gemini invocation | ❌ never (no Gemini client in Node as of Step 5) | ✅ (via `LLM_PROVIDER=gemini`/`test-python` on Node + `LLM_PROVIDER=gemini` here) |
| AI-specific processing / prompt construction | — | ✅ owns |
| Final application-level response validation | ✅ owns (always re-validates) | ✅ also validates before returning |
| Provenance | relays what this service reports | ✅ attaches its own (provider/model), never trusts the model's own output |

## Local setup

### Prerequisites

- Python 3.11+ (developed against 3.12)

### 1. Create a virtual environment

From the `ai-service/` directory:

```bash
python -m venv .venv
```

### 2. Activate it

macOS/Linux:
```bash
source .venv/bin/activate
```

Windows (Git Bash):
```bash
source .venv/Scripts/activate
```

Windows (PowerShell):
```powershell
.venv\Scripts\Activate.ps1
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

### 4. Configure environment (optional at this step)

```bash
cp .env.example .env
```

Leave `GEMINI_API_KEY` blank (and/or `LLM_PROVIDER` at its default of `test`) to run
with the deterministic stub only — the service never requires a real key to start, and
never attempts a real call unless `LLM_PROVIDER=gemini` is explicitly set here.

### 5. Start the service

```bash
uvicorn app.main:app --reload --port 8000
```

### 6. Verify the health endpoint

```bash
curl http://localhost:8000/v1/health
```

Expected:
```json
{"status": "healthy"}
```

## Running tests

```bash
pytest
```

The test suite requires no Gemini key, no MongoDB, no network access, and no other
running service — it drives the FastAPI app directly in-process via `TestClient`, and
the Gemini-path tests (`tests/test_gemini_client.py`) monkeypatch the SDK client so
error-mapping and response-parsing are proven without ever contacting Google's servers.

## Port

This service runs on **port 8000** in local development, distinct from the Node
backend (`5000`) and the Vite frontend (`5173`).
