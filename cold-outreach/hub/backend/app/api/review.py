"""`/api/review`: Top Review (SPEC steps 32 and 39). Once a file handed in on Files is past
its Final check without errors, a Reviewer chooses the Top businesses of each of its cities,
one city at a time, shown three ways: not ready (10 businesses or more, no Top yet), ready
(a Top is chosen: the city goes on to its niche's batch an hour later, or when sent now) and
cities under 10 (they stay out unless a Top is chosen). A city in its batch or muted isn't
here. Reviewers never see batches, the leads list or whole files."""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.auth.tokens import now
from app.db.models import FileCity, Submission
from app.errors import ApiError
from app.imports import check, file_cities, reader
from app.imports import submissions as files
from app.permissions import Action, ensure

router = APIRouter(tags=["review"])

Shown = Literal["needs_top", "ready", "small"]


class ReviewCity(BaseModel):
    file_id: uuid.UUID
    file_name: str
    number: int
    niche: str
    key: str
    name: str
    businesses: int
    tops: int
    state: Shown
    moves_at: datetime | None  # a ready city goes on to its batch then
    moves_in: int | None = None  # seconds until then, by the server's clock


class ReviewList(BaseModel):
    counts: dict[str, int]  # needs_top, ready, small
    cities: list[ReviewCity]


def _row(sub: Submission, city: FileCity) -> ReviewCity:
    state = file_cities.state(city)
    assert state in ("needs_top", "ready", "small")
    return ReviewCity(
        file_id=sub.id,
        file_name=sub.file_name,
        number=sub.number,
        niche=sub.niche,
        key=city.key,
        name=city.name,
        businesses=city.businesses,
        tops=len(city.tops),
        state=state,
        moves_at=city.topped_at + files.READY_WAIT if state == "ready" and city.topped_at else None,
        moves_in=files.seconds_until(city.topped_at + files.READY_WAIT)
        if state == "ready" and city.topped_at
        else None,
    )


@router.get("/review/cities", response_model=ReviewList)
def review_cities(
    me: CurrentUser, db: Db, show: Annotated[Shown, Query()] = "needs_top"
) -> ReviewList:
    """The cities in Top Review, the oldest file first: one of the three lists, with how many
    each list has."""
    ensure(me, Action.REVIEW_TOPS)
    found = db.execute(
        select(Submission, FileCity)
        .join(FileCity, FileCity.submission_id == Submission.id)
        .where(
            Submission.state == "checked",
            Submission.sent_at.is_not(None),
            FileCity.moved_at.is_(None),
            FileCity.muted == "",
        )
        .order_by(Submission.number, FileCity.name)
    )
    rows = [_row(sub, city) for sub, city in found if file_cities.sent_without_errors(sub)]
    counts = {
        key: sum(1 for r in rows if r.state == key) for key in ("needs_top", "ready", "small")
    }
    return ReviewList(counts=counts, cities=[r for r in rows if r.state == show])


def _open(db: Session, file_id: uuid.UUID, key: str, lock: bool = False) -> FileCity:
    """A city in Top Review; one in its batch can't be changed here any more."""
    query = select(Submission).where(Submission.id == file_id)
    sub = db.scalar(query.with_for_update() if lock else query)
    if sub is None or not file_cities.sent_without_errors(sub):
        raise ApiError(404, "not_found", "That file doesn't exist.")
    city = next((c for c in sub.cities if c.key == files.city_key(key)), None)
    if city is None or city.muted:
        raise ApiError(404, "not_found", "That city isn't in Top Review.")
    if city.moved_at is not None:
        raise ApiError(409, "in_batch", f"{city.name} is in its batch already.")
    return city


class CityOut(BaseModel):
    key: str
    name: str
    state: Shown
    moves_at: datetime | None
    moves_in: int | None = None
    file_id: uuid.UUID
    file_name: str
    columns: list[dict[str, str]]
    businesses: list[dict[str, Any]]


COLUMNS = [*check.STANDARD.items(), ("notes", "Notes")]


@router.get("/review/files/{file_id}/cities/{city}", response_model=CityOut)
def review_city(file_id: uuid.UUID, city: str, me: CurrentUser, db: Db) -> CityOut:
    """One city's businesses, with every column, and which are Top."""
    ensure(me, Action.REVIEW_TOPS)
    found_city = _open(db, file_id, city)
    sub = found_city.file
    try:
        found = files.city_businesses(sub.content, sub.niche, found_city.key)
    except reader.ReadError as error:
        raise ApiError(422, "unreadable", str(error)) from None
    chosen = set(found_city.tops)
    extra: list[str] = []
    for business in found:
        business["top"] = business["key"] in chosen
        extra += [name for name in business["extra"] if name not in extra]
    row = _row(sub, found_city)
    return CityOut(
        key=found_city.key,
        name=found_city.name,
        state=row.state,
        moves_at=row.moves_at,
        moves_in=row.moves_in,
        file_id=sub.id,
        file_name=sub.file_name,
        columns=[{"key": k, "label": label} for k, label in COLUMNS]
        + [{"key": f"extra:{name}", "label": name} for name in extra],
        businesses=found,
    )


class TopsIn(Strict):
    tops: list[str] = Field(max_length=5000)


@router.put("/review/files/{file_id}/cities/{city}", response_model=ReviewCity)
def save_tops(file_id: uuid.UUID, city: str, body: TopsIn, me: CurrentUser, db: Db) -> ReviewCity:
    """Save a city's Top businesses: with a Top it is ready (its hour starts the first time),
    without one it isn't."""
    ensure(me, Action.REVIEW_TOPS)
    found = _open(db, file_id, city, lock=True)
    sub = found.file
    known = {b["key"] for b in files.city_businesses(sub.content, sub.niche, found.key)}
    wanted = list(dict.fromkeys(body.tops))
    if not set(wanted) <= known:
        raise ApiError(422, "invalid", f"These businesses aren't all in {found.name}.")
    before = len(found.tops)
    found.tops = wanted
    if not wanted:
        found.topped_at = None
    elif found.topped_at is None:
        found.topped_at = now()
    audit.record(
        db,
        me,
        "choose Top",
        "file",
        sub.id,
        f"{sub.file_name} · {found.name}",
        [{"field": "Top", "from": before, "to": len(wanted)}],
    )
    db.commit()
    return _row(sub, found)
