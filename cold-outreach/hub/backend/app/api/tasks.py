"""`/api/tasks`: the jobs agents do (SPEC section 6.7), for a batch's Tasks tab.

Jobs come from the agents' manifests; there is no screen to make them. A batch's tasks name
a job each (`batch_pipeline.py`).
"""

import uuid

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.deps import CurrentUser, Db
from app.db.models import Agent, Batch, BatchTask, Task
from app.errors import ApiError
from app.permissions import Action, ensure

router = APIRouter(tags=["tasks"])


class BotRef(BaseModel):
    key: str
    name: str
    enabled: bool


class TaskOut(BaseModel):
    id: uuid.UUID
    key: str
    name: str
    bots: list[BotRef]  # the agents that do this job
    batches: list[str]  # the batches with a task of this job


def task_out(db: Session, task: Task) -> TaskOut:
    bots = db.scalars(select(Agent).where(Agent.task_id == task.id).order_by(Agent.name))
    batches = db.scalars(
        select(Batch.name)
        .join(BatchTask, BatchTask.batch_id == Batch.id)
        .where(BatchTask.task_id == task.id)
        .order_by(Batch.position, Batch.created_at)
    )
    return TaskOut(
        id=task.id,
        key=task.key,
        name=task.name,
        bots=[BotRef(key=b.key, name=b.name, enabled=b.enabled) for b in bots],
        batches=list(batches),
    )


def get_task(db: Session, task_id: uuid.UUID) -> Task:
    task = db.get(Task, task_id)
    if task is None:
        raise ApiError(404, "not_found", "That job doesn't exist.")
    return task


@router.get("/tasks", response_model=list[TaskOut])
def list_tasks(me: CurrentUser, db: Db) -> list[TaskOut]:
    """Every job, A to Z, with the agents that do it."""
    ensure(me, Action.VIEW_HUB)
    tasks = sorted(db.scalars(select(Task)), key=lambda t: t.name.lower())
    return [task_out(db, task) for task in tasks]
