"""Trash (SPEC section 6.12): restore or delete forever, by kind of item.

Files, conversations, verified answers and marketing threads.
"""

from collections.abc import Callable
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import settings_store
from app.auth.tokens import now
from app.db.models import (
    Conversation,
    StoredFile,
    Thread,
    TrashItem,
    TrashKind,
    User,
    VerifiedAnswer,
)
from app.files import service as files
from app.verified import service as verified

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


def _restore_verified(db: Session, item: TrashItem, by: User) -> None:
    va = db.get(VerifiedAnswer, item.ref_id)
    if va is not None:
        verified.restore(db, va, by)


def _purge_verified(db: Session, item: TrashItem, by: User | None) -> None:
    va = db.get(VerifiedAnswer, item.ref_id)
    if va is not None:
        verified.purge(db, va, by)


def _thread(db: Session, item: TrashItem) -> Thread | None:
    thread_id = (item.data or {}).get("thread_id")
    return db.get(Thread, thread_id) if thread_id else None


def _restore_thread(db: Session, item: TrashItem, by: User) -> None:
    thread = _thread(db, item)
    if thread is not None:
        thread.deleted_at = None


def _purge_thread(db: Session, item: TrashItem, by: User | None) -> None:
    # Its messages go with it; the drafts' answers stay in the Answer Log.
    thread = _thread(db, item)
    if thread is not None:
        db.delete(thread)


HANDLERS: dict[TrashKind, tuple[Restore, Purge]] = {
    TrashKind.FILE: (_restore_file, _purge_file),
    TrashKind.CONVERSATION: (_restore_conversation, _purge_conversation),
    TrashKind.VERIFIED_ANSWER: (_restore_verified, _purge_verified),
    TrashKind.THREAD: (_restore_thread, _purge_thread),
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
