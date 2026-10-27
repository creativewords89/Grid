"""`/api/imports`, `/api/lists` and `/api/niches`: the Import screen (SPEC sections 6.4
and 7). Owners and Admins upload and confirm; everyone sees the history and the lists."""

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, File, Form, UploadFile
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.db.models import Import, Lead, LeadList
from app.errors import ApiError
from app.imports import service
from app.permissions import Action, ensure

router = APIRouter(tags=["imports"])

MAX_BYTES = 20 * 1024 * 1024


class ImportOut(BaseModel):
    id: uuid.UUID
    file_name: str
    niche: str
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
            status=imp.status.value,
            uploaded_by=imp.uploader.name if imp.uploader else None,
            created_at=imp.created_at,
            confirmed_at=imp.confirmed_at,
            counts=imp.counts,
            preview=imp.preview,
        )


def _niche(db: Session, typed: str) -> str:
    """A typed niche, spelt like an existing one when only the case differs."""
    name = " ".join(typed.split())
    if not name or len(name) > 80:
        raise ApiError(422, "invalid", "Enter the niche, like Cleaning.", {"niche": "Required."})
    for existing in db.scalars(select(LeadList.niche).distinct()):
        if existing.lower() == name.lower():
            return existing
    return name


@router.post("/imports", response_model=ImportOut, status_code=201)
def upload(
    me: CurrentUser,
    db: Db,
    file: Annotated[UploadFile, File()],
    niche: Annotated[str, Form()],
) -> ImportOut:
    ensure(me, Action.IMPORT_LEADS)
    content = file.file.read(MAX_BYTES + 1)
    if len(content) > MAX_BYTES:
        raise ApiError(413, "too_large", "The file is over 20 MB.", {"file": "Over 20 MB."})
    imp = service.preview(db, me, file.filename or "leads.xlsx", content, _niche(db, niche))
    audit.record(db, me, "upload", "import", imp.id, imp.file_name, [])
    db.commit()
    db.refresh(imp)
    return ImportOut.of(imp)


@router.get("/imports", response_model=list[ImportOut])
def list_imports(me: CurrentUser, db: Db) -> list[ImportOut]:
    ensure(me, Action.VIEW_HUB)
    found = db.scalars(select(Import).order_by(Import.created_at.desc()).limit(30))
    return [ImportOut.of(imp) for imp in found]


def _get(db: Session, import_id: uuid.UUID) -> Import:
    imp = db.get(Import, import_id)
    if imp is None:
        raise ApiError(404, "not_found", "That import doesn't exist.")
    return imp


@router.get("/imports/{import_id}", response_model=ImportOut)
def get_import(import_id: uuid.UUID, me: CurrentUser, db: Db) -> ImportOut:
    ensure(me, Action.VIEW_HUB)
    return ImportOut.of(_get(db, import_id))


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


class ListOut(BaseModel):
    id: uuid.UUID
    city: str
    niche: str
    active: bool
    daily_limit: int | None
    leads: int
    top: int


@router.get("/lists", response_model=list[ListOut])
def list_lists(me: CurrentUser, db: Db) -> list[ListOut]:
    ensure(me, Action.VIEW_HUB)
    counts = {
        (city.lower(), niche.lower()): (total, top)
        for city, niche, total, top in db.execute(
            select(
                Lead.city,
                Lead.niche,
                func.count(),
                func.count().filter(Lead.level == "Top"),
            ).group_by(Lead.city, Lead.niche)
        )
    }
    out = []
    for item in db.scalars(select(LeadList).order_by(LeadList.niche, LeadList.city)):
        total, top = counts.get((item.city.lower(), item.niche.lower()), (0, 0))
        out.append(
            ListOut(
                id=item.id,
                city=item.city,
                niche=item.niche,
                active=item.active,
                daily_limit=item.daily_limit,
                leads=total,
                top=top,
            )
        )
    return out


class ListPatch(Strict):
    active: bool | None = None
    daily_limit: Annotated[int, Field(ge=1, le=100_000)] | None = None
    clear_daily_limit: bool = False


@router.patch("/lists/{list_id}", response_model=ListOut)
def update_list(list_id: uuid.UUID, body: ListPatch, me: CurrentUser, db: Db) -> ListOut:
    ensure(me, Action.OPERATE_AGENTS)
    item = db.get(LeadList, list_id)
    if item is None:
        raise ApiError(404, "not_found", "That list doesn't exist.")
    before = {"active": item.active, "daily_limit": item.daily_limit}
    if body.active is not None:
        item.active = body.active
    if body.daily_limit is not None:
        item.daily_limit = body.daily_limit
    if body.clear_daily_limit:
        item.daily_limit = None
    changes = audit.diff(before, {"active": item.active, "daily_limit": item.daily_limit})
    if changes:
        audit.record(db, me, "edit", "list", item.id, f"{item.city} · {item.niche}", changes)
    db.commit()
    return next(x for x in list_lists(me, db) if x.id == item.id)


NicheName = Annotated[str, StringConstraints(max_length=80)]


@router.get("/niches", response_model=list[str])
def niches(me: CurrentUser, db: Db) -> list[NicheName]:
    ensure(me, Action.VIEW_HUB)
    return list(db.scalars(select(LeadList.niche).distinct().order_by(LeadList.niche)))
