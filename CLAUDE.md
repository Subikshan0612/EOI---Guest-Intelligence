# CLAUDE.md — KOI (Kolam Operational Intelligence)

Persistent instructions for Claude Code working in this repository. Read this before making changes.

## What KOI is

KOI is an **operational intelligence platform** for service-apartment and hospitality
businesses — not a generic chatbot project. The chat UI is an interface *onto* operational
intelligence, not the product itself.

Long-term intelligence loop:

```
Signals → Context → Intelligence → Decision → Action → Outcome → Learning → Better Action
```

Core principle — never violate this:

> **Operational facts are stored as facts. Intelligence is derived from those facts.**

Don't mix source operational data (Signal, Guest, Stay, Property, Unit) with AI-generated
interpretation (Intelligence, Decision, Action, Outcome). The latter reference the former by id;
they never overwrite or merge into it.

## Current architecture (verified against the repo)

### Frontend — `frontend/`
React 19 + Vite 6 + plain JavaScript (no TypeScript), `react-router-dom` 7, `axios`, `lucide-react`.

- `src/app/App.jsx` → `BrowserRouter` → `LayoutProvider` → `ConversationProvider` → `AppRoutes`.
- Routes (`src/app/routes.jsx`), all under `AppShell`: `/`, `/chat/:conversationId?`, `/prompts`, `/settings`.
- `services/api.js` — the **only** axios instance (`koiEndpoints` + `ApiError` + thin functions:
  `listConversations`, `getConversation`, `createConversation`, `updateConversation`,
  `deleteConversation`, `listMessages`, `createMessage`). Callers get plain data or `ApiError`,
  never a raw axios response.
- `features/conversations/ConversationProvider.jsx` — source of truth for conversations. Two modes,
  selected once via `config/workspace.js` (`isWorkspaceConfigured`):
  - **BACKEND mode** (`VITE_KOI_WORKSPACE_ID` set): REST API is authoritative. No localStorage.
  - **LOCAL mode** (unset): Phase-1 in-memory + `localStorage` fallback (`conversationStore.js`),
    so the app still runs with no backend.
- `features/conversations/conversationMapping.js` — the **single mapping boundary** between REST
  shapes and the frontend conversation/message shapes (`_id↔id`, intelligence payload packed into
  `metadata.koiIntelligence` on write, unpacked on read).
- `features/chat/useChat.js` — turn orchestration: create conversation → persist user message →
  run mock intelligence (`chatService.js`) → persist the intelligence message.
- `features/intelligence/intelligenceContract.js` — the intelligence message contract (Signal,
  Context, Intelligence, Risk, Decision, Action, Outcome). `features/intelligence/cards.jsx` renders it.
- `chatService.js` is a **mock** intelligence generator (regex/template based against
  `data/mockData.js`). It is not an LLM client.

### Backend — `backend/`
Node ≥20 + Express 5 + Mongoose 8, ESM (`"type": "module"`).

Strict layering: **route → controller → service → model**. Controllers are thin
(`asyncHandler` + call one service function + `sendSuccess`/`sendList`). Business logic and
validation live in `src/services/*`, never in controllers or routes.

- `src/config/{env,database}.js`, `src/middleware/{errorHandler,notFound}.js`
- `src/utils/{AppError,asyncHandler,objectId,pagination,response}.js`
- `src/services/queryHelpers.js` — shared helpers used by every service:
  `findByIdOr404`, `findInWorkspaceOr404`, `assertExists`, `assertSameWorkspace` (synchronous —
  do not make it `async` again), `assertWorkspaceUnchanged`, `paginateQuery`, `pickDefined`, etc.
- Routes: `health`, `workspaces`, `properties`, `units`, `guests`, `stays`, `signals`,
  `conversations` (+ nested `/:conversationId/messages`), `intelligence`, `decisions`, `actions`, `outcomes`.
- `backend/scripts/validate-api.mjs` — the API + tenant-isolation regression suite. Baseline:
  **105 passed, 0 failed**. `backend/scripts/create-dev-workspace.mjs` — idempotent dev workspace creator.

### Database — MongoDB via Mongoose
12 models: `Workspace, Property, Unit, Guest, Stay, Signal, Conversation, Message, Intelligence,
Decision, Action, Outcome`.

```
Workspace ─┬─ Property ── Unit
           ├─ Guest ───── Stay
           ├─ Signal
           ├─ Conversation ──< Message
           └─ Intelligence ── Decision, Action, Outcome
```

Intelligence/Decision/Action/Outcome are currently **storage only** — plain CRUD records with no
inference. `Unit` has no `workspaceId` (derived via `propertyId → Property.workspaceId`). `Message`
has no `workspaceId` (derived via `conversationId → Conversation.workspaceId`).

## Multi-tenancy — do not weaken this

Workspace is the tenant boundary. There is **no authentication yet**; `workspaceId` is the only
tenancy mechanism, supplied by the caller (query param for reads/updates/deletes, body for
creates). Treat it as a hard boundary anyway:

- Every tenant-owned list, by-id GET, PATCH, and DELETE **must** be workspace-scoped
  (`findInWorkspaceOr404`) and must return a clean `400` if `workspaceId` is missing/invalid.
- Never add a query path that can return or mutate another workspace's data.
- `Unit` scope = its `Property`'s `workspaceId`. `Message` scope = its `Conversation`'s `workspaceId`.
  Keep resolving scope through those relationships — don't add a `workspaceId` column as a shortcut.
- Cross-entity references must be validated against the resource's own workspace
  (`assertSameWorkspace`, called synchronously — never `await`-only without checking it actually
  throws) before being saved: Stay→Guest/Property/Unit, Signal→Guest/Stay/Property/Unit,
  Conversation→Guest/Stay/Signal, Intelligence→Conversation/Guest/Stay/Signal, Decision→Intelligence,
  Action→Intelligence/Decision, Outcome→Intelligence/Action.
- PATCH must never allow `workspaceId` to be reassigned (`assertWorkspaceUnchanged`).
- If a feature seems to require changing tenant boundaries or the workspace model, **stop and
  explain the architectural implications before implementing it.**

## Frontend rules

- Preserve the current visual language (see `styles/tokens.css`, `global.css`, `layout.css`,
  `chat.css`). Don't introduce Tailwind, MUI, Bootstrap, or another design system unless explicitly asked.
- `services/api.js` is the only HTTP client. Don't add `fetch`, a second axios instance, or another
  API layer.
- Keep REST/axios details out of presentation components — go through the provider/service mapping
  boundary (`conversationMapping.js`), not ad hoc in JSX.
- Avoid new global state libraries (Redux, Zustand, etc.) — React context + hooks is the pattern here.
- Preserve the conversation UX: new-chat empty state, first-meaningful-message creates the
  conversation (never an empty one on merely opening "New Chat"), Today/Yesterday/Older grouping,
  loading/missing/error states in `ChatWorkspace`, graceful "Try again" on backend failure.
- **Never let localStorage compete with the backend as source of truth** when BACKEND mode is
  active (`isWorkspaceConfigured`). LOCAL-mode fallback is intentional and documented — don't extend
  it or reintroduce localStorage writes on the BACKEND path.
- Don't change the intelligence card structure (Signal/Context/Intelligence/Risk/Decision/Action/Outcome)
  without an explicit request.

## Backend rules

- Keep route → controller → service → model. Controllers stay thin.
- Centralize error handling through `AppError` + `errorHandler` — don't throw raw `Error`/response
  bodies from services.
- Every new tenant-owned service function takes/validates `workspaceId` the same way the existing
  ones do (see `propertyService.js` or `signalService.js` as the reference pattern).
- Validate cross-entity references; don't rely on "the id exists" alone.
- Prefer small, domain-oriented service modules over a shared generic CRUD abstraction.
- Preserve existing REST request/response contracts (`{success, data}`, `{success, data, pagination}`,
  `{success, message}`) unless a phase explicitly authorizes a contract change.

## AI / RAG boundaries — read this before touching intelligence

KOI's long-term plan includes RAG, embeddings, vector search, specialized agents, action
orchestration, and a learning loop, plus a Python/FastAPI AI service. **None of that is implemented
yet, and none of it should be added opportunistically.**

Phase 4 (current) introduced the first real AI layer — a single Node/Express intelligence pipeline:
`Signal → signalContextService.js (deterministic operational context) → services/ai/intelligenceService.js
→ services/ai/llmProvider.js → validated structured Intelligence`. See
`backend/src/services/ai/` for the implementation and `SignalIntelligencePage.jsx` for the UI.

- **Provider selection is a server-side-only concern** (`LLM_PROVIDER` env var) — never
  client-controllable, never a request parameter.
  - `gemini` — Google Gemini API (`@google/genai`), the primary free-tier development provider.
  - `openai` — OpenAI chat completions (`openai` SDK), retained as an optional/future alternative.
  - `test` — deterministic in-process fixture used only by `backend/scripts/validate-intelligence.mjs`;
    makes no network call and must never be used for real usage.
- Every provider must return output validated by `services/ai/intelligenceSchema.js` before it
  reaches the client — the contract (`summary/findings/risk/decision/action/outcome/confidence/provenance`)
  is fixed and provider-agnostic; provenance (`provider`/`model`) is always attached by the backend's
  own config, never trusted from the model's own output.
- Generated intelligence is **currently ephemeral** — nothing is persisted to the `Intelligence`
  collection by this pipeline. Do not add persistence here without an explicit phase asking for it.
- Generation is **explicitly user-triggered only** — never on page load, never via `useEffect`, no
  automatic retries or background/scheduled generation. This is a deliberate cost-control boundary.

Until a phase explicitly authorizes it, do **not** introduce:
- RAG, embeddings, or a vector database
- LangGraph or other agent frameworks
- Autonomous actions, background AI workers, or a Python AI service (Python/FastAPI is Phase 5)

The Phase-1 mock intelligence system (`chatService.js` + `intelligenceContract.js`) remains intact
and is still used by the unrelated Chat feature — it is a separate, pre-existing code path from the
Phase 4 AI pipeline above, not a fallback for it.

## Phase discipline

KOI is built in explicit phases; don't jump ahead.

- **Phase 1** — React/Vite frontend foundation. **Done.**
- **Phase 2** — Backend foundation, MongoDB/Mongoose, domain models, REST API, tenant isolation
  hardening, frontend↔backend conversation integration. **Done.**
- **Phase 3** — Operational Data Foundation. **Done.**
  - 3A — Property + Unit UI/flows
  - 3B — Guest + Stay UI/flows
  - 3C — Signal ingestion
  - 3D — Signal → Guest → Stay → Unit deterministic context assembly
  - 3E — Operational Intelligence UI (signal detail → context → intelligence page)
- **Phase 4** — First real AI intelligence engine (Node/Express, no Python yet). **Done** — see the
  AI/RAG boundaries section above for the current architecture.
- **Phase 5 (not started)** — Python/FastAPI AI service.
- **Later** — RAG, embeddings, vector search, agents, actions, outcomes, learning loop.

Rules:
1. Don't implement a future phase's feature because it seems useful now.
2. Don't do unrelated cleanup while doing a feature phase — flag it instead, don't fix it inline.
3. Don't redesign working architecture without a stated reason.
4. Inspect existing code before implementing; don't assume shapes or behavior.
5. Prefer the smallest correct, incremental change over a rewrite.

## Git workflow

- `main` is the working branch; GitHub `origin/main` is the source of truth.
- Check `git status` before any significant change. Never discard the user's uncommitted work;
  never `reset`/`checkout`/`clean` without explicit permission.
- Keep commits focused — don't mix unrelated work. Write meaningful commit messages.
- Never commit `.env` files, secrets, or generated build output (`frontend/dist/`, etc.) unless
  explicitly required.
- Review `git diff` (and `git diff --check`) before committing.

**The user reviews the implementation report before anything is committed.** After finishing an
implementation phase:
1. Run the relevant tests/build.
2. Inspect `git diff`.
3. Give a detailed, honest report.
4. Stop.
5. Do **not** commit or push unless explicitly instructed — even if everything passed.

## Testing expectations before calling a phase complete

Run and report, as relevant to the change:
- `cd backend && node scripts/validate-api.mjs` (baseline: 105 passed, 0 failed)
- `cd frontend && npm run build`
- `git diff` / `git diff --check`
- Manual/browser verification of the actual user flow touched
- Tenant-isolation check when anything touches services/queries
- Persistence check (survives refresh / reload from backend) when anything touches
  conversations/messages

Be explicit about what level of verification something got — don't conflate these:
**implemented → unit tested → API tested → browser tested → manually verified → not yet tested.**
Never claim a test happened if it didn't.

## Local development

- Frontend: `http://localhost:5173` · Backend: `http://localhost:5000` · MongoDB: `127.0.0.1:27017`.
- Config comes from `frontend/.env` / `backend/.env` (copy from the `.env.example` files) —
  never hard-code these values into source. Never commit either `.env` file.
- BACKEND mode requires a real `VITE_KOI_WORKSPACE_ID` from local MongoDB — get/create one with
  `node backend/scripts/create-dev-workspace.mjs`. Never invent an ObjectId.

## Known current limitations (do not silently "fix" these — they're out of scope unless asked)

- No authentication/user system yet; `workspaceId` is dev-only tenancy.
- Conversation deletion does not cascade-delete its `Message` documents.
- Backend conversations aren't yet linked to real Guest/Stay/Signal records.
- Intelligence is mocked, not AI-generated.
- No real operational business data is populated yet.
- Pagination limits are development-oriented, not tuned for scale.
- No multi-tab/session sync for conversations.

## How Claude Code should work on KOI

1. Inspect before modifying — read the actual code, don't assume.
2. Preserve working functionality; don't break what already works.
3. Follow the current architecture (layering, mapping boundary, contexts).
4. Respect phase boundaries — build what was asked, not what's next.
5. Keep changes focused and minimal; avoid drive-by refactors.
6. Avoid new dependencies unless clearly necessary and approved.
7. Don't invent requirements the user didn't state.
8. Don't silently change architecture — say so and why, first.
9. Protect tenant isolation in every service/query you touch.
10. Protect secrets — never commit `.env`, never print credentials.
11. Test before declaring something done; say exactly what you tested.
12. Report known limitations honestly, don't paper over gaps.
13. Never commit or push without explicit instruction.
14. Ask before a significant architectural change.
15. Prefer the smallest correct implementation over the most general one.
