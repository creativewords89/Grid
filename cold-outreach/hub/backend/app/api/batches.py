"""`/api/batches`: the Batches screen (SPEC sections 6.4 and 7).

A batch is named by the team, holds the leads of one niche and uses one benchmark of that
niche. Files are added to a batch at any time; a business stays in the batch it was first
imported into. Its tasks and bots, Start/Pause and results are in `batch_pipeline.py`.
"""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter
from pydantic import BaseModel, StringConstraints
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit, pipeline
from app.api.benchmarks import get_benchmark, niche_spelling
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.db.models import Batch, FileCity, Import, ImportStatus, Lead
from app.errors import ApiError
from app.imports import file_cities
from app.permissions import Action, can, ensure

router = APIRouter(tags=["batches"])

Text = Annotated[str, StringConstraints(strip_whitespace=True, max_length=120)]


class BenchmarkRef(BaseModel):
    id: uuid.UUID
    name: str
    version: int


class BatchOut(BaseModel):
    id: uuid.UUID
    name: str
    niche: str
    benchmark: BenchmarkRef | None
    leads: int
    top: int
    files: int  # the files it shows (step 47), its niche's among them
    bots: list[str]  # the bots of its tasks
    status: str  # not_started, running or paused
    position: int  # the running order
    progress_pct: int | None  # share of its bots' work that is finished
    created_at: datetime
    can_edit: bool
    can_run: bool  # choose tasks and bots, Start/Pause, move up or down
    can_rename: bool
    can_delete: bool


def batch_out(db: Session, me: CurrentUser, batch: Batch) -> BatchOut:
    leads, top = db.execute(
        select(func.count(), func.count().filter(Lead.level == "Top")).where(
            Lead.batch_id == batch.id
        )
    ).one()
    saved = db.scalar(
        select(func.count())
        .select_from(Import)
        .where(Import.batch_id == batch.id, Import.status == ImportStatus.CONFIRMED)
    )
    # Its niche's files (step 47) and the lead files added on the batch itself.
    added = db.scalar(
        select(func.count())
        .select_from(Import)
        .where(
            Import.batch_id == batch.id,
            Import.status == ImportStatus.CONFIRMED,
            ~select(FileCity.id).where(FileCity.import_id == Import.id).exists(),
        )
    )
    files = len(file_cities.batch_files(db, batch)) + (added or 0)
    pending = db.scalar(
        select(func.count())
        .select_from(Import)
        .where(Import.batch_id == batch.id, Import.status == ImportStatus.PREVIEW)
    )
    flow = pipeline.Pipeline(db, batch)
    bots = [bot.agent.name for slot in flow.slots for bot in slot.bots]
    counts = flow.progress().values() if bots and leads else []
    finished = sum(c.done for c in counts)
    total = finished + sum(c.failed + c.ready + c.waiting for c in counts)
    benchmark = batch.benchmark
    staff = can(me, Action.IMPORT_LEADS)
    return BatchOut(
        id=batch.id,
        name=batch.name,
        niche=batch.niche,
        benchmark=BenchmarkRef(id=benchmark.id, name=benchmark.name, version=benchmark.version)
        if benchmark
        else None,
        leads=leads,
        top=top,
        files=files,
        bots=bots,
        status=batch.status,
        position=batch.position,
        progress_pct=round(100 * finished / total) if total else None,
        created_at=batch.created_at,
        can_edit=staff,
        can_run=can(me, Action.RUN_BATCHES),
        can_rename=staff,
        can_delete=staff and leads == 0 and not files and not saved and not pending,
    )


def get_batch(db: Session, batch_id: uuid.UUID) -> Batch:
    batch = db.get(Batch, batch_id)
    if batch is None:
        raise ApiError(404, "not_found", "That batch doesn't exist.")
    return batch


def _name(db: Session, typed: str, other_than: uuid.UUID | None = None) -> str:
    name = " ".join(typed.split())
    if not name:
        raise ApiError(422, "invalid", "Name the batch.", {"name": "Required."})
    found = db.scalar(select(Batch.id).where(func.lower(Batch.name) == name.lower()))
    if found is not None and found != other_than:
        raise ApiError(409, "name_taken", "Another batch has this name.", {"name": "Taken."})
    return name


def _benchmark_for(db: Session, niche: str, benchmark_id: uuid.UUID | None) -> uuid.UUID:
    if benchmark_id is None:
        raise ApiError(
            422, "invalid", "Choose the batch's benchmark.", {"benchmark_id": "Required."}
        )
    benchmark = get_benchmark(db, benchmark_id)
    if benchmark.niche.lower() != niche.lower():
        raise ApiError(
            422,
            "invalid",
            f"Choose a {niche} benchmark.",
            {"benchmark_id": f"This benchmark is for {benchmark.niche}."},
        )
    return benchmark.id


@router.get("/batches", response_model=list[BatchOut])
def list_batches(me: CurrentUser, db: Db) -> list[BatchOut]:
    ensure(me, Action.VIEW_HUB)
    batches = db.scalars(select(Batch).order_by(Batch.position, Batch.created_at))
    return [batch_out(db, me, batch) for batch in batches]


@router.get("/batches/{batch_id}", response_model=BatchOut)
def read_batch(batch_id: uuid.UUID, me: CurrentUser, db: Db) -> BatchOut:
    ensure(me, Action.VIEW_HUB)
    return batch_out(db, me, get_batch(db, batch_id))


class BatchIn(Strict):
    name: Text
    niche: Text
    benchmark_id: uuid.UUID | None = None


@router.post("/batches", response_model=BatchOut, status_code=201)
def create_batch(body: BatchIn, me: CurrentUser, db: Db) -> BatchOut:
    ensure(me, Action.IMPORT_LEADS)
    name = _name(db, body.name)
    niche = niche_spelling(db, body.niche)
    batch = Batch(
        name=name,
        niche=niche,
        benchmark_id=_benchmark_for(db, niche, body.benchmark_id),
        created_by=me.id,
        position=(db.scalar(select(func.max(Batch.position))) or 0) + 1,
    )
    db.add(batch)
    db.flush()
    audit.record(db, me, "create", "batch", batch.id, batch.name, [])
    db.commit()
    db.refresh(batch)
    return batch_out(db, me, batch)


class BatchPatch(Strict):
    name: Text | None = None
    benchmark_id: uuid.UUID | None = None


@router.patch("/batches/{batch_id}", response_model=BatchOut)
def update_batch(batch_id: uuid.UUID, body: BatchPatch, me: CurrentUser, db: Db) -> BatchOut:
    """Rename a batch, or choose another benchmark of its niche (the agents then check its
    leads against that one)."""
    ensure(me, Action.IMPORT_LEADS)
    batch = get_batch(db, batch_id)
    before = {"name": batch.name, "benchmark": batch.benchmark.name if batch.benchmark else None}
    if body.name is not None and body.name != batch.name:
        batch.name = _name(db, body.name, other_than=batch.id)
    if body.benchmark_id is not None:
        batch.benchmark_id = _benchmark_for(db, batch.niche, body.benchmark_id)
    db.flush()
    db.refresh(batch)
    after = {"name": batch.name, "benchmark": batch.benchmark.name if batch.benchmark else None}
    changes = audit.diff(before, after)
    if changes:
        audit.record(db, me, "edit", "batch", batch.id, batch.name, changes)
    db.commit()
    return batch_out(db, me, batch)


@router.delete("/batches/{batch_id}", status_code=204)
def delete_batch(batch_id: uuid.UUID, me: CurrentUser, db: Db) -> None:
    """Only an empty batch (no leads, no files) can be deleted."""
    ensure(me, Action.IMPORT_LEADS)
    batch = get_batch(db, batch_id)
    if not batch_out(db, me, batch).can_delete:
        raise ApiError(409, "not_empty", "Only a batch without leads or files can be deleted.")
    for imp in db.scalars(select(Import).where(Import.batch_id == batch.id)):
        db.delete(imp)  # discarded or failed files
    audit.record(db, me, "delete", "batch", batch.id, batch.name, [])
    db.delete(batch)
    db.commit()
