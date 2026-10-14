# Conversational Signal intake (Phase 47): conversation -> signal -> context -> intelligence

Scope: how an operator describes an operational event in plain language and gets a REAL Signal, its Context, and (on an explicit click) Intelligence - using only the
existing architecture. Decision -> Action -> Outcome -> Learning are **not** part of this phase.

```
Operator text  ->  POST /api/conversations/intake  ->  Signal (same createSignal as the form)  ->  GET /signals/:id/context  ->  [click] POST /api/intelligence/analyze/:signalId
 (untrusted)        auth -> membership -> operations:manage     deterministic interpreter, NO model            existing context            existing pipeline, RAG, guards, persistence
```

## What was reused (nothing was duplicated)

| Need | Existing code reused |
|---|---|
| Signal | `models/Signal.js`, `services/signalService.js createSignal` - the conversational and the structured path create the **same** Signal |
| Conversation / messages | `models/Conversation.js` (`signalIds`), `models/Message.js`, `messageService.createServerMessage` (assistant messages are server-only; a browser cannot create them) |
| Authorization / tenancy | `requireAccess("operations:manage")`, `req.actor.workspaceId`, `findInWorkspaceOr404` |
| Context | `GET /api/signals/:id/context` (deterministic assembly) and, inside generation, `buildOperationalContext` with the evidence classes |
| Business knowledge / RAG | the existing retrieval (`knowledgeRetrievalService`), reached only from `POST /api/intelligence/analyze/:signalId` |
| Intelligence | the one existing generation endpoint, the persisted-analysis read (`GET /api/intelligence?signalId=`), `mapIntelligenceAnalysis`, `SafetyAssessment`, `AnalysisBlock`, `RecommendationBlock` |
| Guards | evidence envelope, claim validation, safety policy, confidence ceiling, prose guard, output guard, retrieval budget, audit admission - **untouched** |

New code: `services/signalInterpreter.js` (pure), `services/signalIntakeService.js`, one route + one controller function, and the frontend `features/assistant/*`, `pages/AssistantPage.jsx`, `styles/assistant.css`. **No new model, collection, AI client, retrieval or vector store.**

## The intake turn

`POST /api/conversations/intake` `{ workspaceId (selector), conversationId?, content }` -> `operations:manage` (the same permission as creating a Signal; viewers read conversations but cannot record).

1. The conversation is resolved **inside the verified workspace** (another tenant's id is the same 404); none given -> one is created.
2. The server stores the user message and runs the **interpreter** (deterministic, no model, no database, no network):
   * extracts only what was written: a unit number that matches a real Unit of this workspace (a property named by its real name/code), a type from a closed keyword list, a severity **only if stated in words**; title = the operator's first sentence, description = the operator's own words;
   * never invents a property, room, guest, stay, severity, cause, diagnosis, status or timestamp; a guest or stay is never linked from chat;
   * missing location -> **one** question ("Which property or room is this regarding?"), nothing created; an unknown room asks for the property; the same room number in two properties asks which; a place with no event asks "What happened in ...?";
   * the answer is read together with the question that was asked (state is held only in the **server-written** assistant message; a user-supplied lookalike is never read); a complete new report always stands alone.
3. Ready -> `createSignal` (source `staff`, `metadata.intake` records only HOW it was recorded) and `Conversation.signalIds`; the assistant message carries `koiIntake` for the UI.

## Chat is untrusted

The text is data. A closed pattern list recognises attempts to change role / workspace / permissions / safety rules / instructions or to run an action: with no complete event behind them they are **declined with one fixed sentence** and nothing is created; inside a genuine report they stay the report's words (flagged "not followed") and the analysis pipeline already treats a Signal's text as `UNTRUSTED_SIGNAL`. The workspace and role are never read from the body.

## Cost control

Typing, sending, opening, refreshing and reading context make **no AI call** (proved with a counting proxy in front of the AI service: zero analysis / retrieval / embedding requests). Intelligence is only the explicit **Generate Intelligence** click -> the existing endpoint (idempotent per workspace + signal + level: asking again returns the stored analysis with no model call).

## UI

`/assistant[/:conversationId]` ("Assistant" in the sidebar and a link on the landing page). The loop is visible (Conversation, Signal, Context, Intelligence, then Decision, Action, Outcome, Learning marked "Next" and inert). Each recorded Signal shows SIGNAL, CONTEXT (what the context endpoint returned; operating guidance only **after** generation, as human-readable section titles) and INTELLIGENCE (the existing safety / recommendation / confidence blocks). No id, evidence reference, chunk, score, rule code or provider text is displayed; failures use fixed sentences.

## Verified

`scripts/validate-phase47-conversational-signal.mjs` (55 checks; real ai-service in test mode behind a counting proxy, throwaway DB) and a real-browser run against **real Gemini** (model `gemini-3.1-flash-lite`): 5 chat turns and 3 refreshes caused 0 model calls; each explicit click caused exactly 1 (3 total).

## Honest limits

* The interpreter is deliberately a **small closed vocabulary**, not language understanding: reports outside it get a clarifying question or are recorded as type `other`; it does not resolve typos or other languages.
* A severity is recorded only if the operator writes it; otherwise the schema default is stored and the UI says "not specified".
* A guest/stay is never linked from chat; linking stays a structured action.
* The conversation list is workspace-shared (existing Phase 18 model).
* The AI endpoints share a per-identity limit (10/min): authoring several knowledge documents and generating in the same minute can answer "service is busy" (a fixed message; retry after a moment).
