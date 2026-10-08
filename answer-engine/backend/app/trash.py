"""Trash (SPEC section 6.12): restore or delete forever, by kind of item.

Only files exist so far; verified answers, threads and conversations join in later steps.
"""

from collections.abc import Callable
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import settings_store
from app.auth.tokens import now
from app.db.models import StoredFile, TrashItem, TrashKind, User
from app.files import service as files

Restore = Callable[[Session, TrashItem, User], None]
Purge = Callable[[Session, TrashItem, User | None], None]


def _restore_file(db: Session, item: TrashItem, by: User) -> None:
    record = db.get(StoredFile, item.ref_id)
    if record is not None:
        files.restore(db, record, by)


def _purge_file(db: Session, item: TrashItem, by: User | None) -> None:
    record = db.get(StoredFile, item.ref_id)
    if record is not None:
        files.purge(db, record, by)


HANDLERS: dict[TrashKind, tuple[Restore, Purge]] = {
    TrashKind.FILE: (_restore_file, _purge_file),
}


def restore(db: Session, item: TrashItem, by: User) -> None:
    HANDLERS[item.kind][0](db, item, by)
    db.delete(item)


def purge(db: Session, item: TrashItem, by: User | None) -> None:
    HANDLERS[item.kind][1](db, item, by)
    db.delete(item)


def purge_expired(db: Session) -> int:
    days = settings_store.get_int(db, "trash_days")
    expired = db.scalars(
        select(TrashItem).where(TrashItem.deleted_at < now() - timedelta(days=days))
    ).all()
    for item in expired:
        purge(db, item, None)
    return len(expired)
