"""`/api/history`: who did what (SPEC sections 3, 5 and 7). Owners only."""

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.auth.deps import CurrentUser, Db
from app.db.models import AuditEntry
from app.permissions import Action, ensure

router = APIRouter(tags=["history"])

PAGE = 50


class EntryOut(BaseModel):
    id: uuid.UUID
    at: datetime
    actor: str | None  # None: the Hub itself
    action: str
    entity: str
    entity_id: str | None
    title: str | None
    changes: list[dict[str, Any]]

    @classmethod
    def of(cls, entry: AuditEntry) -> "EntryOut":
        return cls(
            id=entry.id,
            at=entry.at,
            actor=entry.actor.name if entry.actor else None,
            action=entry.action,
            entity=entry.entity,
            entity_id=entry.entity_id,
            title=entry.title,
            changes=entry.changes,
        )


class HistoryPage(BaseModel):
    entries: list[EntryOut]
    more: bool


@router.get("/history", response_model=HistoryPage)
def history(
    me: CurrentUser,
    db: Db,
    entity: Annotated[str | None, Query(max_length=50)] = None,
    before: datetime | None = None,
) -> HistoryPage:
    """Newest first, 50 at a time; `before` is the oldest `at` already shown."""
    ensure(me, Action.VIEW_HISTORY)
    query = (
        select(AuditEntry)
        .options(selectinload(AuditEntry.actor))
        .order_by(AuditEntry.at.desc(), AuditEntry.id.desc())
        .limit(PAGE + 1)
    )
    if entity:
        query = query.where(AuditEntry.entity == entity)
    if before:
        query = query.where(AuditEntry.at < before)
    found = db.scalars(query).all()
    return HistoryPage(entries=[EntryOut.of(e) for e in found[:PAGE]], more=len(found) > PAGE)
