"""`/api/voice`: Brand voice, per platform (SPEC sections 6.13 and 7.2).

Everyone can see a platform's examples, style guide and rules and try them; only the Owner
changes them (Action.MANAGE_VOICE).
"""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, File, Query, Response, UploadFile
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import func, or_, select

from app import audit, settings_store
from app.answering.claude_answer import Answerer
from app.api.answer_log import Person
from app.api.conversations import NOT_SET_UP, answerer_dep, store_dep
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.db.models import (
    Platform,
    User,
    VoiceEmojis,
    VoiceExample,
    VoiceLinks,
    VoiceState,
)
from app.errors import ApiError
from app.files import service as files
from app.files import storage
from app.kb.store import VectorStore
from app.marketing import service as marketing
from app.permissions import Action, can, ensure
from app.voice import service as voice

router = APIRouter(prefix="/voice", tags=["voice"])

Question = Annotated[str, StringConstraints(max_length=4000)]
Word = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]


def _platform(db: Db, slug: str) -> Platform:
    try:
        return marketing.platform_of(db, slug)
    except marketing.MarketingError as error:
        raise ApiError(error.status, error.code, error.message) from None


def _example(db: Db, example_id: uuid.UUID) -> VoiceExample:
    example = db.get(VoiceExample, example_id)
    if example is None:
        raise ApiError(404, "not_found", "That example doesn't exist.")
    return example


def _raise(error: voice.VoiceError) -> ApiError:
    return ApiError(error.status, error.code, error.message)


# --- shapes --------------------------------------------------------------------------------


class PlatformVoice(BaseModel):
    slug: str
    name: str
    enabled: bool
    examples: int
    suggested: int


class FileInfo(BaseModel):
    name: str
    uploaded_at: datetime | None
    uploaded_by: Person | None


class Rules(BaseModel):
    max_words: int | None
    emojis: VoiceEmojis
    links: VoiceLinks
    banned: list[str]
    disclosure_line: str | None


class VoiceOut(BaseModel):
    slug: str
    name: str
    file: FileInfo | None
    from_file: int
    from_posted: int
    suggested: int
    guide: str
    guide_edited: bool
    guide_at: datetime | None
    rules: Rules
    can_manage: bool


class ExampleOut(BaseModel):
    id: uuid.UUID
    question: str
    answer: str
    community: str | None
    notes: str | None
    source: str
    state: str
    enabled: bool
    starred: bool
    corrected: bool
    used_count: int
    created_by: Person | None
    created_at: datetime


class ExampleList(BaseModel):
    items: list[ExampleOut]
    total: int


class UploadOut(BaseModel):
    added: int
    skipped: int
    duplicates: int
    voice: VoiceOut


class ExamplePatch(Strict):
    enabled: bool | None = None
    starred: bool | None = None
    question: Question | None = None
    answer: Question | None = None


class ApproveIn(Strict):
    answer: Question | None = None


class GuideIn(Strict):
    text: Annotated[str, StringConstraints(max_length=4000)]


class RulesIn(Strict):
    max_words: int | None = Field(default=None, ge=10, le=1000)
    emojis: VoiceEmojis
    links: VoiceLinks
    banned: list[Word] = Field(default_factory=list, max_length=100)
    disclosure_line: Annotated[str, StringConstraints(max_length=300)] | None = None


class TryIn(Strict):
    question: Question
    community: Annotated[str, StringConstraints(max_length=200)] | None = None


class StyleExampleOut(BaseModel):
    id: uuid.UUID
    question: str
    answer: str


class ChecksOut(BaseModel):
    words: int
    max_words: int | None
    too_long: bool
    links: bool
    emojis: int
    banned: list[str]


class TryOut(BaseModel):
    text: str
    matched: bool
    examples: list[StyleExampleOut]
    sources: list[str]
    checks: ChecksOut


def _people(db: Db, ids: set[uuid.UUID | None]) -> dict[uuid.UUID, Person]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    rows = db.execute(select(User.id, User.name).where(User.id.in_(wanted))).all()
    return {r.id: Person(id=r.id, name=r.name) for r in rows}


def _out(db: Db, platform: Platform, me: User) -> VoiceOut:
    found = voice.summary(db, platform)
    people = _people(db, {platform.voice_file_by})
    file = (
        FileInfo(
            name=platform.voice_file_name,
            uploaded_at=platform.voice_file_at,
            uploaded_by=people.get(platform.voice_file_by) if platform.voice_file_by else None,
        )
        if platform.voice_file_name
        else None
    )
    return VoiceOut(
        slug=platform.slug,
        name=platform.name,
        file=file,
        from_file=found["from_file"],
        from_posted=found["from_posted"],
        suggested=found["suggested"],
        guide=platform.voice_guide,
        guide_edited=platform.voice_guide_edited,
        guide_at=platform.voice_guide_at,
        rules=Rules(
            max_words=platform.voice_max_words,
            emojis=platform.voice_emojis,
            links=platform.voice_links,
            banned=list(platform.voice_banned),
            disclosure_line=platform.disclosure_line,
        ),
        can_manage=can(me, Action.MANAGE_VOICE),
    )


def _examples_out(db: Db, rows: list[VoiceExample]) -> list[ExampleOut]:
    people = _people(db, {e.created_by for e in rows})
    return [
        ExampleOut(
            id=e.id,
            question=e.question,
            answer=e.answer,
            community=e.community,
            notes=e.notes,
            source=e.source.value,
            state=e.state.value,
            enabled=e.enabled,
            starred=e.starred,
            corrected=e.corrected,
            used_count=e.used_count,
            created_by=people.get(e.created_by) if e.created_by else None,
            created_at=e.created_at,
        )
        for e in rows
    ]


# --- endpoints --------------------------------------------------------------------------------


@router.get("", response_model=list[PlatformVoice])
def platforms(me: CurrentUser, db: Db) -> list[PlatformVoice]:
    ensure(me, Action.WORK_THREADS)
    active = voice.counts(db)
    waiting = dict(
        db.execute(
            select(VoiceExample.platform_id, func.count())
            .where(VoiceExample.state == VoiceState.SUGGESTED)
            .group_by(VoiceExample.platform_id)
        ).all()
    )
    return [
        PlatformVoice(
            slug=p.slug,
            name=p.name,
            enabled=p.enabled,
            examples=active.get(p.id, 0),
            suggested=waiting.get(p.id, 0),
        )
        for p in marketing.platforms(db)
    ]


@router.get("/{slug}", response_model=VoiceOut)
def get_voice(slug: str, me: CurrentUser, db: Db) -> VoiceOut:
    ensure(me, Action.WORK_THREADS)
    return _out(db, _platform(db, slug), me)


@router.get("/{slug}/examples", response_model=ExampleList)
def list_examples(
    slug: str,
    me: CurrentUser,
    db: Db,
    state: VoiceState = VoiceState.ACTIVE,
    q: Annotated[str, Query(max_length=200)] = "",
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> ExampleList:
    ensure(me, Action.WORK_THREADS)
    platform = _platform(db, slug)
    where = [VoiceExample.platform_id == platform.id, VoiceExample.state == state]
    if q.strip():
        pattern = f"%{q.strip()}%"
        where.append(or_(VoiceExample.question.ilike(pattern), VoiceExample.answer.ilike(pattern)))
    total = db.scalar(select(func.count()).select_from(VoiceExample).where(*where)) or 0
    rows = db.scalars(
        select(VoiceExample)
        .where(*where)
        .order_by(VoiceExample.created_at.desc(), VoiceExample.id)
        .offset(offset)
        .limit(limit)
    ).all()
    return ExampleList(items=_examples_out(db, list(rows)), total=total)


@router.post("/{slug}/file", response_model=UploadOut)
def upload(slug: str, me: CurrentUser, db: Db, file: Annotated[UploadFile, File()]) -> UploadOut:
    """Upload the platform's examples file. It replaces the previous file's examples."""
    ensure(me, Action.MANAGE_VOICE)
    platform = _platform(db, slug)
    name = files.clean_name(file.filename)
    max_mb = settings_store.get_int(db, "max_upload_mb")
    try:
        received = storage.receive(file.file, max_mb * 1024 * 1024)
    except storage.TooLarge:
        raise ApiError(413, "too_large", f"This file is bigger than {max_mb} MB.") from None
    try:
        parsed = voice.parse_file(received.temp_path, name)
    except voice.VoiceError as error:
        raise _raise(error) from None
    finally:
        received.temp_path.unlink(missing_ok=True)
    added = voice.replace_file(db, platform, parsed, name, me)
    db.commit()
    return UploadOut(
        added=len(added),
        skipped=parsed.skipped,
        duplicates=parsed.duplicates,
        voice=_out(db, platform, me),
    )


@router.patch("/examples/{example_id}", response_model=ExampleOut)
def update_example(
    example_id: uuid.UUID, body: ExamplePatch, me: CurrentUser, db: Db
) -> ExampleOut:
    ensure(me, Action.MANAGE_VOICE)
    example = _example(db, example_id)
    try:
        voice.update(db, example, me, **body.model_dump(exclude_none=True))
    except voice.VoiceError as error:
        raise _raise(error) from None
    db.commit()
    return _examples_out(db, [example])[0]


@router.delete("/examples/{example_id}", status_code=204)
def delete_example(example_id: uuid.UUID, me: CurrentUser, db: Db) -> Response:
    ensure(me, Action.MANAGE_VOICE)
    voice.remove(db, _example(db, example_id), me)
    db.commit()
    return Response(status_code=204)


@router.post("/examples/{example_id}/approve", response_model=ExampleOut)
def approve(example_id: uuid.UUID, body: ApproveIn, me: CurrentUser, db: Db) -> ExampleOut:
    ensure(me, Action.MANAGE_VOICE)
    example = _example(db, example_id)
    try:
        voice.approve(db, example, me, body.answer)
    except voice.VoiceError as error:
        raise _raise(error) from None
    db.commit()
    return _examples_out(db, [example])[0]


@router.post("/examples/{example_id}/dismiss", response_model=ExampleOut)
def dismiss(example_id: uuid.UUID, me: CurrentUser, db: Db) -> ExampleOut:
    ensure(me, Action.MANAGE_VOICE)
    example = _example(db, example_id)
    try:
        voice.dismiss(db, example, me)
    except voice.VoiceError as error:
        raise _raise(error) from None
    db.commit()
    return _examples_out(db, [example])[0]


@router.put("/{slug}/guide", response_model=VoiceOut)
def edit_guide(slug: str, body: GuideIn, me: CurrentUser, db: Db) -> VoiceOut:
    """The Owner's edit of the style guide. Kept when new examples arrive."""
    ensure(me, Action.MANAGE_VOICE)
    platform = _platform(db, slug)
    voice.edit_guide(db, platform, body.text, me)
    db.commit()
    return _out(db, platform, me)


@router.post("/{slug}/guide/rewrite", response_model=VoiceOut)
def rewrite_guide(
    slug: str,
    me: CurrentUser,
    db: Db,
    answerer: Annotated[Answerer | None, Depends(answerer_dep)],
) -> VoiceOut:
    """Write the style guide from the examples again, replacing any edit."""
    ensure(me, Action.MANAGE_VOICE)
    platform = _platform(db, slug)
    if answerer is None:
        raise ApiError(503, "not_configured", NOT_SET_UP)
    try:
        voice.write_guide(db, platform, answerer, me)
    except voice.VoiceError as error:
        db.rollback()
        raise _raise(error) from None
    db.commit()
    return _out(db, platform, me)


@router.put("/{slug}/rules", response_model=VoiceOut)
def save_rules(slug: str, body: RulesIn, me: CurrentUser, db: Db) -> VoiceOut:
    ensure(me, Action.MANAGE_VOICE)
    platform = _platform(db, slug)
    banned = list(dict.fromkeys(w for w in body.banned if w))
    disclosure = (body.disclosure_line or "").strip() or None
    platform.voice_max_words = body.max_words
    platform.voice_emojis = body.emojis
    platform.voice_links = body.links
    platform.voice_banned = banned
    platform.disclosure_line = disclosure
    audit.record(db, me, "update", "brand_voice", platform.id, f"{platform.name} writing rules")
    db.commit()
    return _out(db, platform, me)


@router.post("/{slug}/try", response_model=TryOut)
def try_it(
    slug: str,
    body: TryIn,
    me: CurrentUser,
    db: Db,
    answerer: Annotated[Answerer | None, Depends(answerer_dep)],
    store: Annotated[VectorStore | None, Depends(store_dep)],
) -> TryOut:
    """A test draft with the platform's current brand voice. Nothing is saved or posted."""
    ensure(me, Action.WORK_THREADS)
    platform = _platform(db, slug)
    if answerer is None or store is None:
        raise ApiError(503, "not_configured", NOT_SET_UP)
    try:
        preview = marketing.preview_draft(
            db, platform, body.question, body.community, me, answerer, store
        )
    except marketing.MarketingError as error:
        db.rollback()
        raise ApiError(error.status, error.code, error.message) from None
    db.commit()
    checks = preview.checks
    return TryOut(
        text=preview.text,
        matched=preview.matched,
        examples=[
            StyleExampleOut(id=e.id, question=e.question, answer=e.answer) for e in preview.examples
        ],
        sources=preview.sources,
        checks=ChecksOut(
            words=checks.words,
            max_words=platform.voice_max_words,
            too_long=checks.too_long,
            links=checks.links,
            emojis=checks.emojis,
            banned=checks.banned,
        ),
    )
