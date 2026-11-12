"""`/api/qb`: the Question Bank (SPEC section 6.9a, steps 27 and 29).

Real questions come in sets. Owners and Reviewers answer their threads; only Owners create,
rename, upload to and delete sets. Users don't see it: the comments carry people's names.
"""

import json
import re
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Query, Response, UploadFile
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import select

from app import audit, settings_store
from app.answering.claude_answer import Answerer
from app.api.answer_log import Person
from app.api.conversations import NOT_SET_UP, answerer_dep, store_dep
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.db.models import FbStatus, FbThread, QuestionSet, User
from app.errors import ApiError
from app.files import storage
from app.kb.store import VectorStore
from app.permissions import Action, can, ensure
from app.question_bank import export as export_xlsx
from app.question_bank import service, sheet
from app.question_bank.service import FbError

router = APIRouter(prefix="/qb", tags=["question bank"])


class SetRow(BaseModel):
    id: uuid.UUID
    name: str
    source: str
    url: str
    total: int
    counts: dict[str, int]
    created_at: datetime


class SetList(BaseModel):
    items: list[SetRow]
    can_manage: bool


class SetIn(Strict):
    name: Annotated[str, StringConstraints(max_length=200)]
    source: Annotated[str, StringConstraints(max_length=200)] = ""
    url: Annotated[str, StringConstraints(max_length=500)] = ""


class SetPatch(Strict):
    name: Annotated[str, StringConstraints(max_length=200)] | None = None
    source: Annotated[str, StringConstraints(max_length=200)] | None = None
    url: Annotated[str, StringConstraints(max_length=500)] | None = None


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
    set: SetRow
    items: list[ThreadRow]
    counts: dict[str, int]
    can_manage: bool


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
    set_id: uuid.UUID
    set_name: str
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


class SkippedRow(BaseModel):
    row: int
    reason: str


class LoadOut(BaseModel):
    posts: int
    threads: int
    answers: int
    skipped: list[SkippedRow] = Field(default_factory=list)


class SuggestionOut(BaseModel):
    """An answer already given to a question that means the same (step 31)."""

    kind: Literal["verified", "draft"]
    question: str
    answer: str
    applies_when: str
    score: float
    match: Literal["strong", "possible"]
    topic: str
    subtopic: str
    verified_id: uuid.UUID | None
    thread_id: uuid.UUID | None
    set_name: str
    rows: list[int] | None


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


def _set_row(qset: QuestionSet, counts: dict[str, int] | None) -> SetRow:
    counts = counts or {s.value: 0 for s in FbStatus}
    return SetRow(
        id=qset.id,
        name=qset.name,
        source=qset.source,
        url=qset.url,
        total=sum(counts.values()),
        counts=counts,
        created_at=qset.created_at,
    )


def _set(db: Db, set_id: uuid.UUID) -> QuestionSet:
    try:
        return service.get_set(db, set_id)
    except FbError as error:
        raise _raise(error) from None


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
            .where(
                FbThread.set_id == t.set_id,
                FbThread.similar == t.similar,
                FbThread.id != t.id,
                FbThread.noise.is_(False),
            )
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
        set_id=t.set_id,
        set_name=t.question_set.name,
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


# --- sets --------------------------------------------------------------------------------------


@router.get("/sets", response_model=SetList)
def list_sets(me: CurrentUser, db: Db) -> SetList:
    ensure(me, Action.WORK_QUESTION_BANK)
    counts = service.set_counts(db)
    sets = db.scalars(select(QuestionSet).order_by(QuestionSet.created_at, QuestionSet.name))
    return SetList(
        items=[_set_row(q, counts.get(q.id)) for q in sets],
        can_manage=can(me, Action.MANAGE_QUESTION_SETS),
    )


@router.post("/sets", response_model=SetRow, status_code=201)
def create_set(body: SetIn, me: CurrentUser, db: Db) -> SetRow:
    ensure(me, Action.MANAGE_QUESTION_SETS)
    try:
        qset = service.create_set(db, me, body.name, body.source, body.url)
    except FbError as error:
        raise _raise(error) from None
    db.commit()
    return _set_row(qset, None)


@router.patch("/sets/{set_id}", response_model=SetRow)
def update_set(set_id: uuid.UUID, body: SetPatch, me: CurrentUser, db: Db) -> SetRow:
    ensure(me, Action.MANAGE_QUESTION_SETS)
    qset = _set(db, set_id)
    try:
        service.update_set(db, qset, me, body.name, body.source, body.url)
    except FbError as error:
        raise _raise(error) from None
    db.commit()
    return _set_row(qset, service.set_counts(db).get(qset.id))


@router.delete("/sets/{set_id}", status_code=204)
def delete_set(set_id: uuid.UUID, me: CurrentUser, db: Db) -> Response:
    ensure(me, Action.MANAGE_QUESTION_SETS)
    service.delete_set(db, _set(db, set_id), me)
    db.commit()
    return Response(status_code=204)


@router.get("/sets/{set_id}/threads", response_model=ThreadList)
def list_threads(set_id: uuid.UUID, me: CurrentUser, db: Db) -> ThreadList:
    ensure(me, Action.WORK_QUESTION_BANK)
    qset = _set(db, set_id)
    threads = db.scalars(
        select(FbThread)
        .where(FbThread.set_id == qset.id)
        .order_by(FbThread.noise, FbThread.talk.desc(), FbThread.key)
    ).all()
    counts = {s.value: 0 for s in FbStatus}
    for t in threads:
        counts[t.status.value] += 1
    return ThreadList(
        set=_set_row(qset, counts),
        items=[ThreadRow(**_row(t)) for t in threads],
        counts=counts,
        can_manage=can(me, Action.MANAGE_QUESTION_SETS),
    )


@router.post("/sets/{set_id}/load", response_model=LoadOut)
def load(
    set_id: uuid.UUID, me: CurrentUser, db: Db, file: Annotated[UploadFile, File()]
) -> LoadOut:
    """Upload questions to a set: the JSON data file, or a CSV or Excel file. Uploading again
    adds new questions and updates known ones; saved answers are never touched."""
    ensure(me, Action.MANAGE_QUESTION_SETS)
    qset = _set(db, set_id)
    max_mb = max(settings_store.get_int(db, "max_upload_mb"), 50)
    try:
        received = storage.receive(file.file, max_mb * 1024 * 1024)
    except storage.TooLarge:
        raise ApiError(413, "too_large", f"This file is bigger than {max_mb} MB.") from None
    name = file.filename or "upload"
    skipped: list[SkippedRow] = []
    try:
        if name.lower().endswith(".json"):
            try:
                data = json.loads(received.temp_path.read_bytes().decode("utf-8-sig"))
            except (UnicodeDecodeError, ValueError):
                raise ApiError(422, "invalid", "This JSON data file can't be read.") from None
        else:
            data, missed = sheet.parse(received.temp_path, name)
            skipped = [SkippedRow(row=m.row, reason=m.reason) for m in missed]
        loaded = service.load(db, qset, data, me)
    except FbError as error:
        db.rollback()
        raise _raise(error) from None
    finally:
        received.temp_path.unlink(missing_ok=True)
    audit.record(db, me, "load", "question_set", qset.id, qset.name)
    db.commit()
    return LoadOut(
        posts=loaded.posts, threads=loaded.threads, answers=loaded.answers, skipped=skipped
    )


@router.get("/sets/{set_id}/export")
def export(
    set_id: uuid.UUID,
    me: CurrentUser,
    db: Db,
    topic: Annotated[str | None, Query(max_length=200)] = None,  # "" = no topic
    subtopic: Annotated[str | None, Query(max_length=200)] = None,
) -> Response:
    """The set's approved questions and answers as Excel: one sheet per topic, or per
    subtopic when a topic is given; answers side by side (step 32)."""
    ensure(me, Action.WORK_QUESTION_BANK)
    qset = _set(db, set_id)
    content, count = export_xlsx.build(db, qset, topic, subtopic)
    audit.record(
        db, me, "export", "question_set", qset.id, qset.name, [{"field": "questions", "to": count}]
    )
    db.commit()
    parts = [qset.name, *(x for x in (topic, subtopic) if x), "approved"]
    name = re.sub(r'[\\/:*?"<>|]+', " ", " - ".join(parts)).strip()[:150] + ".xlsx"
    return Response(
        content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="export.xlsx"; '
            f"filename*=UTF-8''{quote(name)}",
            "Cache-Control": "private, no-store",
        },
    )


# --- threads -------------------------------------------------------------------------------------


@router.get("/threads/{thread_id}/suggestions", response_model=list[SuggestionOut])
def suggestions(
    thread_id: uuid.UUID,
    me: CurrentUser,
    db: Db,
    store: Annotated[VectorStore | None, Depends(store_dep)],
) -> list[SuggestionOut]:
    """Suggested answers: answers already given to questions that mean the same, any set."""
    ensure(me, Action.WORK_QUESTION_BANK)
    thread = _thread(db, thread_id)
    return [SuggestionOut(**vars(s)) for s in service.suggest(db, store, thread)]


@router.get("/threads/{thread_id}", response_model=ThreadDetail)
def get_thread(thread_id: uuid.UUID, me: CurrentUser, db: Db) -> ThreadDetail:
    ensure(me, Action.WORK_QUESTION_BANK)
    return detail(db, _thread(db, thread_id))


@router.put("/threads/{thread_id}/answer", response_model=ThreadDetail)
def save_answer(thread_id: uuid.UUID, body: SaveIn, me: CurrentUser, db: Db) -> ThreadDetail:
    ensure(me, Action.WORK_QUESTION_BANK)
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
    ensure(me, Action.WORK_QUESTION_BANK)
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
    ensure(me, Action.WORK_QUESTION_BANK)
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
