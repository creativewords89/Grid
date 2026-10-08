"""`/api/trash`: restore or delete forever (Owner, SPEC sections 3 and 6.12)."""

import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app import settings_store, trash
from app.auth.deps import CurrentUser, Db
from app.db.models import TrashItem, TrashKind
from app.errors import ApiError
from app.permissions import Action, ensure

router = APIRouter(prefix="/trash", tags=["trash"])


class TrashOut(BaseModel):
    id: uuid.UUID
    kind: TrashKind
    ref_id: uuid.UUID
    title: str
    deleted_by: str | None
    deleted_at: datetime
    purge_at: datetime
    reason: str | None


def _get(db: Session, item_id: uuid.UUID) -> TrashItem:
    item = db.get(TrashItem, item_id)
    if item is None:
        raise ApiError(404, "not_found", "That item is no longer in the trash.")
    return item


@router.get("", response_model=list[TrashOut])
def list_trash(me: CurrentUser, db: Db) -> list[TrashOut]:
    ensure(me, Action.MANAGE_TRASH)
    keep = timedelta(days=settings_store.get_int(db, "trash_days"))
    items = db.scalars(
        select(TrashItem)
        .options(joinedload(TrashItem.deleter))
        .order_by(TrashItem.deleted_at.desc())
    ).all()
    return [
        TrashOut(
            id=item.id,
            kind=item.kind,
            ref_id=item.ref_id,
            title=item.title,
            deleted_by=item.deleter.name if item.deleter else None,
            deleted_at=item.deleted_at,
            purge_at=item.deleted_at + keep,
            reason=item.data.get("reason"),
        )
        for item in items
    ]


@router.post("/{item_id}/restore", status_code=204)
def restore(item_id: uuid.UUID, me: CurrentUser, db: Db) -> None:
    ensure(me, Action.MANAGE_TRASH)
    trash.restore(db, _get(db, item_id), me)
    db.commit()


@router.delete("/{item_id}", status_code=204)
def delete_forever(item_id: uuid.UUID, me: CurrentUser, db: Db) -> None:
    ensure(me, Action.MANAGE_TRASH)
    trash.purge(db, _get(db, item_id), me)
    db.commit()
