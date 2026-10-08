"""`/api/audit`: the history of changes (Owner, SPEC section 6.12; screen in step 14)."""

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import joinedload

from app.auth.deps import CurrentUser, Db
from app.db.models import AuditEntry
from app.permissions import Action, ensure

router = APIRouter(prefix="/audit", tags=["audit"])


class AuditOut(BaseModel):
    id: uuid.UUID
    actor: str | None
    action: str
    entity: str
    entity_id: str | None
    title: str | None
    changes: list[dict[str, Any]]
    at: datetime


@router.get("", response_model=list[AuditOut])
def list_audit(
    me: CurrentUser,
    db: Db,
    entity: Annotated[str | None, Query(max_length=50)] = None,
    before: datetime | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[AuditOut]:
    ensure(me, Action.MANAGE_SETTINGS)
    stmt = select(AuditEntry).options(joinedload(AuditEntry.actor))
    if entity:
        stmt = stmt.where(AuditEntry.entity == entity)
    if before:
        stmt = stmt.where(AuditEntry.at < before)
    rows = db.scalars(stmt.order_by(AuditEntry.at.desc(), AuditEntry.id.desc()).limit(limit)).all()
    return [
        AuditOut(
            id=row.id,
            actor=row.actor.name if row.actor else ("System" if row.actor_id is None else None),
            action=row.action,
            entity=row.entity,
            entity_id=row.entity_id,
            title=row.title,
            changes=row.changes,
            at=row.at,
        )
        for row in rows
    ]
