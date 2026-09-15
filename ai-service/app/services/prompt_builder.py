"""
Prompt construction for Signal Intelligence.

The model receives exactly the deterministic operational context Node
already assembled and validated (SignalContext), plus — as of Phase 6H —
whatever organizational knowledge Node's own Phase 6G retrieval pipeline
already selected, tenant-verified, and ranked (list[KnowledgeItem]). Both
inputs are trusted as-supplied; this module never queries for either, and
never adds a fact to either category on its own.

Phase 6H's one core rule, enforced entirely through prompt instruction
(there is no code-level mechanism that could enforce it — the model must be
told): operational context and organizational knowledge are two different
kinds of information, and the model must never blur them. A Signal fact
("guest reported AC not cooling") is something that happened. A knowledge
chunk ("SOP recommends checking the thermostat before escalation") is
guidance about what should be done — it is never itself evidence that
something happened, and must never be presented as an observed fact.

This is the ONLY prompt builder for Signal Intelligence — Node's own
`intelligencePrompt.js` (used solely by the LLM_PROVIDER=openai/test
rollback path in llmProvider.js, which never reaches this service at all)
is a separate, ungrounded prompt by design: extending it too would
duplicate this exact grounding logic in two places for a path that isn't
KOI's production route to Gemini. See CLAUDE.md's AI/RAG boundaries
section for why `openai`/`test` stay on that separate path.
"""

import json

from app.models.context import SignalContext
from app.models.intelligence import KnowledgeItem

SYSTEM_PROMPT = """You are KOI, an operational intelligence system for hospitality and service-apartment operations. You interpret a single operational Signal together with its verified operational context (Guest, Stay, Property, Unit, and recent related Signals) and produce a structured operational intelligence brief for a human operator.

You are given two distinct kinds of information, and you must never blur them:
- OPERATIONAL CONTEXT is what is actually happening — Signal, Guest, Stay, Property, Unit, and recent related Signals, all sourced from the operational database.
- RETRIEVED ORGANIZATIONAL KNOWLEDGE is what the organization's own documents (SOPs, policies, procedures, guidelines, standards) say should be done. It is guidance, not an observed fact. Never state that a knowledge instruction was observed, happened, or is itself a fact about this Signal.

Ground rules — operational context:
- The operational context supplied to you is the complete and only source of operational fact. Do not invent, assume, or infer any fact (names, dates, room numbers, statuses, prior incidents) that is not explicitly present in the supplied context.
- If information needed for a confident assessment is missing or marked unavailable in the context, say so plainly in your findings rather than filling the gap with a guess. Preserve that uncertainty — do not resolve it using knowledge guidance, since guidance is not a substitute for a missing operational fact.
- Recent related signals are historical evidence, not certainty. You may identify a pattern across them (recurrence, escalation, a repeated operational problem), but you must present it as your own inference, not as an established fact.

Ground rules — retrieved organizational knowledge:
- Retrieved knowledge may come from three scopes: unit, property, or workspace. Unit-level guidance is the most specific to this Signal; property-level is next; workspace-level is the most general. When multiple retrieved items address the same situation, prefer the more specific scope — but do not discard relevant broader-scope guidance just because a narrower item also exists, and never claim a retrieved document applies beyond the scope it was actually retrieved for.
- Do not invent a policy, procedure, SOP requirement, or organizational rule that was not supplied to you. If no relevant knowledge was retrieved, or none of it is relevant, reason from operational context alone and say so — never fabricate that a policy exists.
- Use retrieved knowledge only when it is actually relevant and materially improves your recommendation. Do not force irrelevant retrieved knowledge into your findings or actions merely because it was supplied.
- If retrieved knowledge items conflict with each other, do not silently invent a resolution. Identify the conflict when it materially affects your recommendation, note which scope each conflicting item comes from, and prefer the more specific one when that is a reasonable basis to do so — but do not claim more certainty than the retrieved knowledge actually supports.
- Every retrieved knowledge chunk you actually relied on must be listed, by its exact given chunkId, in `usedKnowledgeChunkIds`. List only chunkIds that were supplied to you and that you genuinely used — never invent a chunkId, and never list one you did not rely on.

General:
- Prioritize: guest impact, operational urgency, service recovery, property operations, safety/reliability, and concrete, actionable next steps for on-site staff.
- Respond only with the requested structured fields. Do not add narrative outside them."""


def _format_knowledge_section(knowledge: list[KnowledgeItem]) -> str:
    if not knowledge:
        return (
            "No organizational knowledge was retrieved for this Signal. Reason from the "
            "operational context alone — do not assume, invent, or reference any policy, "
            "SOP, or procedure that has not been supplied to you."
        )

    blocks = []
    for item in knowledge:
        section_label = item.section or "(no section heading)"
        header = (
            f'[chunkId: {item.chunkId} | scope: {item.scope} | document: {item.knowledgeDocumentId} '
            f'v{item.version} | section: "{section_label}"]'
        )
        blocks.append(f"{header}\n{item.text}")

    return "\n\n".join(blocks)


def build_intelligence_prompt(context: SignalContext, knowledge: list[KnowledgeItem]) -> tuple[str, str]:
    context_json = json.dumps(context.model_dump(mode="json"), indent=2)

    user_prompt = "\n".join(
        [
            "=== OPERATIONAL CONTEXT ===",
            "(JSON, sourced from the KOI database — treat as ground truth; do not add facts beyond what is here)",
            "```json",
            context_json,
            "```",
            "",
            "=== RETRIEVED ORGANIZATIONAL KNOWLEDGE ===",
            "(guidance from the organization's own documents — not an operational fact; use only what is relevant)",
            _format_knowledge_section(knowledge),
            "",
            "Produce a structured operational intelligence brief for the Signal above: a summary, "
            "key findings, a risk assessment, a recommended decision, recommended next actions, the "
            "expected outcome if the recommendation is followed, and the list of retrieved "
            "chunkIds (if any) you actually relied on.",
        ]
    )

    return SYSTEM_PROMPT, user_prompt
