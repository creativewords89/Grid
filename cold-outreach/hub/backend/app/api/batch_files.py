"""`/api/batches/{id}/files`: a batch's files (SPEC step 46). A niche's batch gets its cities
from the files handed in on Files (step 39): the batch shows those files, each with its
cities in the batch, its businesses and how much of them its agents have done; a file opens
to its cities there (on or off, their leads, Top, done, Lead Check problems)."""

import uuid
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, defer, selectinload

from app import pipeline
from app.api.batches import get_batch
from app.auth.deps import CurrentUser, Db
from app.db.models import FileCity, Lead, LeadList, Submission, User
from app.errors import ApiError
from app.imports import file_cities
from app.permissions import Action, ensure

router = APIRouter(tags=["batches"])


class BatchFile(BaseModel):
    file_id: uuid.UUID
    file_name: str
    number: int
    uploaded_by: str | None
    cities: int  # its cities in this batch
    cities_in_review: int  # its cities still in Top Review (not ready or ready)
    in_files: bool  # not sent on to Top Review yet: still in Files (step 47)
    leads: int
    top: int
    done: int  # leads every agent of the batch's tasks has finished
    done_pct: int | None  # of its leads agents work on (not Top); None without agents


class BatchCity(BaseModel):
    key: str
    name: str
    list_id: uuid.UUID | None  # the batch's city, switched on or off (PATCH /lists/{id})
    active: bool
    leads: int
    top: int
    done: int
    problems: int  # leads with a Lead Check problem


def _done_for(flow: pipeline.Pipeline, leads: list[Lead]) -> int:
    """Leads every task with an agent has finished."""
    working = [slot for slot in flow.slots if slot.bots]
    if not working:
        return 0
    return sum(
        1
        for lead in leads
        if lead.level != "Top" and all(flow.task_done(lead, slot) for slot in working)
    )


def _cities_of(db: Session, batch_id: uuid.UUID) -> list[FileCity]:
    return list(
        db.scalars(
            select(FileCity)
            .where(FileCity.moved_at.is_not(None), FileCity.import_id.is_not(None))
            .join(Lead, Lead.first_import_id == FileCity.import_id)
            .where(Lead.batch_id == batch_id)
            .distinct()
        )
    )


@router.get("/batches/{batch_id}/files", response_model=list[BatchFile])
def batch_files(batch_id: uuid.UUID, me: CurrentUser, db: Db) -> list[BatchFile]:
    """The files the batch's cities came from, and its niche's files whose cities are still
    in Files or Top Review (step 47), the oldest first."""
    ensure(me, Action.VIEW_HUB)
    batch = get_batch(db, batch_id)
    moved = _cities_of(db, batch.id)
    by_file: dict[uuid.UUID, list[FileCity]] = {
        file_id: [] for file_id in file_cities.batch_files(db, batch)
    }
    for city in moved:
        by_file.setdefault(city.submission_id, []).append(city)
    if not by_file:
        return []
    subs = list(
        db.scalars(
            select(Submission)
            .where(Submission.id.in_(by_file))
            .options(
                selectinload(Submission.cities).defer(FileCity.items),
                defer(Submission.content),
                defer(Submission.leads),
                defer(Submission.problems),
            )
            .order_by(Submission.number)
        )
    )
    names = {user.id: user.name for user in db.scalars(select(User))}
    flow = pipeline.Pipeline(db, batch)
    out = []
    for sub in subs:
        imports = [c.import_id for c in by_file[sub.id] if c.import_id is not None]
        leads = (
            list(
                db.scalars(
                    select(Lead).where(Lead.batch_id == batch.id, Lead.first_import_id.in_(imports))
                )
            )
            if imports
            else []
        )
        workable = sum(1 for lead in leads if lead.level != "Top")
        done = _done_for(flow, leads)
        out.append(
            BatchFile(
                file_id=sub.id,
                file_name=sub.file_name,
                number=sub.number,
                uploaded_by=names.get(sub.uploaded_by) if sub.uploaded_by else None,
                cities=len(by_file[sub.id]),
                cities_in_review=sum(
                    1 for c in sub.cities if file_cities.state(c) in ("needs_top", "ready")
                )
                if sub.sent_at is not None
                else 0,
                in_files=sub.sent_at is None,
                leads=len(leads),
                top=len(leads) - workable,
                done=done,
                done_pct=round(100 * done / workable)
                if workable and any(slot.bots for slot in flow.slots)
                else None,
            )
        )
    return out


@router.get("/batches/{batch_id}/files/{file_id}/cities", response_model=list[BatchCity])
def batch_file_cities(
    batch_id: uuid.UUID, file_id: uuid.UUID, me: CurrentUser, db: Db
) -> list[BatchCity]:
    """A file's cities in the batch, by name: on or off, leads, Top, done, problems."""
    ensure(me, Action.VIEW_HUB)
    batch = get_batch(db, batch_id)
    moved = [c for c in _cities_of(db, batch.id) if c.submission_id == file_id]
    if not moved:
        raise ApiError(404, "not_found", "That file has no city in this batch.")
    lists = {
        item.city.lower(): item
        for item in db.scalars(select(LeadList).where(LeadList.batch_id == batch.id))
    }
    flow = pipeline.Pipeline(db, batch)
    out = []
    for city in sorted(moved, key=lambda c: c.name.lower()):
        leads = list(
            db.scalars(
                select(Lead).where(
                    Lead.batch_id == batch.id, Lead.first_import_id == city.import_id
                )
            )
        )
        found: dict[str, Any] = {}
        for lead in leads:
            found[lead.city.lower()] = lists.get(lead.city.lower())
        item = next((x for x in found.values() if x is not None), None)
        out.append(
            BatchCity(
                key=city.key,
                name=city.name,
                list_id=item.id if item else None,
                active=item.active if item else False,
                leads=len(leads),
                top=sum(1 for lead in leads if lead.level == "Top"),
                done=_done_for(flow, leads),
                problems=sum(1 for lead in leads if lead.check),
            )
        )
    return out
