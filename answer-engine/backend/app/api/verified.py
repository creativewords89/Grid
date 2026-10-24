"""`/api/verified`: the Verified Answers screen (SPEC sections 6.9 and 7.4).

Everyone can read them; Owners and Reviewers can edit, disable, set an expiry and delete.
"""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, StringConstraints
from sqlalchemy import select

from app.api.answer_log import Person
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.db.models import (
    StoredFile,
    User,
    VerifiedAnswer,
    VerifiedAnswerVersion,
    VerifiedStatus,
)
from app.errors import ApiError
from app.permissions import Action, can, ensure
from app.verified import service
from app.verified.service import VerifiedError

router = APIRouter(prefix="/verified", tags=["verified"])

Show = Literal["active", "disabled", "expired", "needs_check", "all"]


class VerifiedRow(BaseModel):
    id: uuid.UUID
    question: str
    answer: str
    status: str
    expires_at: datetime | None
    needs_check: bool
    needs_check_reason: str | None
    approved_by: Person | None
    origin: str
    version: int
    updated_at: datetime


class VerifiedDetail(VerifiedRow):
    sources: list[dict[str, Any]]
    origin_answer_id: uuid.UUID | None
    created_at: datetime
    can_manage: bool


class VerifiedPage(BaseModel):
    items: list[VerifiedRow]
    can_manage: bool
    counts: dict[str, int]


class VersionOut(BaseModel):
    version: int
    question: str
    answer: str
    changed_by: Person | None
    at: datetime


class PatchIn(Strict):
    question: Annotated[str, StringConstraints(max_length=2000)] | None = None
    answer: Annotated[str, StringConstraints(max_length=20000)] | None = None
    expires_at: datetime | None = None
    clear_expiry: bool = False
    checked: bool = False


class RestoreVersionIn(Strict):
    version: int


def _people(db: Db, ids: set[uuid.UUID | None]) -> dict[uuid.UUID, Person]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    rows = db.execute(select(User.id, User.name).where(User.id.in_(wanted))).all()
    return {r.id: Person(id=r.id, name=r.name) for r in rows}


def _shown_status(va: VerifiedAnswer) -> str:
    """Expired as soon as the date passes, even before the nightly job marks it."""
    if va.status == VerifiedStatus.ACTIVE and service.is_expired(va):
        return VerifiedStatus.EXPIRED.value
    return va.status.value


def _row(va: VerifiedAnswer, people: dict[uuid.UUID, Person]) -> dict[str, Any]:
    return {
        "id": va.id,
        "question": va.question,
        "answer": va.answer,
        "status": _shown_status(va),
        "expires_at": va.expires_at,
        "needs_check": va.needs_check,
        "needs_check_reason": va.needs_check_reason,
        "approved_by": people.get(va.approved_by) if va.approved_by else None,
        "origin": va.origin.value,
        "version": va.version,
        "updated_at": va.updated_at,
    }


def _get(db: Db, verified_id: uuid.UUID) -> VerifiedAnswer:
    va = db.get(VerifiedAnswer, verified_id)
    if va is None or va.deleted_at is not None:
        raise ApiError(404, "not_found", "That verified answer doesn't exist.")
    return va


def _raise(error: VerifiedError) -> ApiError:
    return ApiError(error.status, error.code, error.message)


@router.get("", response_model=VerifiedPage)
def list_verified(
    me: CurrentUser,
    db: Db,
    show: Show = "active",
    q: Annotated[str, Query(max_length=200)] = "",
) -> VerifiedPage:
    ensure(me, Action.VIEW_VERIFIED)
    every = db.scalars(
        select(VerifiedAnswer)
        .where(VerifiedAnswer.deleted_at.is_(None))
        .order_by(VerifiedAnswer.updated_at.desc())
    ).all()
    counts = {
        "active": sum(1 for v in every if _shown_status(v) == "active"),
        "disabled": sum(1 for v in every if _shown_status(v) == "disabled"),
        "expired": sum(1 for v in every if _shown_status(v) == "expired"),
        "needs_check": sum(1 for v in every if v.needs_check),
        "all": len(every),
    }
    if show == "needs_check":
        chosen = [v for v in every if v.needs_check]
    elif show == "all":
        chosen = list(every)
    else:
        chosen = [v for v in every if _shown_status(v) == show]
    words = q.strip().lower()
    if words:
        chosen = [v for v in chosen if words in v.question.lower() or words in v.answer.lower()]
    people = _people(db, {v.approved_by for v in chosen})
    return VerifiedPage(
        items=[VerifiedRow(**_row(v, people)) for v in chosen[:500]],
        can_manage=can(me, Action.MANAGE_VERIFIED),
        counts=counts,
    )


def detail(db: Db, va: VerifiedAnswer, me: User) -> VerifiedDetail:
    people = _people(db, {va.approved_by})
    files = {
        f.id: f for f in db.scalars(select(StoredFile).where(StoredFile.id.in_(va.source_file_ids)))
    }
    sources = [
        {
            "file_id": str(file_id),
            "name": files[file_id].name if file_id in files else "(removed)",
            "available": file_id in files and files[file_id].deleted_at is None,
        }
        for file_id in va.source_file_ids
    ]
    return VerifiedDetail(
        **_row(va, people),
        sources=sources,
        origin_answer_id=va.origin_answer_id,
        created_at=va.created_at,
        can_manage=can(me, Action.MANAGE_VERIFIED),
    )


@router.get("/{verified_id}", response_model=VerifiedDetail)
def get_verified(verified_id: uuid.UUID, me: CurrentUser, db: Db) -> VerifiedDetail:
    ensure(me, Action.VIEW_VERIFIED)
    return detail(db, _get(db, verified_id), me)


@router.patch("/{verified_id}", response_model=VerifiedDetail)
def update_verified(
    verified_id: uuid.UUID, body: PatchIn, me: CurrentUser, db: Db
) -> VerifiedDetail:
    ensure(me, Action.MANAGE_VERIFIED)
    va = _get(db, verified_id)
    change_expiry = body.clear_expiry or body.expires_at is not None
    if body.expires_at is not None and body.expires_at.tzinfo is None:
        raise ApiError(422, "invalid", "Give the expiry date with a time zone.")
    try:
        service.edit(
            db,
            va,
            me,
            body.question,
            body.answer,
            change_expiry=change_expiry,
            expires_at=None if body.clear_expiry else body.expires_at,
            checked=body.checked,
        )
    except VerifiedError as error:
        raise _raise(error) from None
    db.commit()
    db.refresh(va)
    return detail(db, va, me)


def _set(verified_id: uuid.UUID, me: User, db: Db, status: VerifiedStatus) -> VerifiedDetail:
    ensure(me, Action.MANAGE_VERIFIED)
    va = _get(db, verified_id)
    try:
        service.set_status(db, va, me, status)
    except VerifiedError as error:
        raise _raise(error) from None
    db.commit()
    db.refresh(va)
    return detail(db, va, me)


@router.post("/{verified_id}/disable", response_model=VerifiedDetail)
def disable(verified_id: uuid.UUID, me: CurrentUser, db: Db) -> VerifiedDetail:
    return _set(verified_id, me, db, VerifiedStatus.DISABLED)


@router.post("/{verified_id}/enable", response_model=VerifiedDetail)
def enable(verified_id: uuid.UUID, me: CurrentUser, db: Db) -> VerifiedDetail:
    return _set(verified_id, me, db, VerifiedStatus.ACTIVE)


@router.delete("/{verified_id}", status_code=204)
def delete_verified(verified_id: uuid.UUID, me: CurrentUser, db: Db) -> None:
    ensure(me, Action.MANAGE_VERIFIED)
    service.delete(db, _get(db, verified_id), me)
    db.commit()


@router.get("/{verified_id}/history", response_model=list[VersionOut])
def history(verified_id: uuid.UUID, me: CurrentUser, db: Db) -> list[VersionOut]:
    ensure(me, Action.VIEW_VERIFIED)
    va = _get(db, verified_id)
    versions = db.scalars(
        select(VerifiedAnswerVersion)
        .where(VerifiedAnswerVersion.verified_answer_id == va.id)
        .order_by(VerifiedAnswerVersion.version.desc())
    ).all()
    people = _people(db, {v.changed_by for v in versions})
    return [
        VersionOut(
            version=v.version,
            question=v.question,
            answer=v.answer,
            changed_by=people.get(v.changed_by) if v.changed_by else None,
            at=v.at,
        )
        for v in versions
    ]


@router.post("/{verified_id}/restore-version", response_model=VerifiedDetail)
def restore_version(
    verified_id: uuid.UUID, body: RestoreVersionIn, me: CurrentUser, db: Db
) -> VerifiedDetail:
    ensure(me, Action.MANAGE_VERIFIED)
    va = _get(db, verified_id)
    try:
        service.restore_version(db, va, me, body.version)
    except VerifiedError as error:
        raise _raise(error) from None
    db.commit()
    db.refresh(va)
    return detail(db, va, me)
