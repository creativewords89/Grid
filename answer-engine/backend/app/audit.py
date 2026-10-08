"""History of changes (SPEC section 6.12): who did what, with field-level changes."""

from collections.abc import Mapping
from typing import Any

from sqlalchemy.orm import Session

from app.db.models import AuditEntry, User


def diff(before: Mapping[str, Any], after: Mapping[str, Any]) -> list[dict[str, Any]]:
    """`[{field, from, to}]` for every key whose value changed."""
    return [
        {"field": key, "from": before.get(key), "to": after.get(key)}
        for key in after
        if before.get(key) != after.get(key)
    ]


def record(
    db: Session,
    actor: User | None,
    action: str,
    entity: str,
    entity_id: object = None,
    title: str | None = None,
    changes: list[dict[str, Any]] | None = None,
) -> None:
    """Add an audit row to the current transaction. `actor` None means the system."""
    db.add(
        AuditEntry(
            actor_id=actor.id if actor else None,
            action=action,
            entity=entity,
            entity_id=str(entity_id) if entity_id is not None else None,
            title=title[:255] if title else None,
            changes=changes or [],
        )
    )
