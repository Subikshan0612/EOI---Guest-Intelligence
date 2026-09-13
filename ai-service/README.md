# KOI AI Service

Python/FastAPI AI-orchestration service for KOI (Kolam Operational Intelligence).

## What this is

This is the foundation of KOI's Phase 5 AI service boundary — a small, single-purpose
Python service that sits between the existing Node/Express backend and an LLM provider
(Gemini). It is a **sibling** of `backend/` and `frontend/`, not a replacement for either.

## What this service owns (eventually)

- AI orchestration (prompt construction, model invocation)
- AI-specific processing of an already-assembled operational context
- Future retrieval/RAG orchestration, if and when that phase is authorized
- Future agent orchestration, if and when that phase is authorized

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

## Current Phase 5 scope (Step 2)

**This step builds the service foundation only.** It does not yet:
- Call Gemini or any other LLM provider
- Define the real intelligence request/response contract
- Talk to the Node backend
- Persist anything

The only endpoint implemented so far is a health check. Configuration for
`LLM_PROVIDER`/`LLM_MODEL`/`GEMINI_API_KEY` is wired up so later steps don't need to
redo environment plumbing, but nothing reads `GEMINI_API_KEY` yet, and the service
starts and runs correctly with it left blank.

## Responsibility split (Node vs. this service)

| | Node/Express (`backend/`) | AI service (`ai-service/`) |
|---|---|---|
| Operational data / MongoDB | ✅ owns | ❌ never |
| Tenant/workspace isolation | ✅ owns | ❌ never |
| Context assembly | ✅ owns | ❌ never (receives it) |
| Public API for the frontend | ✅ owns | ❌ never |
| AI orchestration / model invocation | (currently, Phase 4) | ✅ eventual owner |
| AI-specific processing | — | ✅ eventual owner |

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

Leave `GEMINI_API_KEY` blank — it is not used yet and the service does not require it
to start.

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
running service — it drives the FastAPI app directly in-process via `TestClient`.

## Port

This service runs on **port 8000** in local development, distinct from the Node
backend (`5000`) and the Vite frontend (`5173`).
