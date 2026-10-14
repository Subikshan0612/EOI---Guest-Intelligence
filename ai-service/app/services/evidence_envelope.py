"""
Evidence catalog (Phase 34C) - the citable references the model may use, each with its application-assigned class.

The AUTHORITATIVE evidence envelope lives in Node (backend/src/services/ai/evidenceEnvelope.js): Node decides what is
admissible and validates every reference the model returns against ITS OWN envelope, built from workspace-verified data.
This module only re-derives the same reference scheme from the exact objects Node already sent, so the prompt can show the
model which references exist. It cannot widen anything: a reference the model returns that is not in Node's envelope is
rejected by Node, whatever this module printed. A parity fixture (tests/fixtures/evidence_catalog_parity.json) is checked
by BOTH suites so the two derivations cannot drift apart unnoticed.

Classes, highest authority first (rank 1..5):

  CURRENT_OPERATIONAL_FACT   the recorded Signal and its resolved Property / Unit / Guest / Stay records. Authoritative.
  BUSINESS_KNOWLEDGE         retrieved, authorized organizational guidance. Establishes no current state.
  OPERATIONAL_HISTORY        earlier related Signals, prior AI analyses, reviewed decisions. Historical context only.
  LEARNING_CONTEXT           aggregate outcome statistics (only when the Learning flag is on). Advisory only.
  UNTRUSTED_SIGNAL           the free text typed into the Signal. Potentially adversarial; lowest authority.

Reference scheme (opaque to the model; ids come from the supplied data, never from the model):

  current:signal:<id>  current:property:<id>  current:unit:<id>  current:guest:<id>  current:stay:<id>
  untrusted:signal:<id>
  history:signal:<id>  history:analysis:<signalId>  history:decision:<signalId>
  knowledge:<chunkId>
  learning:<actionType>
"""

import re
from dataclasses import dataclass

from app.models.context import SignalContext
from app.models.intelligence import KnowledgeItem
from app.models.learning import LearningContext
from app.models.operational_history import OperationalHistory

CURRENT_OPERATIONAL_FACT = "CURRENT_OPERATIONAL_FACT"
BUSINESS_KNOWLEDGE = "BUSINESS_KNOWLEDGE"
OPERATIONAL_HISTORY = "OPERATIONAL_HISTORY"
LEARNING_CONTEXT = "LEARNING_CONTEXT"
UNTRUSTED_SIGNAL = "UNTRUSTED_SIGNAL"

# Authority, highest first. Mirrors EVIDENCE_PRECEDENCE in backend/src/services/ai/evidenceEnvelope.js.
EVIDENCE_PRECEDENCE = (CURRENT_OPERATIONAL_FACT, BUSINESS_KNOWLEDGE, OPERATIONAL_HISTORY, LEARNING_CONTEXT, UNTRUSTED_SIGNAL)

# An id that cannot be quoted safely inside a reference is skipped (never reshaped). Real ids are ObjectIds.
_SAFE_ID = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


@dataclass(frozen=True)
class EvidenceItem:
    ref: str
    evidence_class: str


def _ref(prefix: str, ident: object) -> str | None:
    return f"{prefix}:{ident}" if isinstance(ident, str) and _SAFE_ID.match(ident) else None


def build_catalog(
    context: SignalContext,
    knowledge: list[KnowledgeItem] | None = None,
    operational_history: OperationalHistory | None = None,
    learning: LearningContext | None = None,
) -> list[EvidenceItem]:
    """The ordered, de-duplicated list of references available for THIS request."""
    items: list[EvidenceItem] = []
    seen: set[str] = set()

    def add(ref: str | None, evidence_class: str) -> None:
        if ref and ref not in seen:
            seen.add(ref)
            items.append(EvidenceItem(ref, evidence_class))

    add(_ref("current:signal", context.signal.id), CURRENT_OPERATIONAL_FACT)
    for prefix, record in (("current:property", context.property), ("current:unit", context.unit), ("current:guest", context.guest), ("current:stay", context.stay)):
        if record is not None and record.available:
            add(_ref(prefix, record.id), CURRENT_OPERATIONAL_FACT)
    add(_ref("untrusted:signal", context.signal.id), UNTRUSTED_SIGNAL)
    for related in context.history.signals:
        add(_ref("history:signal", related.id), OPERATIONAL_HISTORY)
    if operational_history is not None:
        for prior in operational_history.intelligence:
            add(_ref("history:analysis", prior.signalId), OPERATIONAL_HISTORY)
        for decision in operational_history.decisions:
            add(_ref("history:decision", decision.signalId), OPERATIONAL_HISTORY)
    for chunk in knowledge or []:
        add(_ref("knowledge", chunk.chunkId), BUSINESS_KNOWLEDGE)
    if learning is not None:
        for pattern in learning.patterns:
            add(_ref("learning", pattern.actionType), LEARNING_CONTEXT)
    return items


def refs_of_class(catalog: list[EvidenceItem], evidence_class: str) -> list[str]:
    return [item.ref for item in catalog if item.evidence_class == evidence_class]
