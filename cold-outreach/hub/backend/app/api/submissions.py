"""`/api/submissions`: the Files screen (SPEC steps 31 and 32). The external team
(Collectors) hand in lead files, see Lead Check's problems and upload revised versions until
there is no error; then Reviewers choose each city's Top businesses (Top Review,
`app/api/review`); an Owner or Admin adds the ready file to a batch of its niche, once.

A Collector sees only their own files and changes them only while they have errors;
Owners, Admins and Viewers see every file. A file being added to a batch (its preview waits)
or used (saved in a batch) can't be changed or deleted."""

import re
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, File, Form, Response, UploadFile
from pydantic import BaseModel, StringConstraints
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit
from app.api.batches import get_batch
from app.api.imports import MAX_BYTES, NicheName
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.auth.tokens import now
from app.db.models import Batch, Benchmark, ImportStatus, Submission, User
from app.errors import ApiError
from app.imports import reader, service
from app.imports import submissions as files
from app.permissions import Action, can, ensure

router = APIRouter(tags=["files"])

# errors (Collectors fix them) → needs_top (Top Review) → ready → adding → used
Status = Literal["errors", "needs_top", "ready", "adding", "used"]


class BatchRef(BaseModel):
    batch_id: uuid.UUID | None
    batch_name: str | None
    import_id: uuid.UUID
    at: datetime | None
    by: str | None


class FileOut(BaseModel):
    id: uuid.UUID
    file_name: str
    niche: str
    version: int
    businesses: int
    errors: int
    warnings: int
    status: Status
    uploaded_by: str | None
    mine: bool
    created_at: datetime
    updated_at: datetime
    # Saved in a batch (used), or waiting for its preview to be confirmed there (adding).
    batch: BatchRef | None
    # The same leads were handed in before as another file (a warning on the screen).
    same_as: str | None = None
    # Top Review (step 32): the cities that need a Top (10 businesses or more) and how many
    # of them have one.
    cities_on: int = 0
    cities_topped: int = 0


class FileDetail(FileOut):
    tabs: dict[str, Any]
    problems: list[dict[str, Any]]


def status_of(sub: Submission) -> Status:
    imp = sub.imp
    if imp is not None and imp.status == ImportStatus.CONFIRMED:
        return "used"
    if imp is not None and imp.status == ImportStatus.PREVIEW:
        return "adding"
    if sub.check.get("errors"):
        return "errors"
    return "needs_top" if sub.topped_at is None else "ready"


def cities(sub: Submission) -> dict[str, dict[str, Any]]:
    """The file's cities; read from the file once for files handed in before step 32."""
    if "cities" not in sub.check:
        found = files.run(sub.content, sub.niche)
        sub.check = dict(sub.check, cities=found.check["cities"])
    found_cities: dict[str, dict[str, Any]] = sub.check["cities"]
    return found_cities


def lock_if_topped(sub: Submission) -> None:
    """A file without errors whose every city that is on has a Top is ready, and locked
    for Top Review."""
    if sub.check.get("errors") or sub.topped_at is not None:
        return
    if files.all_topped(cities(sub), sub.tops):
        sub.topped_at = now()


def _batch(sub: Submission) -> BatchRef | None:
    imp = sub.imp
    if imp is None or imp.status not in (ImportStatus.CONFIRMED, ImportStatus.PREVIEW):
        return None
    return BatchRef(
        batch_id=imp.batch_id,
        batch_name=imp.batch.name if imp.batch else None,
        import_id=imp.id,
        at=imp.confirmed_at or imp.created_at,
        by=imp.uploader.name if imp.uploader else None,
    )


def _same_as(db: Session, me: User, sub: Submission) -> str | None:
    """Another file with the same leads: named when the person may see it."""
    others = list(
        db.scalars(
            select(Submission)
            .where(Submission.sha256 == sub.sha256, Submission.id != sub.id)
            .order_by(Submission.created_at)
        )
    )
    if not others:
        return None
    shown = [o for o in others if _may_see(me, o)]
    if not shown:
        return "The same leads were handed in before as another file."
    first = next((o for o in shown if status_of(o) == "used"), shown[0])
    where = _batch(first)
    if where and status_of(first) == "used":
        return f'Same leads as "{first.file_name}", used in {where.batch_name or "a batch"}.'
    return f'Same leads as "{first.file_name}".'


def _out(db: Session, me: User, sub: Submission) -> FileOut:
    on = files.cities_on(cities(sub))
    return FileOut(
        id=sub.id,
        file_name=sub.file_name,
        niche=sub.niche,
        version=sub.version,
        businesses=sub.businesses,
        errors=int(sub.check.get("errors", 0)),
        warnings=int(sub.check.get("warnings", 0)),
        status=status_of(sub),
        uploaded_by=sub.uploader.name if sub.uploader else None,
        mine=sub.uploaded_by == me.id,
        created_at=sub.created_at,
        updated_at=sub.updated_at,
        batch=_batch(sub),
        same_as=_same_as(db, me, sub),
        cities_on=len(on),
        cities_topped=sum(1 for key in on if sub.tops.get(key)),
    )


def _detail(db: Session, me: User, sub: Submission) -> FileDetail:
    return FileDetail(
        **_out(db, me, sub).model_dump(),
        tabs=sub.check.get("tabs", {}),
        problems=sub.problems,
    )


def _may_see(me: User, sub: Submission) -> bool:
    if can(me, Action.VIEW_ALL_FILES):
        return True
    return can(me, Action.SUBMIT_FILES) and sub.uploaded_by == me.id


def _get(db: Session, me: User, file_id: uuid.UUID) -> Submission:
    """A file the person may see; someone else's file reads as not there for a Collector."""
    sub = db.get(Submission, file_id)
    if sub is None or not _may_see(me, sub):
        raise ApiError(404, "not_found", "That file doesn't exist.")
    return sub


def _changeable(db: Session, me: User, file_id: uuid.UUID, revise: bool) -> Submission:
    """A file the person may revise or delete: their own (or any, for Owners and Admins).
    Once it has no error it is done for the Collectors (step 32): it is only revised while it
    has errors, and only Owners and Admins delete it then, until it is added to a batch."""
    sub = _get(db, me, file_id)
    ensure(me, Action.SUBMIT_FILES)
    if sub.uploaded_by != me.id and not can(me, Action.USE_FILES):
        raise ApiError(403, "forbidden", "Only the person who handed it in can change it.")
    status = status_of(sub)
    if status == "used":
        raise ApiError(409, "used", "This file is used in a batch: it can't be changed.")
    if status == "adding":
        raise ApiError(
            409, "adding", "This file is being added to a batch: confirm or discard it there."
        )
    if status != "errors" and (revise or not can(me, Action.USE_FILES)):
        raise ApiError(409, "no_errors", "This file has no errors: it can't be changed any more.")
    return sub


def _niches(db: Session) -> dict[str, str]:
    known = db.scalars(select(Benchmark.niche).union(select(Batch.niche)))
    spellings: dict[str, str] = {}
    for niche in known:
        spellings.setdefault(niche.strip().lower(), niche)
    return spellings


def _read(file: UploadFile) -> bytes:
    content = file.file.read(MAX_BYTES + 1)
    if len(content) > MAX_BYTES:
        raise ApiError(413, "too_large", "The file is over 20 MB.", {"file": "Over 20 MB."})
    return content


def _check(sub: Submission, content: bytes) -> None:
    try:
        content = files.clean(content)
        found = files.run(content, sub.niche)
    except reader.ReadError as error:
        raise ApiError(422, "unreadable", str(error), {"file": str(error)}) from None
    sub.content = content
    sub.sha256 = found.fingerprint
    sub.businesses = found.businesses
    sub.check = found.check
    sub.problems = found.problems
    sub.tops = {}
    sub.topped_at = None
    lock_if_topped(sub)


@router.get("/submissions/niches", response_model=list[NicheName])
def niches(me: CurrentUser, db: Db) -> list[str]:
    """The niches a file can be handed in for (those of the benchmarks and batches)."""
    ensure(me, Action.SUBMIT_FILES)
    return sorted(_niches(db).values(), key=str.lower)


@router.get("/submissions", response_model=list[FileOut])
def list_files(me: CurrentUser, db: Db) -> list[FileOut]:
    if not can(me, Action.VIEW_ALL_FILES):
        ensure(me, Action.SUBMIT_FILES)
    query = select(Submission).order_by(Submission.created_at.desc()).limit(500)
    if not can(me, Action.VIEW_ALL_FILES):
        query = query.where(Submission.uploaded_by == me.id)
    found = [_out(db, me, sub) for sub in db.scalars(query)]
    db.commit()  # the cities of files handed in before step 32 were read just now
    return found


@router.post("/submissions", response_model=FileDetail, status_code=201)
def hand_in(
    me: CurrentUser,
    db: Db,
    file: Annotated[UploadFile, File()],
    niche: Annotated[str, Form(), StringConstraints(strip_whitespace=True, max_length=80)],
) -> FileDetail:
    """Hand in a lead file: Lead Check runs on it at once."""
    ensure(me, Action.SUBMIT_FILES)
    chosen = _niches(db).get(niche.lower())
    if chosen is None:
        raise ApiError(422, "unknown_niche", "Choose one of the niches.", {"niche": "Unknown."})
    content = _read(file)
    sub = Submission(
        file_name=(file.filename or "leads.xlsx")[:255], niche=chosen, uploaded_by=me.id
    )
    _check(sub, content)
    db.add(sub)
    db.flush()
    audit.record(db, me, "hand in", "file", sub.id, sub.file_name, [])
    db.commit()
    db.refresh(sub)
    return _detail(db, me, sub)


@router.get("/submissions/{file_id}", response_model=FileDetail)
def get_file(file_id: uuid.UUID, me: CurrentUser, db: Db) -> FileDetail:
    found = _detail(db, me, _get(db, me, file_id))
    db.commit()
    return found


@router.post("/submissions/{file_id}/version", response_model=FileDetail)
def revise(
    file_id: uuid.UUID, me: CurrentUser, db: Db, file: Annotated[UploadFile, File()]
) -> FileDetail:
    """A revised version replaces the file and is checked again."""
    sub = _changeable(db, me, file_id, revise=True)
    _check(sub, _read(file))
    sub.version += 1
    sub.import_id = None  # a discarded preview of the old version is forgotten
    audit.record(
        db,
        me,
        "revise",
        "file",
        sub.id,
        sub.file_name,
        [{"field": "version", "from": sub.version - 1, "to": sub.version}],
    )
    db.commit()
    db.refresh(sub)
    return _detail(db, me, sub)


@router.get("/submissions/{file_id}/marked.xlsx")
def marked(file_id: uuid.UUID, me: CurrentUser, db: Db) -> Response:
    """The file with each problem marked, to fix offline and upload as a revised version."""
    sub = _get(db, me, file_id)
    try:
        content = files.marked(sub.content, sub.problems, sub.check)
    except reader.ReadError as error:
        raise ApiError(422, "unreadable", str(error)) from None
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", sub.file_name.rsplit(".", 1)[0])[:80]
    name = f"{stem or 'file'}-v{sub.version}-to-fix.xlsx"
    return Response(
        content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


@router.delete("/submissions/{file_id}", status_code=204)
def delete_file(file_id: uuid.UUID, me: CurrentUser, db: Db) -> None:
    """Delete a file before it is added to a batch."""
    sub = _changeable(db, me, file_id, revise=False)
    audit.record(db, me, "delete", "file", sub.id, sub.file_name, [])
    db.delete(sub)
    db.commit()


class UseIn(Strict):
    batch_id: uuid.UUID


@router.post("/submissions/{file_id}/use", response_model=FileOut)
def use(file_id: uuid.UUID, body: UseIn, me: CurrentUser, db: Db) -> FileOut:
    """Add a ready file to a batch of its niche: its preview waits in the batch, as if it
    were uploaded there. Once that preview is confirmed the file is used, for good."""
    ensure(me, Action.USE_FILES)
    ensure(me, Action.IMPORT_LEADS)
    sub = db.scalar(select(Submission).where(Submission.id == file_id).with_for_update())
    if sub is None:
        raise ApiError(404, "not_found", "That file doesn't exist.")
    status = status_of(sub)
    if status == "used":
        where = _batch(sub)
        name = where.batch_name if where else None
        raise ApiError(409, "used", f"This file is already used in {name or 'a batch'}.")
    if status == "adding":
        raise ApiError(
            409, "adding", "This file is already being added to a batch: confirm or discard it."
        )
    if status == "errors":
        raise ApiError(409, "not_ready", "This file still has errors: it has to be fixed first.")
    if status == "needs_top":
        raise ApiError(
            409, "needs_top", "Top isn't chosen in every city of this file yet (Top Review)."
        )
    batch = get_batch(db, body.batch_id)
    if batch.niche.strip().lower() != sub.niche.strip().lower():
        raise ApiError(
            409,
            "other_niche",
            f"This file is for {sub.niche}; {batch.name} is a {batch.niche} batch.",
        )
    twin = [
        other
        for other in db.scalars(
            select(Submission).where(Submission.sha256 == sub.sha256, Submission.id != sub.id)
        )
        if status_of(other) == "used"
    ]
    if twin:
        where = _batch(twin[0])
        name = where.batch_name if where else None
        raise ApiError(
            409,
            "same_leads_used",
            f'The same leads were already used ("{twin[0].file_name}" in {name or "a batch"}).',
        )
    tops = {key for chosen in sub.tops.values() for key in chosen}
    imp = service.preview(db, me, sub.file_name, sub.content, batch, tops)
    db.flush()
    sub.import_id = imp.id
    audit.record(db, me, "upload", "import", imp.id, imp.file_name, [])
    audit.record(
        db,
        me,
        "add to batch",
        "file",
        sub.id,
        sub.file_name,
        [{"field": "batch", "from": None, "to": batch.name}],
    )
    db.commit()
    db.refresh(sub)
    return _out(db, me, sub)


@router.post("/submissions/{file_id}/reopen", response_model=FileOut)
def reopen(file_id: uuid.UUID, me: CurrentUser, db: Db) -> FileOut:
    """Give a ready file back to Top Review (its Tops are kept), before it is used."""
    ensure(me, Action.USE_FILES)
    sub = _get(db, me, file_id)
    if status_of(sub) != "ready":
        raise ApiError(409, "not_ready", "Only a ready file that isn't in a batch is reopened.")
    sub.topped_at = None
    audit.record(db, me, "reopen for Top Review", "file", sub.id, sub.file_name, [])
    db.commit()
    db.refresh(sub)
    return _out(db, me, sub)
