"""`/api/tasks`: the Tasks screen (SPEC sections 6.7 and 7).

A task is a job a batch can have done, with the tasks it needs first. Every bot does one
task, named by its manifest. Owners and Admins make, change and delete tasks.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit, pipeline
from app.agents.manifest import AGENT_KEY
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.db.models import Agent, Batch, BatchTask, Task
from app.errors import ApiError
from app.permissions import Action, can, ensure

router = APIRouter(tags=["tasks"])

Name = Annotated[str, StringConstraints(strip_whitespace=True, max_length=80)]
About = Annotated[str, StringConstraints(strip_whitespace=True, max_length=300)]


class TaskRef(BaseModel):
    key: str
    name: str


class BotRef(BaseModel):
    key: str
    name: str
    enabled: bool


class TaskOut(BaseModel):
    id: uuid.UUID
    key: str
    name: str
    about: str
    needs: list[TaskRef]
    bots: list[BotRef]
    batches: list[str]
    can_edit: bool
    can_delete: bool


def task_out(db: Session, me: CurrentUser, task: Task) -> TaskOut:
    names = {t.key: t.name for t in db.scalars(select(Task))}
    bots = list(db.scalars(select(Agent).where(Agent.task_id == task.id).order_by(Agent.name)))
    batches = list(
        db.scalars(
            select(Batch.name)
            .join(BatchTask, BatchTask.batch_id == Batch.id)
            .where(BatchTask.task_id == task.id)
            .order_by(Batch.position, Batch.created_at)
        )
    )
    staff = can(me, Action.EDIT_TASKS)
    return TaskOut(
        id=task.id,
        key=task.key,
        name=task.name,
        about=task.about,
        needs=[TaskRef(key=k, name=names.get(k, k)) for k in task.needs or []],
        bots=[BotRef(key=b.key, name=b.name, enabled=b.enabled) for b in bots],
        batches=batches,
        can_edit=staff,
        can_delete=staff and not bots and not batches,
    )


def get_task(db: Session, task_id: uuid.UUID) -> Task:
    task = db.get(Task, task_id)
    if task is None:
        raise ApiError(404, "not_found", "That task doesn't exist.")
    return task


def _name(db: Session, typed: str, other_than: uuid.UUID | None = None) -> str:
    name = " ".join(typed.split())
    if not name:
        raise ApiError(422, "invalid", "Name the task.", {"name": "Required."})
    found = db.scalar(select(Task.id).where(func.lower(Task.name) == name.lower()))
    if found is not None and found != other_than:
        raise ApiError(409, "name_taken", "Another task has this name.", {"name": "Taken."})
    return name


def _needs(db: Session, key: str, needs: list[str], task: Task | None) -> list[str]:
    """Check what a task needs first: known tasks, not itself, no circle, and (for a task
    in use) present in every batch that has it."""
    known = set(db.scalars(select(Task.key)))
    unknown = [n for n in needs if n not in known]
    if unknown or len(set(needs)) != len(needs):
        raise ApiError(422, "invalid", "Choose each needed task once.", {"needs": "Unknown."})
    if key in needs or pipeline.creates_circle(db, key, needs):
        raise ApiError(
            422,
            "circle",
            "A task can't wait for itself, also not through other tasks.",
            {"needs": "Makes a circle."},
        )
    if task is not None:
        for batch in db.scalars(
            select(Batch)
            .join(BatchTask, BatchTask.batch_id == Batch.id)
            .where(BatchTask.task_id == task.id)
        ):
            present = set(
                db.scalars(
                    select(Task.key)
                    .join(BatchTask, BatchTask.task_id == Task.id)
                    .where(BatchTask.batch_id == batch.id)
                )
            )
            missing = [n for n in needs if n not in present]
            if missing:
                raise ApiError(
                    409,
                    "missing_in_batch",
                    f"{batch.name} uses this task but doesn't have {', '.join(missing)}. "
                    "Add it there first.",
                    {"needs": "Missing in a batch."},
                )
    return needs


@router.get("/tasks", response_model=list[TaskOut])
def list_tasks(me: CurrentUser, db: Db) -> list[TaskOut]:
    ensure(me, Action.VIEW_HUB)
    tasks = list(db.scalars(select(Task)))
    order = pipeline.steps(tasks)
    tasks.sort(key=lambda t: (order[t.key], t.name.lower()))
    return [task_out(db, me, task) for task in tasks]


class TaskIn(Strict):
    key: Annotated[str, StringConstraints(strip_whitespace=True, max_length=40)]
    name: Name
    about: About = ""
    needs: Annotated[list[str], Field(max_length=50)] = Field(default_factory=list)


@router.post("/tasks", response_model=TaskOut, status_code=201)
def create_task(body: TaskIn, me: CurrentUser, db: Db) -> TaskOut:
    ensure(me, Action.EDIT_TASKS)
    if not AGENT_KEY.match(body.key):
        raise ApiError(
            422,
            "invalid",
            "Use 2–40 lower-case letters, digits and dashes, starting with a letter.",
            {"key": "Invalid."},
        )
    if db.scalar(select(Task.id).where(Task.key == body.key)) is not None:
        raise ApiError(409, "key_taken", "Another task has this key.", {"key": "Taken."})
    task = Task(
        key=body.key,
        name=_name(db, body.name),
        about=body.about,
        needs=_needs(db, body.key, body.needs, None),
    )
    db.add(task)
    db.flush()
    audit.record(db, me, "create", "task", task.id, task.name, [])
    db.commit()
    return task_out(db, me, task)


class TaskPatch(Strict):
    name: Name | None = None
    about: About | None = None
    needs: Annotated[list[str], Field(max_length=50)] | None = None


@router.patch("/tasks/{task_id}", response_model=TaskOut)
def update_task(task_id: uuid.UUID, body: TaskPatch, me: CurrentUser, db: Db) -> TaskOut:
    ensure(me, Action.EDIT_TASKS)
    task = get_task(db, task_id)
    before = {"name": task.name, "about": task.about, "needs": list(task.needs or [])}
    if body.name is not None:
        task.name = _name(db, body.name, other_than=task.id)
    if body.about is not None:
        task.about = body.about
    if body.needs is not None:
        task.needs = _needs(db, task.key, body.needs, task)
    after = {"name": task.name, "about": task.about, "needs": list(task.needs or [])}
    changes = audit.diff(before, after)
    if changes:
        audit.record(db, me, "edit", "task", task.id, task.name, changes)
    db.commit()
    return task_out(db, me, task)


@router.delete("/tasks/{task_id}", status_code=204)
def delete_task(task_id: uuid.UUID, me: CurrentUser, db: Db) -> None:
    """Only a task no bot does and no batch uses can be deleted."""
    ensure(me, Action.EDIT_TASKS)
    task = get_task(db, task_id)
    if not task_out(db, me, task).can_delete:
        raise ApiError(409, "in_use", "A bot does this task or a batch uses it.")
    needed_by = [t.name for t in db.scalars(select(Task)) if task.key in (t.needs or [])]
    if needed_by:
        raise ApiError(409, "needed", f"{', '.join(needed_by)} needs this task first.")
    audit.record(db, me, "delete", "task", task.id, task.name, [])
    db.delete(task)
    db.commit()
