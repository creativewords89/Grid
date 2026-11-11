"""`/api/fb`: the Facebook answers page (SPEC section 6.9a, step 27).

Owners and Reviewers answer the group's threads; only Owners load the data file. Users
don't see it: the comments carry commenters' names.
"""

import json
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, File, UploadFile
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import select

from app import settings_store
from app.answering.claude_answer import Answerer
from app.api.answer_log import Person
from app.api.conversations import NOT_SET_UP, answerer_dep
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.db.models import FbStatus, FbThread, User
from app.errors import ApiError
from app.facebook import service
from app.facebook.service import FbError
from app.files import storage
from app.permissions import Action, can, ensure

router = APIRouter(prefix="/fb", tags=["facebook"])


class ThreadRow(BaseModel):
    id: uuid.UUID
    key: str
    title: str
    topic: str
    subtopic: str
    status: str
    noise: bool
    rows: list[int]
    talk: int


class ThreadList(BaseModel):
    items: list[ThreadRow]
    counts: dict[str, int]
    can_load: bool


class AnswerItem(BaseModel):
    label: str = ""
    picks: list[str] = Field(default_factory=list)
    text: str = ""


class SavedAnswer(BaseModel):
    title: str
    items: list[AnswerItem]
    status: str
    answered_by: Person | None
    answered_at: datetime | None


class Post(BaseModel):
    row: int
    url: str
    author: str | None
    question: str
    summary: str
    note: str | None
    pinned: int
    comments: list[Any]
    picked: list[Any]


class Similar(BaseModel):
    id: uuid.UUID
    title: str
    status: str
    rows: list[int]
    items: list[AnswerItem]


class ThreadDetail(ThreadRow):
    posts: list[Post]
    similar: list[Similar]
    answer: SavedAnswer


class SaveIn(Strict):
    title: Annotated[str, StringConstraints(max_length=2000)] = ""
    items: list[dict[str, Any]] = Field(default_factory=list, max_length=20)
    status: Literal["draft", "approved", "skipped"]


class ReworkIn(Strict):
    mode: Literal["polish", "fit"]
    text: Annotated[str, StringConstraints(max_length=20000)]
    label: Annotated[str, StringConstraints(max_length=500)] = ""
    instruction: Annotated[str, StringConstraints(max_length=500)] = ""


class ReworkOut(BaseModel):
    answer: str
    changes: list[str]


class LoadOut(BaseModel):
    posts: int
    threads: int
    answers: int


def _raise(error: FbError) -> ApiError:
    return ApiError(error.status, error.code, error.message)


def _row(t: FbThread) -> dict[str, Any]:
    return {
        "id": t.id,
        "key": t.key,
        "title": t.answer_title or t.title,
        "topic": t.topic,
        "subtopic": t.subtopic,
        "status": t.status.value,
        "noise": t.noise,
        "rows": t.rows,
        "talk": t.talk,
    }


def _items(t: FbThread) -> list[AnswerItem]:
    return [
        AnswerItem(label=a.get("label") or "", picks=a.get("picks") or [], text=a.get("text") or "")
        for a in t.answers
    ]


def _thread(db: Db, thread_id: uuid.UUID) -> FbThread:
    try:
        return service.get(db, thread_id)
    except FbError as error:
        raise _raise(error) from None


def detail(db: Db, t: FbThread) -> ThreadDetail:
    person = None
    if t.answered_by:
        user = db.get(User, t.answered_by)
        person = Person(id=user.id, name=user.name) if user else None
    similar = []
    if t.similar and not t.noise:
        others = db.scalars(
            select(FbThread)
            .where(FbThread.similar == t.similar, FbThread.id != t.id, FbThread.noise.is_(False))
            .order_by(FbThread.talk.desc(), FbThread.key)
            .limit(40)
        ).all()
        similar = [
            Similar(
                id=o.id,
                title=o.answer_title or o.title,
                status=o.status.value,
                rows=o.rows,
                items=_items(o) if o.status in (FbStatus.DRAFT, FbStatus.APPROVED) else [],
            )
            for o in others
        ]
    posts = [
        Post(
            row=p.row,
            url=p.url,
            author=p.author,
            question=p.question,
            summary=p.summary,
            note=p.note,
            pinned=p.pinned,
            comments=p.comments,
            picked=p.picked,
        )
        for p in service.posts_of(db, t)
    ]
    return ThreadDetail(
        **_row(t),
        posts=posts,
        similar=similar,
        answer=SavedAnswer(
            title=t.answer_title or t.title,
            items=_items(t),
            status=t.status.value,
            answered_by=person,
            answered_at=t.answered_at,
        ),
    )


@router.get("/threads", response_model=ThreadList)
def list_threads(me: CurrentUser, db: Db) -> ThreadList:
    ensure(me, Action.WORK_FACEBOOK)
    threads = db.scalars(
        select(FbThread).order_by(FbThread.noise, FbThread.talk.desc(), FbThread.key)
    ).all()
    counts = {s.value: 0 for s in FbStatus}
    for t in threads:
        counts[t.status.value] += 1
    return ThreadList(
        items=[ThreadRow(**_row(t)) for t in threads],
        counts=counts,
        can_load=can(me, Action.IMPORT_VERIFIED),
    )


@router.get("/threads/{thread_id}", response_model=ThreadDetail)
def get_thread(thread_id: uuid.UUID, me: CurrentUser, db: Db) -> ThreadDetail:
    ensure(me, Action.WORK_FACEBOOK)
    return detail(db, _thread(db, thread_id))


@router.put("/threads/{thread_id}/answer", response_model=ThreadDetail)
def save_answer(thread_id: uuid.UUID, body: SaveIn, me: CurrentUser, db: Db) -> ThreadDetail:
    ensure(me, Action.WORK_FACEBOOK)
    thread = _thread(db, thread_id)
    try:
        items = service.clean_items(body.items)
        service.save(db, thread, me, body.title, items, FbStatus(body.status))
    except FbError as error:
        raise _raise(error) from None
    db.commit()
    db.refresh(thread)
    return detail(db, thread)


@router.delete("/threads/{thread_id}/answer", response_model=ThreadDetail)
def clear_answer(thread_id: uuid.UUID, me: CurrentUser, db: Db) -> ThreadDetail:
    ensure(me, Action.WORK_FACEBOOK)
    thread = _thread(db, thread_id)
    service.clear(db, thread, me)
    db.commit()
    db.refresh(thread)
    return detail(db, thread)


@router.post("/threads/{thread_id}/rework", response_model=ReworkOut)
def rework(
    thread_id: uuid.UUID,
    body: ReworkIn,
    me: CurrentUser,
    db: Db,
    answerer: Annotated[Answerer | None, Depends(answerer_dep)],
) -> ReworkOut:
    ensure(me, Action.WORK_FACEBOOK)
    thread = _thread(db, thread_id)
    if answerer is None:
        raise ApiError(503, "not_configured", NOT_SET_UP)
    try:
        result = service.rework(
            db, thread, answerer, me, body.mode, body.text, body.label, body.instruction
        )
    except FbError as error:
        db.commit()  # the usage still counts
        raise _raise(error) from None
    db.commit()
    return ReworkOut(answer=result.answer, changes=result.changes)


@router.post("/load", response_model=LoadOut)
def load(me: CurrentUser, db: Db, file: Annotated[UploadFile, File()]) -> LoadOut:
    """Load the group's data file (posts, threads and any saved answers)."""
    ensure(me, Action.IMPORT_VERIFIED)
    max_mb = max(settings_store.get_int(db, "max_upload_mb"), 50)
    try:
        received = storage.receive(file.file, max_mb * 1024 * 1024)
    except storage.TooLarge:
        raise ApiError(413, "too_large", f"This file is bigger than {max_mb} MB.") from None
    try:
        data = json.loads(received.temp_path.read_bytes().decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError):
        raise ApiError(422, "invalid", "Upload the Facebook data file (.json).") from None
    finally:
        received.temp_path.unlink(missing_ok=True)
    try:
        loaded = service.load(db, data, me)
    except FbError as error:
        db.rollback()
        raise _raise(error) from None
    db.commit()
    return LoadOut(posts=loaded.posts, threads=loaded.threads, answers=loaded.answers)
