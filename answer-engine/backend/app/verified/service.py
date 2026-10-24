"""Verified answers (SPEC section 6.9): questions and answers the team has confirmed.

Every change that affects search writes its Pinecone op to the outbox in the same
transaction (SPEC 6.4): active ones are upserted into the `verified` namespace, disabled,
expired and deleted ones are removed. The caller commits.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app import audit, settings_store
from app.answering.prompts import strip_citations
from app.auth.tokens import now
from app.db.models import (
    Answer,
    TrashItem,
    TrashKind,
    User,
    VerifiedAnswer,
    VerifiedAnswerVersion,
    VerifiedOrigin,
    VerifiedStatus,
)
from app.kb import outbox
from app.kb.store import VERIFIED, VectorStore

DUPLICATE_MATCH = 0.95
MAX_TEXT = 20000


class VerifiedError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def record_id(verified_id: uuid.UUID | str) -> str:
    return f"va_{verified_id}"


def id_of(record: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(record.removeprefix("va_"))
    except ValueError:
        return None


def is_live(va: VerifiedAnswer, at: datetime | None = None) -> bool:
    at = at or now()
    return (
        va.deleted_at is None
        and va.status == VerifiedStatus.ACTIVE
        and (va.expires_at is None or va.expires_at > at)
    )


def live_query() -> object:
    return select(VerifiedAnswer).where(
        VerifiedAnswer.deleted_at.is_(None),
        VerifiedAnswer.status == VerifiedStatus.ACTIVE,
        or_(VerifiedAnswer.expires_at.is_(None), VerifiedAnswer.expires_at > now()),
    )


def live_by_record(db: Session, records: list[str]) -> dict[str, VerifiedAnswer]:
    """Search results that may still be used, keyed by record id ("va_…")."""
    ids = [i for i in (id_of(r) for r in records) if i is not None]
    if not ids:
        return {}
    query = live_query().where(VerifiedAnswer.id.in_(ids))  # type: ignore[attr-defined]
    return {va.record_id: va for va in db.scalars(query)}


def all_live_records(db: Session) -> set[str]:
    return {va.record_id for va in db.scalars(live_query())}  # type: ignore[call-overload]


def search_text(va: VerifiedAnswer) -> str:
    return f"Q: {va.question}\nA: {va.answer}"


def _sync(db: Session, va: VerifiedAnswer) -> None:
    if is_live(va):
        outbox.upsert(db, VERIFIED, [va.record_id])
    else:
        outbox.delete(db, VERIFIED, [va.record_id])


def _version(db: Session, va: VerifiedAnswer, by: User | None) -> None:
    db.add(
        VerifiedAnswerVersion(
            verified_answer_id=va.id,
            version=va.version,
            question=va.question,
            answer=va.answer,
            changed_by=by.id if by else None,
        )
    )


def _check_text(question: str, answer: str) -> tuple[str, str]:
    question, answer = question.strip(), answer.strip()
    if not question or not answer:
        raise VerifiedError(422, "invalid", "Write both the question and the answer.")
    if len(question) > 2000 or len(answer) > MAX_TEXT:
        raise VerifiedError(422, "invalid", "That text is too long.")
    return question, answer


# --- creating from a reviewed answer ------------------------------------------------------


@dataclass(frozen=True)
class Duplicate:
    verified: VerifiedAnswer
    score: float


def find_duplicate(db: Session, store: VectorStore | None, question: str) -> Duplicate | None:
    """An existing verified answer to the same question (rerank score ≥ 0.95), if any."""
    if store is None:
        return None
    top_k = settings_store.get_int(db, "verified_top_k")
    model = str(settings_store.get(db, "rerank_model"))
    hits = store.search(VERIFIED, question, top_k, model, top_k)
    live = live_by_record(db, [hit.id for hit in hits])
    for hit in hits:
        if hit.id in live and hit.score >= DUPLICATE_MATCH:
            return Duplicate(live[hit.id], hit.score)
    return None


def for_answer(db: Session, answer: Answer) -> VerifiedAnswer | None:
    return db.scalar(
        select(VerifiedAnswer).where(
            VerifiedAnswer.origin_answer_id == answer.id, VerifiedAnswer.deleted_at.is_(None)
        )
    )


def from_answer(
    db: Session,
    answer: Answer,
    by: User,
    origin: VerifiedOrigin,
    update: VerifiedAnswer | None = None,
) -> VerifiedAnswer:
    """Create (or update) the verified answer for a reviewed answer. A second review of the
    same answer updates the verified answer it made before instead of adding another."""
    question = answer.retrieval_query.strip() or answer.question
    text = strip_citations(answer.current_text).strip()
    sources = sorted(
        {
            uuid.UUID(s["file_id"])
            for s in answer.sources
            if s.get("kind") == "doc" and s.get("file_id")
        },
        key=str,
    )
    existing = update or for_answer(db, answer)
    if existing is not None:
        existing.version += 1
        existing.question = question
        existing.answer = text
        existing.status = VerifiedStatus.ACTIVE
        existing.expires_at = None if is_expired(existing) else existing.expires_at
        existing.needs_check = False
        existing.needs_check_reason = None
        existing.approved_by = by.id
        existing.source_file_ids = sorted({*existing.source_file_ids, *sources}, key=str)
        va = existing
        action = "update"
    else:
        va = VerifiedAnswer(
            question=question,
            answer=text,
            status=VerifiedStatus.ACTIVE,
            origin=origin,
            origin_answer_id=answer.id,
            source_file_ids=sources,
            created_by=by.id,
            approved_by=by.id,
            version=1,
        )
        db.add(va)
        action = "create"
    db.flush()
    _version(db, va, by)
    _sync(db, va)
    audit.record(db, by, action, "verified_answer", va.id, va.question)
    return va


def is_expired(va: VerifiedAnswer) -> bool:
    return va.expires_at is not None and va.expires_at <= now()


def withdraw_for_answer(db: Session, answer: Answer, by: User) -> None:
    """The answer turned out wrong ("no answer known"): stop using what was verified from it."""
    va = for_answer(db, answer)
    if va is not None and va.status == VerifiedStatus.ACTIVE:
        set_status(db, va, by, VerifiedStatus.DISABLED)


# --- managing ------------------------------------------------------------------------------


def edit(
    db: Session,
    va: VerifiedAnswer,
    by: User,
    question: str | None = None,
    answer: str | None = None,
    *,
    change_expiry: bool = False,
    expires_at: datetime | None = None,  # with change_expiry; None = never expires
    checked: bool = False,
) -> VerifiedAnswer:
    before = {
        "question": va.question,
        "answer": va.answer,
        "expires_at": va.expires_at.isoformat() if va.expires_at else None,
        "needs_check": va.needs_check,
    }
    text_changed = False
    if question is not None or answer is not None:
        new_q, new_a = _check_text(
            question if question is not None else va.question,
            answer if answer is not None else va.answer,
        )
        text_changed = (new_q, new_a) != (va.question, va.answer)
        va.question, va.answer = new_q, new_a
    if change_expiry:
        va.expires_at = expires_at
        if va.status == VerifiedStatus.EXPIRED and not is_expired(va):
            va.status = VerifiedStatus.ACTIVE
        elif va.status == VerifiedStatus.ACTIVE and is_expired(va):
            va.status = VerifiedStatus.EXPIRED
    if checked or text_changed:
        va.needs_check = False
        va.needs_check_reason = None
    if text_changed:
        va.version += 1
        _version(db, va, by)
    after = {
        "question": va.question,
        "answer": va.answer,
        "expires_at": va.expires_at.isoformat() if va.expires_at else None,
        "needs_check": va.needs_check,
    }
    changes = audit.diff(before, after)
    if changes:
        audit.record(db, by, "update", "verified_answer", va.id, va.question, changes)
        _sync(db, va)
    return va


def set_status(db: Session, va: VerifiedAnswer, by: User | None, status: VerifiedStatus) -> None:
    if status == VerifiedStatus.ACTIVE and is_expired(va):
        raise VerifiedError(422, "expired", "Its expiry date has passed. Change the date first.")
    if va.status == status:
        return
    before = va.status.value
    va.status = status
    audit.record(
        db,
        by,
        "update",
        "verified_answer",
        va.id,
        va.question,
        [{"field": "status", "from": before, "to": status.value}],
    )
    _sync(db, va)


def restore_version(db: Session, va: VerifiedAnswer, by: User, version: int) -> VerifiedAnswer:
    old = db.scalar(
        select(VerifiedAnswerVersion).where(
            VerifiedAnswerVersion.verified_answer_id == va.id,
            VerifiedAnswerVersion.version == version,
        )
    )
    if old is None:
        raise VerifiedError(404, "not_found", "That version doesn't exist.")
    return edit(db, va, by, old.question, old.answer)


def delete(db: Session, va: VerifiedAnswer, by: User) -> None:
    va.deleted_at = now()
    db.add(
        TrashItem(
            kind=TrashKind.VERIFIED_ANSWER,
            ref_id=va.id,
            title=va.question[:255],
            deleted_by=by.id,
            deleted_at=va.deleted_at,
        )
    )
    audit.record(db, by, "delete", "verified_answer", va.id, va.question)
    outbox.delete(db, VERIFIED, [va.record_id])


def restore(db: Session, va: VerifiedAnswer, by: User) -> None:
    va.deleted_at = None
    if va.status == VerifiedStatus.ACTIVE and is_expired(va):
        va.status = VerifiedStatus.EXPIRED
    audit.record(db, by, "restore", "verified_answer", va.id, va.question)
    _sync(db, va)


def purge(db: Session, va: VerifiedAnswer, by: User | None) -> None:
    audit.record(db, by, "purge", "verified_answer", va.id, va.question)
    outbox.delete(db, VERIFIED, [va.record_id])  # in case it was restored and deleted again
    db.delete(va)


def expire_due(db: Session) -> int:
    """Daily: answers whose expiry date has passed stop being used (SPEC 6.9)."""
    due = db.scalars(
        select(VerifiedAnswer).where(
            VerifiedAnswer.status == VerifiedStatus.ACTIVE,
            VerifiedAnswer.expires_at.is_not(None),
            VerifiedAnswer.expires_at <= now(),
        )
    ).all()
    for va in due:
        set_status(db, va, None, VerifiedStatus.EXPIRED)
    return len(due)


def flag_source_gone(db: Session, file_id: uuid.UUID, file_name: str, replaced: bool) -> int:
    """A file a verified answer came from was deleted or replaced: someone should check it.
    It stays active (SPEC 6.9)."""
    affected = db.scalars(
        select(VerifiedAnswer).where(
            VerifiedAnswer.deleted_at.is_(None),
            VerifiedAnswer.status == VerifiedStatus.ACTIVE,
            VerifiedAnswer.source_file_ids.contains([file_id]),
        )
    ).all()
    reason = f"Source {'replaced by a new version' if replaced else 'deleted'}: {file_name}"
    for va in affected:
        va.needs_check = True
        va.needs_check_reason = reason
    return len(affected)
