"""
Evidence reference authorization index (Phase 28) - the Python-side mirror of
backend/src/services/ai/evidenceReferenceIndex.js.

Pure, no I/O, no database. Built from the SAME `SignalContext` / `OperationalHistory` / knowledge chunk ids
this service was already given for the request. Used only as a DEFENSE-IN-DEPTH pre-filter in the Gemini
branch (gemini_analysis_client.py), which sees raw, untrusted model JSON - dropping an unauthorized
reference there means Node never even sees it. Node (analysisSchema.js) remains the sole AUTHORITATIVE,
fail-closed check: this module never replaces it, and the deterministic/test branch does not need it at all
(it only ever emits references it built itself from the same supplied data).
"""

from app.models.context import SignalContext
from app.models.operational_history import OperationalHistory


class EvidenceReferenceIndex:
    def __init__(self, context: SignalContext, operational_history: OperationalHistory | None, knowledge_chunk_ids: list[str]):
        self._operational: dict[str, set[str]] = {
            "signal": {context.signal.id} if context.signal and context.signal.id else set(),
            "property": {context.property.id} if context.property and context.property.available and context.property.id else set(),
            "unit": {context.unit.id} if context.unit and context.unit.available and context.unit.id else set(),
            "guest": {context.guest.id} if context.guest and context.guest.available and context.guest.id else set(),
            "stay": {context.stay.id} if context.stay and context.stay.available and context.stay.id else set(),
            "historySignal": {s.id for s in (context.history.signals if context.history else [])},
        }
        self._historical: dict[str, set[str]] = {
            "prior_ai_analysis": {h.signalId for h in (operational_history.intelligence if operational_history else [])},
            "human_reviewed_decision": {h.signalId for h in (operational_history.decisions if operational_history else [])},
        }
        self._knowledge: set[str] = set(knowledge_chunk_ids or [])

    def authorizes(self, ref) -> bool:
        if ref.type == "operational":
            return ref.refId in self._operational.get(ref.field, set())
        if ref.type == "historical":
            return ref.signalId in self._historical.get(ref.kind, set())
        if ref.type == "knowledge":
            return ref.chunkId in self._knowledge
        return False
