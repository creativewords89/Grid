"""`/api/imports`, a batch's cities and `/api/niches`: files added to a batch and the cities
they bring (SPEC sections 6.4 and 7). Owners and Admins upload, confirm and delete files and
switch cities; everyone sees the files and the cities."""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, File, Form, Query, UploadFile
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit
from app.api.batches import get_batch
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.db.models import (
    Batch,
    BatchStatus,
    Benchmark,
    Import,
    ImportStatus,
    Lead,
    LeadFile,
    LeadList,
)
from app.errors import ApiError
from app.imports import service
from app.leads import files
from app.permissions import Action, ensure

router = APIRouter(tags=["imports"])

MAX_BYTES = 20 * 1024 * 1024


class ImportOut(BaseModel):
    id: uuid.UUID
    file_name: str
    niche: str
    batch_id: uuid.UUID | None
    batch_name: str | None
    status: str
    uploaded_by: str | None
    created_at: datetime
    confirmed_at: datetime | None
    counts: dict[str, Any]
    preview: dict[str, Any]

    @classmethod
    def of(cls, imp: Import) -> "ImportOut":
        return cls(
            id=imp.id,
            file_name=imp.file_name,
            niche=imp.niche,
            batch_id=imp.batch_id,
            batch_name=imp.batch.name if imp.batch else None,
            status=imp.status.value,
            uploaded_by=imp.uploader.name if imp.uploader else None,
            created_at=imp.created_at,
            confirmed_at=imp.confirmed_at,
            counts=imp.counts,
            preview=imp.preview,
        )


@router.post("/imports", response_model=ImportOut, status_code=201)
def upload(
    me: CurrentUser,
    db: Db,
    file: Annotated[UploadFile, File()],
    batch_id: Annotated[uuid.UUID, Form()],
) -> ImportOut:
    ensure(me, Action.IMPORT_LEADS)
    batch = get_batch(db, batch_id)
    content = file.file.read(MAX_BYTES + 1)
    if len(content) > MAX_BYTES:
        raise ApiError(413, "too_large", "The file is over 20 MB.", {"file": "Over 20 MB."})
    imp = service.preview(db, me, file.filename or "leads.xlsx", content, batch)
    audit.record(db, me, "upload", "import", imp.id, imp.file_name, [])
    db.commit()
    db.refresh(imp)
    return ImportOut.of(imp)


@router.get("/imports", response_model=list[ImportOut])
def list_imports(
    me: CurrentUser, db: Db, batch_id: Annotated[uuid.UUID | None, Query()] = None
) -> list[ImportOut]:
    ensure(me, Action.VIEW_HUB)
    query = select(Import).order_by(Import.created_at.desc()).limit(30)
    if batch_id is not None:
        query = query.where(Import.batch_id == batch_id)
    return [ImportOut.of(imp) for imp in db.scalars(query)]


def _get(db: Session, import_id: uuid.UUID) -> Import:
    imp = db.get(Import, import_id)
    if imp is None:
        raise ApiError(404, "not_found", "That import doesn't exist.")
    return imp


@router.get("/imports/{import_id}", response_model=ImportOut)
def get_import(import_id: uuid.UUID, me: CurrentUser, db: Db) -> ImportOut:
    ensure(me, Action.VIEW_HUB)
    return ImportOut.of(_get(db, import_id))


@router.get("/imports/{import_id}/sheet")
def sheet(
    import_id: uuid.UUID,
    me: CurrentUser,
    db: Db,
    tab: Annotated[str | None, Query(max_length=120)] = None,
    status: Annotated[
        Literal["new", "updated", "other_batch", "merged", "top", "skipped"] | None, Query()
    ] = None,
    page: Annotated[int, Query(ge=1, le=10_000)] = 1,
) -> dict[str, Any]:
    """The file tab by tab: every row with every column and what happens (or happened) to
    it (SPEC section 6.4)."""
    ensure(me, Action.VIEW_HUB)
    return service.sheet_page(db, _get(db, import_id), tab, status, page)


@router.post("/imports/{import_id}/confirm", response_model=ImportOut)
def confirm(import_id: uuid.UUID, me: CurrentUser, db: Db) -> ImportOut:
    ensure(me, Action.IMPORT_LEADS)
    imp = service.confirm(db, _get(db, import_id), me)
    audit.record(db, me, "confirm", "import", imp.id, imp.file_name, [])
    db.commit()
    db.refresh(imp)
    return ImportOut.of(imp)


@router.post("/imports/{import_id}/discard", response_model=ImportOut)
def discard(import_id: uuid.UUID, me: CurrentUser, db: Db) -> ImportOut:
    ensure(me, Action.IMPORT_LEADS)
    imp = _get(db, import_id)
    service.discard(imp)
    db.commit()
    return ImportOut.of(imp)


# --- deleting a file (SPEC section 6.4 item 11) -----------------------------------------------


class DeletionOut(BaseModel):
    leads_going: int  # leads this file brought in first
    leads_staying: int  # leads from earlier files it only updated
    batch_running: bool  # then it can't be deleted: pause the batch first


def _deletion(db: Session, imp: Import) -> DeletionOut:
    going = set(db.scalars(select(Lead.lead_id).where(Lead.first_import_id == imp.id)))
    touched = {
        row["lead_id"] for row in (imp.sheet or {}).get("rows", []) if row.get("lead_id")
    } or set(db.scalars(select(Lead.lead_id).where(Lead.last_import_id == imp.id)))
    staying = db.scalar(
        select(func.count()).select_from(Lead).where(Lead.lead_id.in_(touched - going))
    )
    return DeletionOut(
        leads_going=len(going),
        leads_staying=staying or 0,
        batch_running=bool(imp.batch and imp.batch.status == BatchStatus.RUNNING),
    )


@router.get("/imports/{import_id}/deletion", response_model=DeletionOut)
def deletion(import_id: uuid.UUID, me: CurrentUser, db: Db) -> DeletionOut:
    """What deleting this file would take with it."""
    ensure(me, Action.VIEW_HUB)
    return _deletion(db, _get(db, import_id))


@router.delete("/imports/{import_id}", status_code=204)
def delete_import(import_id: uuid.UUID, me: CurrentUser, db: Db) -> None:
    """Delete a file with the leads it brought in first (their agents' results and files
    too), only while its batch isn't running. Do-not-contact entries stay."""
    ensure(me, Action.IMPORT_LEADS)
    imp = _get(db, import_id)
    if imp.status == ImportStatus.PREVIEW:
        raise ApiError(409, "waiting", "This file is waiting for its preview: discard it.")
    what = _deletion(db, imp)
    if what.batch_running:
        raise ApiError(
            409, "batch_running", "The batch is running: pause the batch first, then delete."
        )
    going = list(db.scalars(select(Lead).where(Lead.first_import_id == imp.id)))
    stored = [
        (lead_id, file_id)
        for lead_id, file_id in db.execute(
            select(LeadFile.lead_id, LeadFile.id).where(
                LeadFile.lead_id.in_([x.lead_id for x in going])
            )
        )
    ]
    for lead in going:
        db.delete(lead)
    db.flush()
    if imp.batch_id is not None:
        _drop_empty_cities(db, imp.batch_id)
        db.flush()
        service.mute_small_cities(db, imp.batch_id)
    audit.record(
        db,
        me,
        "delete",
        "import",
        imp.id,
        imp.file_name,
        [{"field": "leads deleted", "from": what.leads_going, "to": 0}],
    )
    db.delete(imp)
    db.commit()
    for lead_id, file_id in stored:
        files.remove(lead_id, file_id)


def _drop_empty_cities(db: Session, batch_id: uuid.UUID) -> None:
    """A batch's cities without leads any more go."""
    used = set(
        db.scalars(select(func.lower(Lead.city)).where(Lead.batch_id == batch_id).distinct())
    )
    for item in db.scalars(select(LeadList).where(LeadList.batch_id == batch_id)):
        if item.city.lower() not in used:
            db.delete(item)


# --- a batch's cities (SPEC section 6.4 item 8) --------------------------------------------


class FileRef(BaseModel):
    id: uuid.UUID
    file_name: str
    confirmed_at: datetime | None


class ListOut(BaseModel):
    id: uuid.UUID
    batch_id: uuid.UUID
    city: str
    niche: str
    active: bool
    set_by_hand: bool  # a person switched it; the small-city rule leaves it alone
    small: bool  # fewer than 10 businesses: listed on the Small cities tab
    daily_limit: int | None
    leads: int
    top: int
    ready: bool  # a Top chosen: agents may work on it (SPEC step 20); Not ready otherwise
    added_from: FileRef | None  # the file the city first came with (step 22)
    new: bool  # it came with the batch's latest file


def _cities(db: Session, batch_id: uuid.UUID) -> list[ListOut]:
    counts = {
        city.lower(): (total, top)
        for city, total, top in db.execute(
            select(Lead.city, func.count(), func.count().filter(Lead.level == "Top"))
            .where(Lead.batch_id == batch_id)
            .group_by(Lead.city)
        )
    }
    # The file a city first came with: the oldest file that brought one of its businesses
    # into this batch (each lead keeps the file it first came from). Worked out each time, so
    # deleting that file moves it to the next one.
    first: dict[str, FileRef] = {}
    for city, file_id, file_name, confirmed_at, _ in db.execute(
        select(Lead.city, Import.id, Import.file_name, Import.confirmed_at, Import.created_at)
        .join(Import, Import.id == Lead.first_import_id)
        .where(Lead.batch_id == batch_id)
        .distinct()
        .order_by(Import.confirmed_at, Import.created_at)
    ):
        first.setdefault(
            city.lower(), FileRef(id=file_id, file_name=file_name, confirmed_at=confirmed_at)
        )
    latest = db.scalar(
        select(Import.id)
        .where(Import.batch_id == batch_id, Import.status == ImportStatus.CONFIRMED)
        .order_by(Import.confirmed_at.desc(), Import.created_at.desc())
        .limit(1)
    )
    out = []
    for item in db.scalars(
        select(LeadList).where(LeadList.batch_id == batch_id).order_by(func.lower(LeadList.city))
    ):
        total, top = counts.get(item.city.lower(), (0, 0))
        origin = first.get(item.city.lower())
        out.append(
            ListOut(
                id=item.id,
                batch_id=item.batch_id,
                city=item.city,
                niche=item.niche,
                active=item.active,
                set_by_hand=item.set_by_hand,
                small=total < service.SMALL_CITY,
                daily_limit=item.daily_limit,
                leads=total,
                top=top,
                ready=top > 0,
                added_from=origin,
                new=origin is not None and origin.id == latest,
            )
        )
    return out


@router.get("/batches/{batch_id}/cities", response_model=list[ListOut])
def batch_cities(batch_id: uuid.UUID, me: CurrentUser, db: Db) -> list[ListOut]:
    ensure(me, Action.VIEW_HUB)
    return _cities(db, get_batch(db, batch_id).id)


class AllCitiesIn(Strict):
    active: bool
    small: bool | None = None  # only the small cities (True), only the others (False)
    ready: bool | None = None  # and only the ready ones (True) or not ready (False)


@router.put("/batches/{batch_id}/cities", response_model=list[ListOut])
def switch_all_cities(
    batch_id: uuid.UUID, body: AllCitiesIn, me: CurrentUser, db: Db
) -> list[ListOut]:
    """All on or all off (on the tab shown: Ready, Not ready or Small cities). They count
    as switched by hand from then on."""
    ensure(me, Action.OPERATE_AGENTS)
    batch = get_batch(db, batch_id)
    shown = {c.id: c for c in _cities(db, batch.id)}
    changed = 0
    for item in db.scalars(select(LeadList).where(LeadList.batch_id == batch.id)):
        city = shown[item.id]
        if body.small is not None and city.small != body.small:
            continue
        if body.ready is not None and city.ready != body.ready:
            continue
        item.set_by_hand = True
        if item.active != body.active:
            item.active = body.active
            changed += 1
    if changed:
        audit.record(
            db,
            me,
            "edit",
            "batch",
            batch.id,
            batch.name,
            [{"field": "cities", "from": None, "to": "all on" if body.active else "all off"}],
        )
    db.commit()
    return _cities(db, batch.id)


class ListPatch(Strict):
    active: bool | None = None
    daily_limit: Annotated[int, Field(ge=1, le=100_000)] | None = None
    clear_daily_limit: bool = False


@router.patch("/lists/{list_id}", response_model=ListOut)
def update_list(list_id: uuid.UUID, body: ListPatch, me: CurrentUser, db: Db) -> ListOut:
    ensure(me, Action.OPERATE_AGENTS)
    item = db.get(LeadList, list_id)
    if item is None:
        raise ApiError(404, "not_found", "That city doesn't exist.")
    before = {"active": item.active, "daily_limit": item.daily_limit}
    if body.active is not None:
        item.active = body.active
        item.set_by_hand = True
    if body.daily_limit is not None:
        item.daily_limit = body.daily_limit
    if body.clear_daily_limit:
        item.daily_limit = None
    changes = audit.diff(before, {"active": item.active, "daily_limit": item.daily_limit})
    if changes:
        audit.record(db, me, "edit", "list", item.id, f"{item.city} · {item.niche}", changes)
    db.commit()
    return next(x for x in _cities(db, item.batch_id) if x.id == item.id)


NicheName = Annotated[str, StringConstraints(max_length=80)]


@router.get("/niches", response_model=list[str])
def niches(me: CurrentUser, db: Db) -> list[NicheName]:
    ensure(me, Action.VIEW_HUB)
    known = db.scalars(select(Benchmark.niche).union(select(Batch.niche)))
    spellings: dict[str, str] = {}
    for niche in known:
        spellings.setdefault(niche.lower(), niche)
    return sorted(spellings.values(), key=str.lower)
