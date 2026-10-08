"""Trash (SPEC section 6.12): restore or delete forever, by kind of item.

Files and conversations so far; verified answers and threads join in later steps.
"""

from collections.abc import Callable
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import settings_store
from app.auth.tokens import now
from app.db.models import Conversation, StoredFile, TrashItem, TrashKind, User
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


def _restore_conversation(db: Session, item: TrashItem, by: User) -> None:
    conversation = db.get(Conversation, item.ref_id)
    if conversation is not None:
        conversation.deleted_at = None


def _purge_conversation(db: Session, item: TrashItem, by: User | None) -> None:
    # Messages go with it; the answers stay in the Answer Log.
    conversation = db.get(Conversation, item.ref_id)
    if conversation is not None:
        db.delete(conversation)


HANDLERS: dict[TrashKind, tuple[Restore, Purge]] = {
    TrashKind.FILE: (_restore_file, _purge_file),
    TrashKind.CONVERSATION: (_restore_conversation, _purge_conversation),
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
