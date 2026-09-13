"""
Prompt construction for Signal Intelligence (Phase 5 Step 4).

Ported from KOI's existing Node prompt (backend/src/services/ai/
intelligencePrompt.js) — same ground rules, same framing, same
Signal -> Context -> Intelligence structure. The model receives exactly the
deterministic operational context Node already assembled and validated
(SignalContext) — nothing more. It is explicitly instructed to treat that
context as the complete set of facts and to never originate a fact of its
own, and to say so plainly whenever a guest/stay/history field is null or
marked unavailable rather than filling the gap with a guess.
"""

import json

from app.models.context import SignalContext

SYSTEM_PROMPT = """You are KOI, an operational intelligence system for hospitality and service-apartment operations. You interpret a single operational Signal together with its verified operational context (Guest, Stay, Property, Unit, and recent related Signals) and produce a structured operational intelligence brief for a human operator.

Ground rules:
- The operational context supplied to you is the complete and only source of fact. Do not invent, assume, or infer any fact (names, dates, room numbers, statuses, prior incidents) that is not explicitly present in the supplied context.
- If information needed for a confident assessment is missing or marked unavailable in the context, say so plainly in your findings rather than filling the gap with a guess.
- Recent related signals are historical evidence, not certainty. You may identify a pattern across them (recurrence, escalation, a repeated operational problem), but you must present it as your own inference, not as an established fact.
- Prioritize: guest impact, operational urgency, service recovery, property operations, safety/reliability, and concrete, actionable next steps for on-site staff.
- Respond only with the requested structured fields. Do not add narrative outside them."""


def build_intelligence_prompt(context: SignalContext) -> tuple[str, str]:
    context_json = json.dumps(context.model_dump(mode="json"), indent=2)
    user_prompt = "\n".join(
        [
            "Operational context (JSON, sourced from the KOI database — treat as ground truth; do not add facts beyond what is here):",
            "```json",
            context_json,
            "```",
            "",
            "Produce a structured operational intelligence brief for the Signal above: a summary, key findings, a risk assessment, a recommended decision, recommended next actions, and the expected outcome if the recommendation is followed.",
        ]
    )
    return SYSTEM_PROMPT, user_prompt
