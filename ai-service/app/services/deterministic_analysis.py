"""
Deterministic Intelligence V1 analysis - used when this service's own
LLM_PROVIDER is "test" (see app/routers/analysis.py). It calls no model and no
network. It derives a fixed, reproducible analysis purely from the fields
actually present in the supplied context and knowledge, and it says so
plainly wherever a fact is absent. It never invents a fact, policy, guest
history, or an action already taken.

It does no relevance judgment (it is not a model): every supplied knowledge
chunk is reported as used, and confidence is a fixed evidence-quality rule -
"medium" when documented guidance was supplied, "low" when none was. It never
returns "high": only a real judgment of directly relevant evidence could.
"""

from app.models.analysis import AnalysisResponse, Claim, EvidenceRef
from app.models.context import SignalContext
from app.models.intelligence import KnowledgeItem, Provenance
from app.models.learning import LearningContext
from app.models.operational_history import OperationalHistory
from app.services.evidence_envelope import build_catalog

STUB_MARKER = "[DETERMINISTIC TEST ANALYSIS]"
_DESCRIPTION_LIMIT = 300
_MAX_HISTORY_REFS = 2  # per historical kind, and for related history signals - keeps the deterministic
# total well under AnalysisResponse's evidenceRefs ceiling without needing to know that ceiling here.


def _operational_refs(context: SignalContext) -> list[EvidenceRef]:
    """Phase 28: exactly the operational identifiers the stub ALSO reported in prose above - every one of
    these is, by construction, a field this same context object actually carries, so it always survives
    Node's authorization check. The stub never invents a reference to anything not already in `context`."""
    refs = [EvidenceRef(type="operational", field="signal", refId=context.signal.id)]
    if context.property and context.property.available:
        refs.append(EvidenceRef(type="operational", field="property", refId=context.property.id))
    if context.unit and context.unit.available:
        refs.append(EvidenceRef(type="operational", field="unit", refId=context.unit.id))
    if context.guest and context.guest.available:
        refs.append(EvidenceRef(type="operational", field="guest", refId=context.guest.id))
    if context.stay and context.stay.available:
        refs.append(EvidenceRef(type="operational", field="stay", refId=context.stay.id))
    for signal in context.history.signals[:_MAX_HISTORY_REFS]:
        refs.append(EvidenceRef(type="operational", field="historySignal", refId=signal.id))
    return refs


def _historical_refs(operational_history: OperationalHistory | None) -> list[EvidenceRef]:
    if operational_history is None:
        return []
    refs = [EvidenceRef(type="historical", kind="prior_ai_analysis", signalId=h.signalId) for h in operational_history.intelligence[:_MAX_HISTORY_REFS]]
    refs += [EvidenceRef(type="historical", kind="human_reviewed_decision", signalId=h.signalId) for h in operational_history.decisions[:_MAX_HISTORY_REFS]]
    return refs


def _claims(
    context: SignalContext,
    knowledge: list[KnowledgeItem],
    operational_history: OperationalHistory | None,
    learning_context: LearningContext | None,
    recommendation: str,
) -> list[Claim]:
    """Phase 34C: the stub's claims, built ONLY from references that exist in the evidence catalog for this request
    (the same catalog the prompt shows a real model). It states no urgency and no action type - it does no reasoning,
    so it cannot honestly choose them; Node accepts that absence only for this deterministic test identity, in
    development/test (backend/src/services/ai/safetyPolicy.js)."""
    available = {item.ref for item in build_catalog(context, knowledge, operational_history, learning_context)}
    signal_ref = f"current:signal:{context.signal.id}"
    if signal_ref not in available:
        return []
    signal = context.signal
    claims = [
        Claim(
            claimType="FACT",
            text=f"{STUB_MARKER} The Signal is recorded with type '{signal.type}', severity '{signal.severity}' and status '{signal.status}'.",
            sourceRefs=[signal_ref],
        )
    ]
    knowledge_refs = [ref for ref in (f"knowledge:{item.chunkId}" for item in knowledge[:6]) if ref in available]
    if knowledge_refs:
        claims.append(Claim(claimType="BUSINESS_GUIDANCE", text=f"{STUB_MARKER} Documented guidance was retrieved for this Signal.", sourceRefs=knowledge_refs))
    claims.append(Claim(claimType="RECOMMENDATION", text=recommendation[:500], sourceRefs=[signal_ref, *knowledge_refs][:8]))
    return claims


def _location(context: SignalContext) -> str:
    parts: list[str] = []
    if context.property and context.property.available and context.property.name:
        parts.append(context.property.name)
    if context.unit and context.unit.available and context.unit.unitNumber:
        parts.append(f"Unit {context.unit.unitNumber}")
    return ", ".join(parts) if parts else "an unspecified location"


def _path_label(item: KnowledgeItem) -> str:
    return " > ".join(item.sectionPath) or item.section or "(no section heading)"


def generate_deterministic_analysis(
    context: SignalContext,
    knowledge: list[KnowledgeItem] | None = None,
    operational_history: OperationalHistory | None = None,
    learning_context: LearningContext | None = None,
) -> AnalysisResponse:
    knowledge = knowledge or []
    signal = context.signal

    evidence = [
        f"Signal '{signal.title}': type '{signal.type}', severity '{signal.severity}', status '{signal.status}', source '{signal.source}'.",
    ]
    description = (signal.description or "").strip()
    if description:
        shown = description if len(description) <= _DESCRIPTION_LIMIT else description[:_DESCRIPTION_LIMIT] + "..."
        evidence.append(f"Signal description: {shown}")

    if context.guest is None:
        evidence.append("No guest is linked to this Signal.")
    elif not context.guest.available:
        evidence.append("The linked guest record is unavailable.")
    else:
        evidence.append("A guest record is linked to this Signal.")

    if context.stay is None:
        evidence.append("No stay is linked to this Signal.")
    elif not context.stay.available:
        evidence.append("The linked stay record is unavailable.")
    else:
        evidence.append(f"A stay is linked to this Signal (status '{context.stay.status}').")

    evidence.append(f"{len(context.history.signals)} related historical Signal(s) were supplied.")
    if operational_history is not None:
        # Counts only: the stub is not a model and never repeats historical text as a fact.
        evidence.append(
            f"{len(operational_history.intelligence)} prior analysis record(s) and "
            f"{len(operational_history.decisions)} reviewed decision(s) were supplied as unverified history."
        )
    if learning_context is not None:
        # Phase 32: a COUNT-ONLY note, exactly like the operational_history line above. The stub does no
        # reasoning, so Learning's successRate/eligible values never change `confidence` or `recommendation`
        # here - this line is the entire effect Learning has on the deterministic (test-provider) path. There
        # is deliberately no "learning" evidenceRef type (see app/models/analysis.py's closed EvidenceType), so
        # this note can never be cited as a structured reference - it is prose context only.
        eligible_count = sum(1 for p in learning_context.patterns if p.eligible)
        evidence.append(
            f"{len(learning_context.patterns)} historical Learning pattern(s) ({eligible_count} at/above the "
            f"minimum sample size of {learning_context.minimumSampleSize}) were supplied as bounded historical "
            "aggregate context - not evidence about this Signal."
        )

    if knowledge:
        for item in knowledge[:6]:
            evidence.append(f"Documented guidance retrieved: '{_path_label(item)}'.")
        sections = "; ".join(_path_label(item) for item in knowledge[:6])
        recommendation = (
            f"{STUB_MARKER} Consider following the documented guidance in: {sections}. "
            "This is a recommendation only; this analysis has not taken or requested any action."
        )
        confidence = "medium"
    else:
        evidence.append("No relevant documented Business Knowledge was retrieved for this Signal.")
        recommendation = (
            f"{STUB_MARKER} A person could consider reviewing this Signal's recorded details and confirming the "
            "next step with the responsible staff. No documented guidance was retrieved for this Signal. This is a "
            "recommendation only; this analysis has not taken or requested any action."
        )
        confidence = "low"

    return AnalysisResponse(
        situation=f"{STUB_MARKER} Signal '{signal.title}' at {_location(context)}.",
        evidence=evidence[:12],
        impact=(
            f"{STUB_MARKER} The Signal records severity '{signal.severity}'. Any further impact is not "
            "available in the supplied context."
        ),
        recommendation=recommendation,
        confidence=confidence,
        usedKnowledgeChunkIds=[item.chunkId for item in knowledge],
        provenance=Provenance(provider="test", model="deterministic-stub"),
        # Phase 28: structural references for exactly the operational/historical facts cited above, plus one
        # knowledge reference per chunk shown in the recommendation (bounded the same way, `knowledge[:6]`).
        # `contradictions` stays empty: the stub does no reasoning, so it makes no contradiction claim - a
        # real judgment of conflicting evidence needs a real model (see gemini_analysis_client.py).
        evidenceRefs=[*_operational_refs(context), *_historical_refs(operational_history), *[EvidenceRef(type="knowledge", chunkId=item.chunkId) for item in knowledge[:6]]],
        contradictions=[],
        claims=_claims(context, knowledge, operational_history, learning_context, recommendation),
    )
