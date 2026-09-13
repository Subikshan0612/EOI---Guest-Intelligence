"""
Pydantic models for the operational context Node sends to this service.

These mirror the exact output shape of the existing Node
`assembleSignalContext(signalId, workspaceId)` (backend/src/services/
signalContextService.js) field-for-field. This service never reconstructs
or re-queries this data — it only validates the shape of what Node already
assembled and already scoped to one workspace.

Deliberately excluded, and enforced via `extra="forbid"`: `workspaceId`,
any MongoDB internal field (`_id`, `__v`), and any other field not already
part of Node's own context contract. If Node ever accidentally sent one of
those, this model rejects the request rather than silently accepting it.
"""

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class StayFact(BaseModel):
    """A Stay as it appears either as a Signal's own linked stay, or inside
    a Guest's `recentStays`. `available=False` means the referenced Stay
    document could not be resolved (deleted, or never existed) — in that
    case every field below `available` is absent, exactly as Node sends it."""

    model_config = ConfigDict(extra="forbid")

    id: Optional[str] = None
    available: bool
    guestId: Optional[str] = None
    propertyId: Optional[str] = None
    unitId: Optional[str] = None
    reservationId: Optional[str] = None
    checkIn: Optional[str] = None
    checkOut: Optional[str] = None
    status: Optional[str] = None
    adults: Optional[int] = None
    children: Optional[int] = None
    source: Optional[str] = None


class GuestFact(BaseModel):
    """`available=False` means the referenced Guest document could not be
    resolved — `recentStays` is still populated in that case (Node derives
    it independently of whether the Guest document itself still exists)."""

    model_config = ConfigDict(extra="forbid")

    id: Optional[str] = None
    available: bool
    firstName: Optional[str] = None
    lastName: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    recentStays: list[StayFact] = Field(default_factory=list)


class PropertyFact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: Optional[str] = None
    available: bool
    name: Optional[str] = None
    code: Optional[str] = None
    address: Optional[str] = None
    timezone: Optional[str] = None
    status: Optional[str] = None


class UnitFact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: Optional[str] = None
    available: bool
    unitNumber: Optional[str] = None
    type: Optional[str] = None
    status: Optional[str] = None
    propertyId: Optional[str] = None


class SignalFact(BaseModel):
    """The Signal itself — always present; every field is a stored fact,
    never an interpretation."""

    model_config = ConfigDict(extra="forbid")

    id: str
    type: str
    source: str
    severity: str
    status: str
    title: str
    description: str = ""
    occurredAt: Optional[str] = None
    detectedAt: Optional[str] = None
    propertyId: Optional[str] = None
    unitId: Optional[str] = None
    guestId: Optional[str] = None
    stayId: Optional[str] = None
    createdAt: Optional[str] = None
    updatedAt: Optional[str] = None


class HistorySignal(BaseModel):
    """One related historical Signal — relational relevance, not semantic
    search. `matchedBy` names which relationship(s) surfaced it (stay/guest/
    unit/property)."""

    model_config = ConfigDict(extra="forbid")

    id: str
    type: str
    severity: str
    status: str
    title: str
    occurredAt: Optional[str] = None
    matchedBy: list[str] = Field(default_factory=list)


class SignalHistory(BaseModel):
    model_config = ConfigDict(extra="forbid")

    signals: list[HistorySignal] = Field(default_factory=list)


class SignalContext(BaseModel):
    """The full context object — identical in shape to what
    `GET /api/signals/:id/context` already returns to the frontend today.
    No `workspaceId` field exists here by design: this service never needs
    it and must never receive it."""

    model_config = ConfigDict(extra="forbid")

    signal: SignalFact
    guest: Optional[GuestFact] = None
    stay: Optional[StayFact] = None
    property: Optional[PropertyFact] = None
    unit: Optional[UnitFact] = None
    history: SignalHistory
