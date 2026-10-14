"""
Knowledge visibility levels, mirroring backend/src/services/knowledge/
visibility.js:

    guest < staff < restricted

A caller authorized at level L may see knowledge whose visibility is at most
L. Node is the authoritative enforcement point and filters BEFORE it ever
calls this service; this module only backs the defensive re-check the
retrieval and intelligence routers apply to what Node sent, so a Node bug can
never put above-level knowledge into a score or a prompt.

Fail closed: an unknown caller level is treated as "guest" (the lowest).
"""

from typing import Literal

Visibility = Literal["guest", "staff", "restricted"]

VISIBILITY_RANK: dict[str, int] = {"guest": 0, "staff": 1, "restricted": 2}


def is_visible(visibility: str, authorized_level: str) -> bool:
    """True when a caller at `authorized_level` may see knowledge marked `visibility`."""
    required = VISIBILITY_RANK.get(visibility, VISIBILITY_RANK["restricted"])
    allowed = VISIBILITY_RANK.get(authorized_level, VISIBILITY_RANK["guest"])
    return allowed >= required
