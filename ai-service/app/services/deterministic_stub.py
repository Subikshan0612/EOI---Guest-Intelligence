"""
Deterministic stub intelligence generator.

Used when this service's own LLM_PROVIDER is "test" (see
app/routers/intelligence.py and app/config.py). This does NOT call Gemini,
or any other model — it derives a fixed, reproducible response purely from
the fields already present in the supplied context. It exists to prove the
Node <-> Python contract (request shape, response shape, error shape)
independently of any real model call, and remains available alongside the
real Gemini path added in Phase 5 Step 4 (app/services/gemini_client.py).

It must never invent a guest/property/stay fact that isn't already in the
context: every reference to context data below reads a field that was
actually supplied, and every place a fact is genuinely absent, the response
says so explicitly rather than guessing.
"""

from app.models.context import SignalContext
from app.models.intelligence import (
    Action,
    ActionStep,
    Decision,
    IntelligenceResponse,
    Outcome,
    Provenance,
    Risk,
)

STUB_MARKER = "[DETERMINISTIC TEST RESPONSE]"


def _location_description(context: SignalContext) -> str:
    parts: list[str] = []
    if context.property and context.property.available and context.property.name:
        parts.append(context.property.name)
    if context.unit and context.unit.available and context.unit.unitNumber:
        parts.append(f"Unit {context.unit.unitNumber}")
    return ", ".join(parts) if parts else "an unspecified location"


def generate_deterministic_intelligence(context: SignalContext) -> IntelligenceResponse:
    signal = context.signal
    location = _location_description(context)

    findings = [
        f"{STUB_MARKER} Signal '{signal.title}' has severity '{signal.severity}' and type '{signal.type}'.",
    ]

    if context.guest is None:
        findings.append(f"{STUB_MARKER} No guest is linked to this signal in the supplied context.")
    elif not context.guest.available:
        findings.append(f"{STUB_MARKER} The linked guest record is unavailable in the supplied context.")

    if context.stay is None:
        findings.append(f"{STUB_MARKER} No stay is linked to this signal in the supplied context.")
    elif not context.stay.available:
        findings.append(f"{STUB_MARKER} The linked stay record is unavailable in the supplied context.")

    findings.append(
        f"{STUB_MARKER} {len(context.history.signals)} related historical signal(s) were supplied."
    )

    return IntelligenceResponse(
        summary=f"{STUB_MARKER} {signal.title} at {location}.",
        findings=findings,
        risk=Risk(
            level="medium",
            reason=f"{STUB_MARKER} Fixed risk level — not a real assessment.",
        ),
        decision=Decision(
            recommendation=f"{STUB_MARKER} No real recommendation — this is a stub response.",
            rationale=(
                f"{STUB_MARKER} Generated deterministically from the supplied context, "
                "without calling any AI model."
            ),
        ),
        action=Action(
            label=f"{STUB_MARKER} No action required",
            recommended=[
                ActionStep(
                    step=f"{STUB_MARKER} Stub action step for contract verification only.",
                    priority="low",
                )
            ],
        ),
        outcome=Outcome(expected=f"{STUB_MARKER} No real outcome — this is a stub response."),
        confidence=0.5,
        provenance=Provenance(provider="test", model="deterministic-stub"),
    )
