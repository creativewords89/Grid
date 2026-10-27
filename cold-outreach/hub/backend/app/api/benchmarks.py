"""`/api/benchmarks`: the Benchmarks screen (SPEC sections 6.5 and 7).

A benchmark is a named set, such as "Cleaning Benchmark 1", of one niche: the GBP numbers a
good profile has and the Website Standard. It doesn't depend on city or competition. Each
batch uses one benchmark. Changing the numbers or the standard raises the version, and the
agents check the leads of the batches that use it again.
"""

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter
from pydantic import BaseModel, Field, StringConstraints, ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app import audit
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.benchmarks.standard import Gbp, Standard
from app.db.models import Batch, Benchmark
from app.errors import ApiError
from app.permissions import Action, can, ensure

router = APIRouter(tags=["benchmarks"])

Text = Annotated[str, StringConstraints(strip_whitespace=True, max_length=120)]


class BenchmarkOut(BaseModel):
    id: uuid.UUID
    name: str
    niche: str
    version: int
    gbp: dict[str, Any]
    website: dict[str, Any]
    batches: list[str]  # the batches that use it
    updated_by: str | None
    updated_at: datetime
    can_edit: bool


def out(db: Session, me: CurrentUser, row: Benchmark) -> BenchmarkOut:
    batches = db.scalars(
        select(Batch.name).where(Batch.benchmark_id == row.id).order_by(Batch.created_at)
    )
    return BenchmarkOut(
        id=row.id,
        name=row.name,
        niche=row.niche,
        version=row.version,
        gbp=row.gbp,
        website=row.website,
        batches=list(batches),
        updated_by=row.editor.name if row.editor else None,
        updated_at=row.updated_at,
        can_edit=can(me, Action.EDIT_BENCHMARKS),
    )


def get_benchmark(db: Session, benchmark_id: uuid.UUID) -> Benchmark:
    row = db.get(Benchmark, benchmark_id)
    if row is None:
        raise ApiError(404, "not_found", "That benchmark doesn't exist.")
    return row


def niche_spelling(db: Session, typed: str) -> str:
    """A typed niche, spelt like an existing one when only the case differs."""
    name = " ".join(typed.split())
    if not name or len(name) > 80:
        raise ApiError(422, "invalid", "Enter the niche, like Cleaning.", {"niche": "Required."})
    known = db.scalars(select(Benchmark.niche).union(select(Batch.niche)))
    return next((n for n in known if n.lower() == name.lower()), name)


class BenchmarkIn(Strict):
    name: Text
    niche: Text | None = None  # only when creating: a benchmark's niche never changes
    gbp: dict[str, Any] = Field(default_factory=dict)
    website: dict[str, Any] = Field(default_factory=dict)


def _check(body: BenchmarkIn) -> tuple[Gbp, Standard]:
    fields: dict[str, str] = {}
    if not body.name:
        fields["name"] = "Name the benchmark, like Cleaning Benchmark 1."
    checked: list[Any] = []
    for prefix, model, value in (("gbp", Gbp, body.gbp), ("website", Standard, body.website)):
        try:
            checked.append(model.model_validate(value))
        except ValidationError as error:
            for item in error.errors():
                where = ".".join([prefix, *(str(p) for p in item["loc"])])
                message = str(item["msg"]).removeprefix("Value error, ")
                fields.setdefault(where, message[:1].upper() + message[1:] + ".")
    if fields:
        raise ApiError(422, "invalid", next(iter(fields.values())), fields)
    return checked[0], checked[1]


def _name_taken(db: Session, name: str, other_than: uuid.UUID | None = None) -> None:
    found = db.scalar(select(Benchmark.id).where(func.lower(Benchmark.name) == name.lower()))
    if found is not None and found != other_than:
        raise ApiError(409, "name_taken", "Another benchmark has this name.", {"name": "Taken."})


@router.get("/benchmarks", response_model=list[BenchmarkOut])
def list_benchmarks(me: CurrentUser, db: Db) -> list[BenchmarkOut]:
    ensure(me, Action.VIEW_HUB)
    rows = db.scalars(
        select(Benchmark)
        .options(selectinload(Benchmark.editor))
        .order_by(Benchmark.niche, Benchmark.created_at)
    )
    return [out(db, me, row) for row in rows]


@router.get("/benchmarks/{benchmark_id}", response_model=BenchmarkOut)
def read_benchmark(benchmark_id: uuid.UUID, me: CurrentUser, db: Db) -> BenchmarkOut:
    ensure(me, Action.VIEW_HUB)
    return out(db, me, get_benchmark(db, benchmark_id))


@router.post("/benchmarks", response_model=BenchmarkOut, status_code=201)
def create_benchmark(body: BenchmarkIn, me: CurrentUser, db: Db) -> BenchmarkOut:
    ensure(me, Action.EDIT_BENCHMARKS)
    niche = niche_spelling(db, body.niche or "")
    gbp, website = _check(body)
    _name_taken(db, body.name)
    row = Benchmark(
        name=body.name,
        niche=niche,
        gbp=gbp.model_dump(mode="json", exclude_none=True),
        website=website.model_dump(mode="json"),
        version=1,
        updated_by=me.id,
    )
    db.add(row)
    db.flush()
    audit.record(db, me, "create", "benchmark", row.id, row.name, [])
    db.commit()
    return out(db, me, row)


@router.put("/benchmarks/{benchmark_id}", response_model=BenchmarkOut)
def update_benchmark(
    benchmark_id: uuid.UUID, body: BenchmarkIn, me: CurrentUser, db: Db
) -> BenchmarkOut:
    """Save the name, numbers and standard. A change of the numbers or the standard is a new
    version: agents check the leads of every batch that uses it again."""
    ensure(me, Action.EDIT_BENCHMARKS)
    row = get_benchmark(db, benchmark_id)
    gbp, website = _check(body)
    _name_taken(db, body.name, other_than=row.id)
    before = {"name": row.name, "gbp": row.gbp, "website": row.website}
    row.name = body.name
    row.gbp = gbp.model_dump(mode="json", exclude_none=True)
    row.website = website.model_dump(mode="json")
    changes = audit.diff(before, {"name": row.name, "gbp": row.gbp, "website": row.website})
    if any(change["field"] != "name" for change in changes):
        row.version += 1
    if changes:
        row.updated_by = me.id
        summary = [
            {"field": c["field"], "from": c["from"], "to": c["to"]}
            if c["field"] != "website"
            else {"field": "website", "from": "…", "to": f"(version {row.version})"}
            for c in changes
        ]
        audit.record(db, me, "edit", "benchmark", row.id, row.name, summary)
    db.commit()
    db.refresh(row)
    return out(db, me, row)


@router.delete("/benchmarks/{benchmark_id}", status_code=204)
def delete_benchmark(benchmark_id: uuid.UUID, me: CurrentUser, db: Db) -> None:
    ensure(me, Action.EDIT_BENCHMARKS)
    row = get_benchmark(db, benchmark_id)
    used = db.scalar(select(func.count()).select_from(Batch).where(Batch.benchmark_id == row.id))
    if used:
        raise ApiError(
            409, "in_use", "Batches use this benchmark. Choose another one for them first."
        )
    audit.record(db, me, "delete", "benchmark", row.id, row.name, [])
    db.delete(row)
    db.commit()
