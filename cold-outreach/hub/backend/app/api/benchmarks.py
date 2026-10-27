"""`/api/benchmarks` and `/api/website-standards`: the Benchmarks screen (SPEC section 6.5).

GBP benchmarks come from an Excel file: upload with `apply=false` to see what it holds, then
again with `apply=true` to save it; each City + Niche row replaces that pair's benchmark.
Website Standards are edited as drafts by Owners and Admins and locked into numbered versions
by Owners; agents only ever see locked versions.
"""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, File, Form, UploadFile
from pydantic import BaseModel, ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit
from app.auth.deps import CurrentUser, Db
from app.auth.tokens import now
from app.benchmarks import gbp
from app.benchmarks.standard import Standard, version_label
from app.db.models import GbpBenchmark, WebsiteStandard
from app.errors import ApiError
from app.imports.reader import ReadError
from app.permissions import Action, can, ensure

router = APIRouter(tags=["benchmarks"])

MAX_BYTES = 5 * 1024 * 1024


class BenchmarkOut(BaseModel):
    id: uuid.UUID
    city: str
    niche: str
    additional_categories: Decimal | None
    services: Decimal | None
    photos: Decimal | None
    posts_90_days: Decimal | None
    description_length: Decimal | None
    reviews: Decimal | None
    rating: Decimal | None
    review_reply_pct: Decimal | None
    reference_businesses: str
    updated_at: datetime

    @classmethod
    def of(cls, row: GbpBenchmark) -> "BenchmarkOut":
        return cls.model_validate(row, from_attributes=True)


class UploadOut(BaseModel):
    applied: bool
    rows: list[dict[str, Any]]
    errors: list[str]
    ignored_columns: list[str]
    replaces: int  # pairs that already had a benchmark


def _find(db: Session, city: str, niche: str) -> GbpBenchmark | None:
    return db.scalar(
        select(GbpBenchmark).where(
            func.lower(GbpBenchmark.city) == city.lower(),
            func.lower(GbpBenchmark.niche) == niche.lower(),
        )
    )


@router.get("/benchmarks", response_model=list[BenchmarkOut])
def list_benchmarks(me: CurrentUser, db: Db) -> list[BenchmarkOut]:
    ensure(me, Action.VIEW_HUB)
    rows = db.scalars(select(GbpBenchmark).order_by(GbpBenchmark.niche, GbpBenchmark.city))
    return [BenchmarkOut.of(row) for row in rows]


@router.post("/benchmarks/upload", response_model=UploadOut)
def upload_benchmarks(
    me: CurrentUser,
    db: Db,
    file: Annotated[UploadFile, File()],
    apply: Annotated[bool, Form()] = False,
) -> UploadOut:
    ensure(me, Action.EDIT_BENCHMARKS)
    content = file.file.read(MAX_BYTES + 1)
    if len(content) > MAX_BYTES:
        raise ApiError(413, "too_large", "The file is over 5 MB.", {"file": "Over 5 MB."})
    try:
        report = gbp.read(content)
    except ReadError as error:
        raise ApiError(422, "unreadable", str(error), {"file": str(error)}) from None
    existing = [_find(db, row["city"], row["niche"]) for row in report.rows]
    out_rows = [
        {k: (str(v) if isinstance(v, Decimal) else v) for k, v in r.items()} for r in report.rows
    ]
    result = UploadOut(
        applied=False,
        rows=out_rows,
        errors=report.errors,
        ignored_columns=report.ignored_columns,
        replaces=sum(1 for found in existing if found is not None),
    )
    if not apply:
        return result
    if report.errors:
        raise ApiError(422, "has_errors", "Fix the rows listed first; nothing was saved.")
    for row, found in zip(report.rows, existing, strict=True):
        target = found or GbpBenchmark(city=row["city"], niche=row["niche"])
        for name, value in row.items():
            setattr(target, name, value)
        target.updated_by = me.id
        if found is None:
            db.add(target)
    audit.record(db, me, "upload", "benchmarks", None, file.filename, [{"rows": len(report.rows)}])
    db.commit()
    return result.model_copy(update={"applied": True})


@router.delete("/benchmarks/{benchmark_id}", status_code=204)
def delete_benchmark(benchmark_id: uuid.UUID, me: CurrentUser, db: Db) -> None:
    ensure(me, Action.EDIT_BENCHMARKS)
    row = db.get(GbpBenchmark, benchmark_id)
    if row is None:
        raise ApiError(404, "not_found", "That benchmark doesn't exist.")
    audit.record(db, me, "delete", "benchmark", row.id, f"{row.city} · {row.niche}", [])
    db.delete(row)
    db.commit()


# --- Website Standards ----------------------------------------------------------------------


class StandardVersionOut(BaseModel):
    version: int | None
    label: str | None
    standard: dict[str, Any]
    edited_by: str | None
    edited_at: datetime
    locked_by: str | None
    locked_at: datetime | None

    @classmethod
    def of(cls, row: WebsiteStandard) -> "StandardVersionOut":
        return cls(
            version=row.version,
            label=version_label(row.niche, row.version) if row.version else None,
            standard=row.standard,
            edited_by=row.editor.name if row.editor else None,
            edited_at=row.edited_at,
            locked_by=row.locker.name if row.locker else None,
            locked_at=row.locked_at,
        )


class NicheStandardOut(BaseModel):
    niche: str
    locked: StandardVersionOut | None
    draft: StandardVersionOut | None
    versions: list[int]
    can_edit: bool
    can_lock: bool


def _rows(db: Session, niche: str) -> list[WebsiteStandard]:
    return list(
        db.scalars(
            select(WebsiteStandard)
            .where(func.lower(WebsiteStandard.niche) == niche.lower())
            .order_by(WebsiteStandard.version.desc().nulls_first())
        )
    )


def _niche_out(db: Session, me: CurrentUser, niche: str) -> NicheStandardOut:
    rows = _rows(db, niche)
    draft = next((r for r in rows if r.version is None), None)
    locked = [r for r in rows if r.version is not None]
    return NicheStandardOut(
        niche=rows[0].niche if rows else niche,
        locked=StandardVersionOut.of(locked[0]) if locked else None,
        draft=StandardVersionOut.of(draft) if draft else None,
        versions=[r.version for r in locked if r.version is not None],
        can_edit=can(me, Action.EDIT_BENCHMARKS),
        can_lock=can(me, Action.LOCK_STANDARD),
    )


@router.get("/website-standards", response_model=list[NicheStandardOut])
def list_standards(me: CurrentUser, db: Db) -> list[NicheStandardOut]:
    ensure(me, Action.VIEW_HUB)
    niches = db.scalars(select(WebsiteStandard.niche).distinct().order_by(WebsiteStandard.niche))
    return [_niche_out(db, me, niche) for niche in niches]


@router.get("/website-standards/{niche}", response_model=NicheStandardOut)
def get_standard(niche: str, me: CurrentUser, db: Db) -> NicheStandardOut:
    ensure(me, Action.VIEW_HUB)
    return _niche_out(db, me, niche)


@router.get("/website-standards/{niche}/versions/{version}", response_model=StandardVersionOut)
def get_version(niche: str, version: int, me: CurrentUser, db: Db) -> StandardVersionOut:
    ensure(me, Action.VIEW_HUB)
    row = next((r for r in _rows(db, niche) if r.version == version), None)
    if row is None:
        raise ApiError(404, "not_found", "That version doesn't exist.")
    return StandardVersionOut.of(row)


def _check(body: dict[str, Any]) -> Standard:
    try:
        return Standard.model_validate(body)
    except ValidationError as error:
        fields = {
            ".".join(str(p) for p in item["loc"]) or "standard": str(item["msg"])
            for item in error.errors()
        }
        raise ApiError(422, "invalid", next(iter(fields.values())), fields) from None


@router.put("/website-standards/{niche}/draft", response_model=NicheStandardOut)
def save_draft(niche: str, body: dict[str, Any], me: CurrentUser, db: Db) -> NicheStandardOut:
    ensure(me, Action.EDIT_BENCHMARKS)
    name = " ".join(niche.split())
    if not name or len(name) > 80:
        raise ApiError(422, "invalid", "Name the niche.", {"niche": "Required."})
    standard = _check(body)
    rows = _rows(db, name)
    draft = next((r for r in rows if r.version is None), None)
    if draft is None:
        draft = WebsiteStandard(niche=rows[0].niche if rows else name, version=None, standard={})
        db.add(draft)
    draft.standard = standard.model_dump(mode="json")
    draft.edited_by = me.id
    draft.edited_at = now()
    audit.record(db, me, "edit", "website_standard", draft.niche, f"{draft.niche} draft", [])
    db.commit()
    return _niche_out(db, me, name)


@router.delete("/website-standards/{niche}/draft", response_model=NicheStandardOut)
def drop_draft(niche: str, me: CurrentUser, db: Db) -> NicheStandardOut:
    ensure(me, Action.EDIT_BENCHMARKS)
    draft = next((r for r in _rows(db, niche) if r.version is None), None)
    if draft is None:
        raise ApiError(404, "not_found", "There is no draft.")
    db.delete(draft)
    db.commit()
    return _niche_out(db, me, niche)


@router.post("/website-standards/{niche}/lock", response_model=NicheStandardOut)
def lock(niche: str, me: CurrentUser, db: Db) -> NicheStandardOut:
    """The draft becomes the next version; the Website agent uses it from its next run."""
    ensure(me, Action.LOCK_STANDARD)
    rows = _rows(db, niche)
    draft = next((r for r in rows if r.version is None), None)
    if draft is None:
        raise ApiError(409, "no_draft", "There is no draft to lock.")
    problem = Standard.model_validate(draft.standard).ready_problem()
    if problem:
        raise ApiError(422, "not_ready", problem)
    draft.version = max((r.version or 0 for r in rows), default=0) + 1
    draft.locked_by = me.id
    draft.locked_at = now()
    audit.record(
        db,
        me,
        "lock",
        "website_standard",
        draft.niche,
        version_label(draft.niche, draft.version),
        [],
    )
    db.commit()
    return _niche_out(db, me, niche)
