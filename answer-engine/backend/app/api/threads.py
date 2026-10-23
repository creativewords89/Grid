"""`/api/threads`, `/api/thread-messages` and `/api/platforms`: marketing (SPEC 6.10, 7.3)."""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, StringConstraints
from sqlalchemy import func, select

from app.answering.claude_answer import Answerer
from app.api.answer_log import Person
from app.api.conversations import NOT_SET_UP, answerer_dep, store_dep
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.db.models import (
    CloseReason,
    Community,
    DraftState,
    MessageAuthor,
    Platform,
    PlatformParser,
    Thread,
    ThreadMessage,
    ThreadStatus,
    User,
)
from app.errors import ApiError
from app.kb.store import VectorStore
from app.marketing import service
from app.marketing.service import MarketingError
from app.permissions import Action, can, ensure
from app.reviews import service as reviews

router = APIRouter(tags=["marketing"])

Text = Annotated[str, StringConstraints(max_length=20000)]
Short = Annotated[str, StringConstraints(strip_whitespace=True, max_length=300)]


def _raise(error: MarketingError) -> ApiError:
    return ApiError(error.status, error.code, error.message, details=error.details)


# --- shapes -----------------------------------------------------------------------------------


class PlatformOut(BaseModel):
    id: uuid.UUID
    slug: str
    name: str
    enabled: bool
    parser: str
    hosts: list[str]
    style_prompt: str
    disclosure_line: str | None
    position: int
    communities: list[dict[str, Any]]


class ThreadRow(BaseModel):
    id: str
    platform: str
    platform_name: str
    community: str | None
    title: str
    original_url: str
    status: str
    created_by: Person | None
    posted_by: list[Person]
    last_activity_at: datetime
    created_at: datetime


class ThreadList(BaseModel):
    items: list[ThreadRow]
    counts: dict[str, int]


class DraftInfo(BaseModel):
    answer_id: uuid.UUID
    confidence: int | None
    outcome: str | None
    status: str
    sources: list[dict[str, Any]]
    needs_info: dict[str, str] | None
    corrected_after_post: str | None


class MessageView(BaseModel):
    id: uuid.UUID
    parent_id: uuid.UUID | None
    author: str
    author_name: str | None
    body: str
    external_url: str | None
    state: str | None
    posted_by: Person | None
    posted_at: datetime | None
    created_by: Person | None
    created_at: datetime
    draft: DraftInfo | None


class ThreadDetail(ThreadRow):
    closed_at: datetime | None
    close_reason: str | None
    messages: list[MessageView]
    can_close: bool
    can_delete: bool


class ResolveIn(Strict):
    url: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]


class ResolveOut(BaseModel):
    found: bool
    parsed: dict[str, Any] | None
    thread: ThreadRow | None = None
    matched_message_id: uuid.UUID | None = None
    reopened: bool = False
    error: str | None = None


class NewThreadIn(Strict):
    url: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
    question: Text
    title: Short | None = None
    author_name: Short | None = None
    confirm_new: bool = False


class ReplyIn(Strict):
    body: Text
    parent_id: uuid.UUID | None = None
    author_name: Short | None = None
    url: Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)] | None = None


class DraftIn(Strict):
    parent_id: uuid.UUID
    instruction: Annotated[str, StringConstraints(max_length=500)] | None = None


class EditIn(Strict):
    body: Text


class PostedIn(Strict):
    url: Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)] | None = None


# --- helpers ------------------------------------------------------------------------------------


def _people(db: Db, ids: set[uuid.UUID | None]) -> dict[uuid.UUID, Person]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    rows = db.execute(select(User.id, User.name).where(User.id.in_(wanted))).all()
    return {r.id: Person(id=r.id, name=r.name) for r in rows}


def _row(thread: Thread, people: dict[uuid.UUID, Person]) -> dict[str, Any]:
    posters = []
    for m in thread.messages:
        if m.posted_by and m.posted_by in people and people[m.posted_by] not in posters:
            posters.append(people[m.posted_by])
    return {
        "id": thread.id,
        "platform": thread.platform.slug,
        "platform_name": thread.platform.name,
        "community": thread.community,
        "title": thread.title,
        "original_url": thread.original_url,
        "status": thread.status.value,
        "created_by": people.get(thread.created_by) if thread.created_by else None,
        "posted_by": posters,
        "last_activity_at": thread.last_activity_at,
        "created_at": thread.created_at,
    }


def _thread_people(db: Db, threads: list[Thread]) -> dict[uuid.UUID, Person]:
    ids: set[uuid.UUID | None] = set()
    for t in threads:
        ids.add(t.created_by)
        for m in t.messages:
            ids |= {m.posted_by, m.created_by}
    return _people(db, ids)


def _get(db: Db, thread_id: str) -> Thread:
    thread = service.live_thread(db, thread_id)
    if thread is None:
        raise ApiError(404, "not_found", "That thread doesn't exist.")
    return thread


def _draft_info(db: Db, m: ThreadMessage) -> DraftInfo | None:
    answer = m.answer
    if m.author != MessageAuthor.US or answer is None:
        return None
    needs = None
    waiting = reviews.open_question(db, answer)
    if waiting is not None:
        _, question = waiting
        author = db.get(User, question.author_id) if question.author_id else None
        needs = {"question": question.body, "asked_by": author.name if author else "Our team"}
    corrected = (
        answer.current_text
        if m.state == DraftState.POSTED and answer.current_text != m.body
        else None
    )
    return DraftInfo(
        answer_id=answer.id,
        confidence=answer.confidence,
        outcome=answer.outcome.value if answer.outcome else None,
        status=answer.status.value,
        sources=answer.sources,
        needs_info=needs,
        corrected_after_post=corrected,
    )


def detail(db: Db, thread: Thread, me: User) -> ThreadDetail:
    people = _thread_people(db, [thread])
    messages = [
        MessageView(
            id=m.id,
            parent_id=m.parent_id,
            author=m.author.value,
            author_name=m.author_name,
            body=m.body,
            external_url=m.external_url,
            state=m.state.value if m.state else None,
            posted_by=people.get(m.posted_by) if m.posted_by else None,
            posted_at=m.posted_at,
            created_by=people.get(m.created_by) if m.created_by else None,
            created_at=m.created_at,
            draft=_draft_info(db, m),
        )
        for m in sorted(thread.messages, key=lambda m: (m.created_at, str(m.id)))
        if m.state != DraftState.DISCARDED
    ]
    return ThreadDetail(
        **_row(thread, people),
        closed_at=thread.closed_at,
        close_reason=thread.close_reason.value if thread.close_reason else None,
        messages=messages,
        can_close=can(me, Action.CLOSE_THREAD, thread),
        can_delete=can(me, Action.DELETE_THREAD),
    )


# --- platforms ----------------------------------------------------------------------------------


def _platform_out(db: Db, p: Platform) -> PlatformOut:
    communities = db.scalars(
        select(Community).where(Community.platform_id == p.id).order_by(Community.name)
    ).all()
    return PlatformOut(
        id=p.id,
        slug=p.slug,
        name=p.name,
        enabled=p.enabled,
        parser=p.parser.value,
        hosts=list(p.hosts or []),
        style_prompt=p.style_prompt,
        disclosure_line=p.disclosure_line,
        position=p.position,
        communities=[{"id": str(c.id), "name": c.name, "notes": c.notes} for c in communities],
    )


@router.get("/platforms", response_model=list[PlatformOut])
def list_platforms(me: CurrentUser, db: Db) -> list[PlatformOut]:
    ensure(me, Action.WORK_THREADS)
    return [_platform_out(db, p) for p in service.platforms(db)]


class PlatformIn(Strict):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
    slug: Annotated[
        str, StringConstraints(strip_whitespace=True, pattern=r"^[a-z][a-z0-9-]{1,39}$")
    ]
    hosts: list[Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)]]
    style_prompt: Annotated[str, StringConstraints(max_length=4000)] = ""
    disclosure_line: Annotated[str, StringConstraints(max_length=300)] | None = None


class PlatformPatch(Strict):
    name: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)] | None
    ) = None
    enabled: bool | None = None
    hosts: list[Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)]] | None = (
        None
    )
    style_prompt: Annotated[str, StringConstraints(max_length=4000)] | None = None
    disclosure_line: Annotated[str, StringConstraints(max_length=300)] | None = None
    position: int | None = None


class CommunityIn(Strict):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    notes: Annotated[str, StringConstraints(max_length=4000)] = ""


class CommunityPatch(Strict):
    notes: Annotated[str, StringConstraints(max_length=4000)]


def _platform(db: Db, platform_id: uuid.UUID) -> Platform:
    platform = db.get(Platform, platform_id)
    if platform is None:
        raise ApiError(404, "not_found", "That platform doesn't exist.")
    return platform


@router.post("/platforms", response_model=PlatformOut, status_code=201)
def add_platform(body: PlatformIn, me: CurrentUser, db: Db) -> PlatformOut:
    """A new platform reads its links with the generic parser (SPEC 6.10)."""
    ensure(me, Action.MANAGE_SETTINGS)
    service.platforms(db)
    if db.scalar(select(Platform).where(Platform.slug == body.slug)):
        raise ApiError(409, "exists", "A platform with that short name exists.")
    hosts = [h.lower().removeprefix("www.") for h in body.hosts if h]
    if not hosts:
        raise ApiError(422, "invalid", "Add the website it's on, like quora.com.")
    position = (db.scalar(select(func.max(Platform.position))) or 0) + 1
    platform = Platform(
        slug=body.slug,
        name=body.name,
        parser=PlatformParser.GENERIC,
        hosts=hosts,
        style_prompt=body.style_prompt,
        disclosure_line=body.disclosure_line or None,
        position=position,
    )
    db.add(platform)
    db.commit()
    return _platform_out(db, platform)


@router.patch("/platforms/{platform_id}", response_model=PlatformOut)
def update_platform(
    platform_id: uuid.UUID, body: PlatformPatch, me: CurrentUser, db: Db
) -> PlatformOut:
    ensure(me, Action.MANAGE_SETTINGS)
    platform = _platform(db, platform_id)
    for key, value in body.model_dump(exclude_unset=True).items():
        if key == "hosts":
            if platform.parser != PlatformParser.GENERIC:
                continue  # Reddit and Facebook know their own websites
            value = [h.lower().removeprefix("www.") for h in value or [] if h]
        if key == "disclosure_line":
            value = value or None
        setattr(platform, key, value)
    db.commit()
    return _platform_out(db, platform)


@router.post("/platforms/{platform_id}/communities", response_model=PlatformOut, status_code=201)
def add_community(
    platform_id: uuid.UUID, body: CommunityIn, me: CurrentUser, db: Db
) -> PlatformOut:
    ensure(me, Action.MANAGE_SETTINGS)
    platform = _platform(db, platform_id)
    exists = db.scalar(
        select(Community).where(
            Community.platform_id == platform.id, func.lower(Community.name) == body.name.lower()
        )
    )
    if exists:
        exists.notes = body.notes
    else:
        db.add(Community(platform_id=platform.id, name=body.name, notes=body.notes))
    db.commit()
    return _platform_out(db, platform)


@router.patch("/communities/{community_id}", response_model=PlatformOut)
def update_community(
    community_id: uuid.UUID, body: CommunityPatch, me: CurrentUser, db: Db
) -> PlatformOut:
    ensure(me, Action.MANAGE_SETTINGS)
    community = db.get(Community, community_id)
    if community is None:
        raise ApiError(404, "not_found", "That community doesn't exist.")
    community.notes = body.notes
    db.commit()
    return _platform_out(db, _platform(db, community.platform_id))


@router.delete("/communities/{community_id}", status_code=204)
def delete_community(community_id: uuid.UUID, me: CurrentUser, db: Db) -> None:
    ensure(me, Action.MANAGE_SETTINGS)
    community = db.get(Community, community_id)
    if community is not None:
        db.delete(community)
        db.commit()


# --- threads --------------------------------------------------------------------------------------


@router.post("/threads/resolve", response_model=ResolveOut)
def resolve(body: ResolveIn, me: CurrentUser, db: Db) -> ResolveOut:
    ensure(me, Action.WORK_THREADS)
    try:
        found = service.resolve(db, body.url, me)
    except MarketingError as error:
        return ResolveOut(found=False, parsed=None, error=error.message)
    db.commit()
    parsed = {
        "platform": found.parsed.platform,
        "thread_id": found.parsed.thread_id,
        "community": found.parsed.community,
        "comment_id": found.parsed.comment_id,
        "platform_name": service.platform_of(db, found.parsed.platform).name,
    }
    if found.thread is None:
        return ResolveOut(found=False, parsed=parsed)
    people = _thread_people(db, [found.thread])
    return ResolveOut(
        found=True,
        parsed=parsed,
        thread=ThreadRow(**_row(found.thread, people)),
        matched_message_id=found.matched_message_id,
        reopened=found.reopened,
    )


@router.post("/threads", response_model=ThreadDetail, status_code=201)
def create_thread(body: NewThreadIn, me: CurrentUser, db: Db) -> ThreadDetail:
    ensure(me, Action.WORK_THREADS)
    try:
        thread = service.create_thread(
            db, body.url, me, body.question, body.title, body.author_name, body.confirm_new
        )
    except MarketingError as error:
        db.rollback()
        raise _raise(error) from None
    db.commit()
    return detail(db, _get(db, thread.id), me)


Tab = Literal["waiting_for_us", "in_review", "ready_to_post", "waiting_for_them", "closed"]


@router.get("/threads", response_model=ThreadList)
def list_threads(
    me: CurrentUser,
    db: Db,
    status: Tab | None = None,
    platform: str | None = None,
    community: str | None = None,
    posted_by: uuid.UUID | None = None,
    mine: bool = False,
) -> ThreadList:
    ensure(me, Action.WORK_THREADS)
    threads = db.scalars(
        select(Thread)
        .where(Thread.deleted_at.is_(None))
        .order_by(Thread.last_activity_at.desc())
        .limit(1000)
    ).all()

    def keep(t: Thread) -> bool:
        if platform and t.platform.slug != platform:
            return False
        if community and (t.community or "").lower() != community.lower():
            return False
        if posted_by and posted_by not in {m.posted_by for m in t.messages}:
            return False
        return not (mine and me.id not in t.owner_ids)

    filtered = [t for t in threads if keep(t)]
    counts = {s.value: 0 for s in ThreadStatus}
    for t in filtered:
        counts[t.status.value] += 1
    shown = [t for t in filtered if status is None or t.status.value == status][:300]
    people = _thread_people(db, shown)
    return ThreadList(items=[ThreadRow(**_row(t, people)) for t in shown], counts=counts)


@router.get("/threads/{thread_id}", response_model=ThreadDetail)
def get_thread(thread_id: str, me: CurrentUser, db: Db) -> ThreadDetail:
    ensure(me, Action.WORK_THREADS)
    return detail(db, _get(db, thread_id), me)


@router.post("/threads/{thread_id}/replies", response_model=ThreadDetail, status_code=201)
def add_reply(thread_id: str, body: ReplyIn, me: CurrentUser, db: Db) -> ThreadDetail:
    ensure(me, Action.WORK_THREADS)
    thread = _get(db, thread_id)
    try:
        service.add_reply(db, thread, me, body.body, body.parent_id, body.author_name, body.url)
    except MarketingError as error:
        db.rollback()
        raise _raise(error) from None
    db.commit()
    return detail(db, _get(db, thread_id), me)


@router.post("/threads/{thread_id}/draft", response_model=ThreadDetail)
def draft(
    thread_id: str,
    body: DraftIn,
    me: CurrentUser,
    db: Db,
    answerer: Annotated[Answerer | None, Depends(answerer_dep)],
    store: Annotated[VectorStore | None, Depends(store_dep)],
) -> ThreadDetail:
    ensure(me, Action.WORK_THREADS)
    thread = _get(db, thread_id)
    if answerer is None or store is None:
        raise ApiError(503, "not_configured", NOT_SET_UP)
    try:
        service.draft(db, thread, body.parent_id, me, answerer, store, body.instruction)
    except MarketingError as error:
        db.rollback()
        raise _raise(error) from None
    db.expire_all()
    return detail(db, _get(db, thread_id), me)


def _message(db: Db, message_id: uuid.UUID) -> ThreadMessage:
    message = db.get(ThreadMessage, message_id)
    if message is None or message.thread.deleted_at is not None:
        raise ApiError(404, "not_found", "That message doesn't exist.")
    return message


@router.patch("/thread-messages/{message_id}", response_model=ThreadDetail)
def edit_message(message_id: uuid.UUID, body: EditIn, me: CurrentUser, db: Db) -> ThreadDetail:
    ensure(me, Action.WORK_THREADS)
    message = _message(db, message_id)
    try:
        service.edit_draft(db, message, me, body.body)
    except MarketingError as error:
        raise _raise(error) from None
    db.commit()
    return detail(db, _get(db, message.thread_id), me)


@router.post("/thread-messages/{message_id}/posted", response_model=ThreadDetail)
def posted(message_id: uuid.UUID, body: PostedIn, me: CurrentUser, db: Db) -> ThreadDetail:
    ensure(me, Action.WORK_THREADS)
    message = _message(db, message_id)
    try:
        service.mark_posted(db, message, me, body.url or None)
    except MarketingError as error:
        db.rollback()
        raise _raise(error) from None
    db.commit()
    return detail(db, _get(db, message.thread_id), me)


@router.post("/threads/{thread_id}/close", response_model=ThreadDetail)
def close(thread_id: str, me: CurrentUser, db: Db) -> ThreadDetail:
    thread = _get(db, thread_id)
    ensure(me, Action.CLOSE_THREAD, thread)
    if thread.closed_at is None:
        service.close(db, thread, me, CloseReason.MANUAL)
        db.commit()
    return detail(db, thread, me)


@router.post("/threads/{thread_id}/reopen", response_model=ThreadDetail)
def reopen(thread_id: str, me: CurrentUser, db: Db) -> ThreadDetail:
    thread = _get(db, thread_id)
    ensure(me, Action.CLOSE_THREAD, thread)
    if thread.closed_at is not None:
        service.reopen(db, thread, me)
        db.commit()
    return detail(db, thread, me)


@router.delete("/threads/{thread_id}", status_code=204)
def delete(thread_id: str, me: CurrentUser, db: Db) -> None:
    ensure(me, Action.DELETE_THREAD)
    service.delete(db, _get(db, thread_id), me)
    db.commit()
