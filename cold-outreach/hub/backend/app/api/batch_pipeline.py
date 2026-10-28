"""A batch's tasks and bots, Start/Pause, the running order and each bot's results (SPEC
section 6.7). Everyone sees them; Owners and Admins change them."""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit, pipeline
from app.api.batches import BatchOut, batch_out, get_batch
from app.api.schemas import Strict
from app.api.tasks import get_task
from app.auth.deps import CurrentUser, Db
from app.auth.tokens import now
from app.db.models import Agent, Batch, BatchStatus, BatchTask, BatchTaskBot, ShareMode, Task
from app.errors import ApiError
from app.permissions import Action, can, ensure

router = APIRouter(tags=["batches"])

CONNECTED_WITHIN_SECONDS = 120


class BotProgress(BaseModel):
    key: str
    name: str
    enabled: bool
    connected: bool
    done: int
    failed: int
    ready: int
    waiting: int
    average_score: float | None


class SlotOut(BaseModel):
    task_id: uuid.UUID
    key: str
    name: str
    needs: list[str]  # names of the tasks it waits for
    share: str
    bots: list[BotProgress]
    can_remove: bool  # no other task in the batch needs it


class StepOut(BaseModel):
    step: int
    tasks: list[SlotOut]


class PipelineOut(BaseModel):
    batch: BatchOut
    steps: list[StepOut]
    can_start: bool
    start_problem: str | None


def _start_problem(db: Session, batch: Batch) -> str | None:
    if batch.benchmark_id is None:
        return "Choose the batch's benchmark first."
    has_bot = db.scalar(
        select(func.count())
        .select_from(BatchTaskBot)
        .join(BatchTask, BatchTask.id == BatchTaskBot.batch_task_id)
        .where(BatchTask.batch_id == batch.id)
    )
    return None if has_bot else "Add a task with at least one bot first."


def pipeline_out(db: Session, me: CurrentUser, batch: Batch) -> PipelineOut:
    flow = pipeline.Pipeline(db, batch)
    counts = flow.progress()
    order = pipeline.steps([slot.task for slot in flow.slots])
    names = {slot.task.key: slot.task.name for slot in flow.slots}
    seen_after = now().timestamp() - CONNECTED_WITHIN_SECONDS
    by_step: dict[int, list[SlotOut]] = {}
    for slot in flow.slots:
        bots = []
        for bot in slot.bots:
            count = counts[(slot.id, bot.agent_id)]
            agent = bot.agent
            bots.append(
                BotProgress(
                    key=agent.key,
                    name=agent.name,
                    enabled=agent.enabled,
                    connected=bool(
                        agent.last_seen_at and agent.last_seen_at.timestamp() > seen_after
                    ),
                    done=count.done,
                    failed=count.failed,
                    ready=count.ready,
                    waiting=count.waiting,
                    average_score=count.average,
                )
            )
        needed = any(slot.task.key in (other.task.needs or []) for other in flow.slots)
        by_step.setdefault(order[slot.task.key], []).append(
            SlotOut(
                task_id=slot.task.id,
                key=slot.task.key,
                name=slot.task.name,
                needs=[names[k] for k in slot.task.needs or [] if k in names],
                share=slot.share,
                bots=bots,
                can_remove=not needed,
            )
        )
    problem = _start_problem(db, batch)
    return PipelineOut(
        batch=batch_out(db, me, batch),
        steps=[StepOut(step=n, tasks=by_step[n]) for n in sorted(by_step)],
        can_start=can(me, Action.RUN_BATCHES)
        and problem is None
        and batch.status != BatchStatus.RUNNING,
        start_problem=problem,
    )


@router.get("/batches/{batch_id}/pipeline", response_model=PipelineOut)
def read_pipeline(batch_id: uuid.UUID, me: CurrentUser, db: Db) -> PipelineOut:
    ensure(me, Action.VIEW_HUB)
    return pipeline_out(db, me, get_batch(db, batch_id))


class OrderIn(Strict):
    ids: Annotated[list[uuid.UUID], Field(max_length=2000)]


@router.put("/batches/order", response_model=list[BatchOut])
def set_order(body: OrderIn, me: CurrentUser, db: Db) -> list[BatchOut]:
    """The running order: the first batch goes first when two running batches share a bot."""
    ensure(me, Action.RUN_BATCHES)
    batches = {b.id: b for b in db.scalars(select(Batch))}
    if len(set(body.ids)) != len(body.ids) or set(body.ids) != set(batches):
        raise ApiError(409, "stale", "The batches changed. Reload the page and try again.")
    for position, batch_id in enumerate(body.ids):
        batches[batch_id].position = position
    audit.record(db, me, "order", "batch", None, "Running order", [])
    db.commit()
    return [batch_out(db, me, batches[batch_id]) for batch_id in body.ids]


def _set_status(db: Session, me: CurrentUser, batch: Batch, status: BatchStatus) -> None:
    changes = audit.diff({"status": batch.status}, {"status": status.value})
    batch.status = status
    audit.record(db, me, status.value, "batch", batch.id, batch.name, changes)
    db.commit()


@router.post("/batches/{batch_id}/start", response_model=PipelineOut)
def start(batch_id: uuid.UUID, me: CurrentUser, db: Db) -> PipelineOut:
    ensure(me, Action.RUN_BATCHES)
    batch = get_batch(db, batch_id)
    problem = _start_problem(db, batch)
    if problem:
        raise ApiError(409, "not_ready", problem)
    if batch.status != BatchStatus.RUNNING:
        _set_status(db, me, batch, BatchStatus.RUNNING)
    return pipeline_out(db, me, batch)


@router.post("/batches/{batch_id}/pause", response_model=PipelineOut)
def pause(batch_id: uuid.UUID, me: CurrentUser, db: Db) -> PipelineOut:
    ensure(me, Action.RUN_BATCHES)
    batch = get_batch(db, batch_id)
    if batch.status != BatchStatus.RUNNING:
        raise ApiError(409, "not_running", "Only a running batch can be paused.")
    _set_status(db, me, batch, BatchStatus.PAUSED)
    return pipeline_out(db, me, batch)


def _slot(db: Session, batch: Batch, task: Task) -> BatchTask:
    slot = db.scalar(
        select(BatchTask).where(BatchTask.batch_id == batch.id, BatchTask.task_id == task.id)
    )
    if slot is None:
        raise ApiError(404, "not_found", f"{batch.name} doesn't have {task.name}.")
    return slot


def _batch_task_keys(db: Session, batch: Batch) -> set[str]:
    return set(
        db.scalars(
            select(Task.key)
            .join(BatchTask, BatchTask.task_id == Task.id)
            .where(BatchTask.batch_id == batch.id)
        )
    )


Share = Literal["all", "split"]


class SlotIn(Strict):
    task_id: uuid.UUID
    share: Share = "all"


@router.post("/batches/{batch_id}/tasks", response_model=PipelineOut, status_code=201)
def add_task(batch_id: uuid.UUID, body: SlotIn, me: CurrentUser, db: Db) -> PipelineOut:
    """Add a task; the tasks it needs must be in the batch already."""
    ensure(me, Action.RUN_BATCHES)
    batch = get_batch(db, batch_id)
    task = get_task(db, body.task_id)
    present = _batch_task_keys(db, batch)
    if task.key in present:
        raise ApiError(409, "already_added", f"{batch.name} already has {task.name}.")
    missing = [key for key in task.needs or [] if key not in present]
    if missing:
        names = {t.key: t.name for t in db.scalars(select(Task).where(Task.key.in_(missing)))}
        raise ApiError(
            409,
            "needs_missing",
            f"{task.name} needs {', '.join(names.get(k, k) for k in missing)} first. "
            "Add it to the batch before this task.",
        )
    db.add(BatchTask(batch_id=batch.id, task_id=task.id, share=body.share))
    audit.record(
        db,
        me,
        "add_task",
        "batch",
        batch.id,
        batch.name,
        [{"field": "task", "from": None, "to": task.name}],
    )
    db.commit()
    return pipeline_out(db, me, batch)


class SlotPatch(Strict):
    share: Share


@router.patch("/batches/{batch_id}/tasks/{task_id}", response_model=PipelineOut)
def change_share(
    batch_id: uuid.UUID, task_id: uuid.UUID, body: SlotPatch, me: CurrentUser, db: Db
) -> PipelineOut:
    ensure(me, Action.RUN_BATCHES)
    batch = get_batch(db, batch_id)
    task = get_task(db, task_id)
    slot = _slot(db, batch, task)
    if slot.share != body.share:
        changes = [{"field": f"{task.name} share", "from": slot.share, "to": body.share}]
        slot.share = ShareMode(body.share)
        audit.record(db, me, "edit", "batch", batch.id, batch.name, changes)
        db.commit()
    return pipeline_out(db, me, batch)


@router.delete("/batches/{batch_id}/tasks/{task_id}", response_model=PipelineOut)
def remove_task(batch_id: uuid.UUID, task_id: uuid.UUID, me: CurrentUser, db: Db) -> PipelineOut:
    """Remove a task no other task in the batch needs. Results already saved stay."""
    ensure(me, Action.RUN_BATCHES)
    batch = get_batch(db, batch_id)
    task = get_task(db, task_id)
    slot = _slot(db, batch, task)
    needed_by = [
        other.task.name
        for other in pipeline.slots_of(db, batch)
        if task.key in (other.task.needs or [])
    ]
    if needed_by:
        raise ApiError(409, "needed", f"{', '.join(needed_by)} needs {task.name}. Remove it first.")
    db.delete(slot)
    audit.record(
        db,
        me,
        "remove_task",
        "batch",
        batch.id,
        batch.name,
        [{"field": "task", "from": task.name, "to": None}],
    )
    db.commit()
    return pipeline_out(db, me, batch)


class BotIn(Strict):
    key: Annotated[str, Field(max_length=40)]


def _agent(db: Session, key: str) -> Agent:
    agent = db.scalar(select(Agent).where(Agent.key == key))
    if agent is None:
        raise ApiError(404, "not_found", "That bot doesn't exist.")
    return agent


@router.post("/batches/{batch_id}/tasks/{task_id}/bots", response_model=PipelineOut)
def add_bot(
    batch_id: uuid.UUID, task_id: uuid.UUID, body: BotIn, me: CurrentUser, db: Db
) -> PipelineOut:
    """Add a bot to a task in the batch: only a bot that does that task."""
    ensure(me, Action.RUN_BATCHES)
    batch = get_batch(db, batch_id)
    task = get_task(db, task_id)
    slot = _slot(db, batch, task)
    agent = _agent(db, body.key)
    if agent.task_id != task.id:
        raise ApiError(409, "wrong_task", f"{agent.name} doesn't do {task.name}.")
    if any(bot.agent_id == agent.id for bot in slot.bots):
        raise ApiError(409, "already_added", f"{agent.name} is already on {task.name}.")
    position = max((bot.position for bot in slot.bots), default=-1) + 1
    db.add(BatchTaskBot(batch_task_id=slot.id, agent_id=agent.id, position=position))
    audit.record(
        db,
        me,
        "add_bot",
        "batch",
        batch.id,
        batch.name,
        [{"field": task.name, "from": None, "to": agent.name}],
    )
    db.commit()
    db.expire(slot, ["bots"])
    return pipeline_out(db, me, batch)


@router.delete("/batches/{batch_id}/tasks/{task_id}/bots/{key}", response_model=PipelineOut)
def remove_bot(
    batch_id: uuid.UUID, task_id: uuid.UUID, key: str, me: CurrentUser, db: Db
) -> PipelineOut:
    """Take a bot off a task. Its results stay; split leads it hadn't finished go to the
    task's other bots."""
    ensure(me, Action.RUN_BATCHES)
    batch = get_batch(db, batch_id)
    task = get_task(db, task_id)
    slot = _slot(db, batch, task)
    agent = _agent(db, key)
    if not any(bot.agent_id == agent.id for bot in slot.bots):
        raise ApiError(404, "not_found", f"{agent.name} isn't on {task.name}.")
    pipeline.remove_bot(db, slot, agent)
    audit.record(
        db,
        me,
        "remove_bot",
        "batch",
        batch.id,
        batch.name,
        [{"field": task.name, "from": agent.name, "to": None}],
    )
    db.commit()
    return pipeline_out(db, me, batch)


# --- each bot's results ----------------------------------------------------------------------

PAGE_SIZE = 100
Outcome = Literal["done", "skipped", "failed", "not_yet"]
Band = Literal["low", "mid", "high"]


def band_of(score: Any) -> str | None:
    if not isinstance(score, int | float):
        return None
    return "low" if score < 40 else "mid" if score < 70 else "high"


class ResultRow(BaseModel):
    lead_id: str
    business_name: str
    city: str
    outcome: str
    status: str | None
    score: float | None
    summary: str
    at: datetime | None


class ResultsOut(BaseModel):
    bot: str
    bot_name: str
    outcomes: dict[str, int]
    bands: dict[str, int]
    leads: list[ResultRow]
    total: int
    page: int
    pages: int


@router.get("/batches/{batch_id}/results", response_model=ResultsOut)
def results(
    batch_id: uuid.UUID,
    me: CurrentUser,
    db: Db,
    bot: Annotated[str, Query(max_length=40)],
    outcome: Outcome | None = None,
    band: Band | None = None,
    page: Annotated[int, Query(ge=1, le=10_000)] = 1,
) -> ResultsOut:
    """One bot's results in the batch: counts by outcome and score band, then its leads."""
    ensure(me, Action.VIEW_HUB)
    batch = get_batch(db, batch_id)
    agent = _agent(db, bot)
    flow = pipeline.Pipeline(db, batch)
    outcomes = {"done": 0, "skipped": 0, "failed": 0, "not_yet": 0}
    bands = {"low": 0, "mid": 0, "high": 0}
    rows: list[ResultRow] = []
    for lead in flow.leads():
        result = (lead.results or {}).get(agent.key)
        kind = (result or {}).get("outcome", "done") if result else "not_yet"
        outcomes[kind] = outcomes.get(kind, 0) + 1
        lead_band = band_of((result or {}).get("score"))
        if lead_band:
            bands[lead_band] += 1
        if (outcome and kind != outcome) or (band and lead_band != band):
            continue
        if result is None and outcome != "not_yet":
            continue  # leads it hasn't reached are only listed when asked for
        rows.append(
            ResultRow(
                lead_id=lead.lead_id,
                business_name=lead.business_name,
                city=lead.city,
                outcome=kind,
                status=(result or {}).get("status"),
                score=(result or {}).get("score"),
                summary=(result or {}).get("summary", ""),
                at=(result or {}).get("at"),
            )
        )
    rows.sort(key=lambda r: (r.score is None, r.score if r.score is not None else 0, r.lead_id))
    pages = max(1, -(-len(rows) // PAGE_SIZE))
    start_at = (page - 1) * PAGE_SIZE
    return ResultsOut(
        bot=agent.key,
        bot_name=agent.name,
        outcomes=outcomes,
        bands=bands,
        leads=rows[start_at : start_at + PAGE_SIZE],
        total=len(rows),
        page=page,
        pages=pages,
    )
