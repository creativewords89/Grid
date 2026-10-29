"""`/api/review`: Top Review (SPEC step 32). Once a file handed in on Files has no error, a
Reviewer chooses each city's Top businesses in it, one city at a time. Cities with fewer
than 10 businesses are off and need none. When every city that is on has a Top the file is
ready and locked: nobody sees or changes its Tops here any more (an Owner or Admin can
reopen it on Files). Reviewers never see batches, the leads list or whole files."""

import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit
from app.api.schemas import Strict
from app.api.submissions import status_of
from app.auth.deps import CurrentUser, Db
from app.db.models import Submission
from app.errors import ApiError
from app.imports import check, reader
from app.imports import submissions as files
from app.imports.submissions import cities, lock_if_topped
from app.permissions import Action, ensure

router = APIRouter(tags=["review"])


class ReviewFile(BaseModel):
    id: uuid.UUID
    file_name: str
    niche: str
    businesses: int
    created_at: datetime
    # needs_top: open for Top Review; done: every city has a Top (locked)
    state: Literal["needs_top", "done"]
    cities_on: int
    cities_topped: int


class ReviewCity(BaseModel):
    key: str
    name: str
    businesses: int
    tops: int
    state: Literal["ready", "needs_top", "off"]


class ReviewFileDetail(ReviewFile):
    cities: list[ReviewCity]


def _file(sub: Submission) -> ReviewFile:
    found = cities(sub)
    on = files.cities_on(found)
    return ReviewFile(
        id=sub.id,
        file_name=sub.file_name,
        niche=sub.niche,
        businesses=sub.businesses,
        created_at=sub.created_at,
        state="needs_top" if status_of(sub) == "needs_top" else "done",
        cities_on=len(on),
        cities_topped=sum(1 for key in on if sub.tops.get(key)),
    )


def _detail(sub: Submission) -> ReviewFileDetail:
    on = set(files.cities_on(cities(sub)))
    listed = [
        ReviewCity(
            key=key,
            name=item["name"],
            businesses=item["businesses"],
            tops=len(sub.tops.get(key, [])),
            state="off" if key not in on else "ready" if sub.tops.get(key) else "needs_top",
        )
        for key, item in cities(sub).items()
    ]
    order = {"needs_top": 0, "ready": 1, "off": 2}
    listed.sort(key=lambda c: (order[c.state], c.name.lower()))
    return ReviewFileDetail(**_file(sub).model_dump(), cities=listed)


def _open(db: Session, file_id: uuid.UUID, lock: bool = False) -> Submission:
    """A file open for Top Review; a done one is locked."""
    query = select(Submission).where(Submission.id == file_id)
    sub = db.scalar(query.with_for_update() if lock else query)
    if sub is None or status_of(sub) in ("checking", "failed", "errors", "final_check"):
        raise ApiError(404, "not_found", "That file doesn't exist.")
    if status_of(sub) != "needs_top":
        raise ApiError(409, "locked", "Every city of this file has a Top: it is done and locked.")
    return sub


def _city(sub: Submission, key: str) -> dict[str, Any]:
    item = cities(sub).get(files.city_key(key))
    if item is None:
        raise ApiError(404, "not_found", "That city isn't in this file.")
    return item


@router.get("/review/files", response_model=list[ReviewFile])
def review_files(me: CurrentUser, db: Db) -> list[ReviewFile]:
    """The files waiting for their Tops, then the ones done."""
    ensure(me, Action.REVIEW_TOPS)
    found = [
        _file(sub)
        for sub in db.scalars(select(Submission).order_by(Submission.created_at.desc()).limit(500))
        if status_of(sub) not in ("checking", "failed", "errors", "final_check")
    ]
    db.commit()  # the cities of files handed in before step 32 were read just now
    return sorted(found, key=lambda f: f.state != "needs_top")


@router.get("/review/files/{file_id}", response_model=ReviewFileDetail)
def review_file(file_id: uuid.UUID, me: CurrentUser, db: Db) -> ReviewFileDetail:
    ensure(me, Action.REVIEW_TOPS)
    found = _detail(_open(db, file_id))
    db.commit()
    return found


class CityOut(BaseModel):
    key: str
    name: str
    state: Literal["ready", "needs_top", "off"]
    columns: list[dict[str, str]]
    businesses: list[dict[str, Any]]


COLUMNS = [*check.STANDARD.items(), ("notes", "Notes")]


@router.get("/review/files/{file_id}/cities/{city}", response_model=CityOut)
def review_city(file_id: uuid.UUID, city: str, me: CurrentUser, db: Db) -> CityOut:
    """One city's businesses, with every column, and which are Top."""
    ensure(me, Action.REVIEW_TOPS)
    sub = _open(db, file_id)
    item = _city(sub, city)
    key = files.city_key(city)
    try:
        found = files.city_businesses(sub.content, sub.niche, key)
    except reader.ReadError as error:
        raise ApiError(422, "unreadable", str(error)) from None
    chosen = set(sub.tops.get(key, []))
    extra: list[str] = []
    for business in found:
        business["top"] = business["key"] in chosen
        extra += [name for name in business["extra"] if name not in extra]
    state = next(c.state for c in _detail(sub).cities if c.key == key)
    db.commit()
    return CityOut(
        key=key,
        name=item["name"],
        state=state,
        columns=[{"key": k, "label": label} for k, label in COLUMNS]
        + [{"key": f"extra:{name}", "label": name} for name in extra],
        businesses=found,
    )


class TopsIn(Strict):
    tops: list[str] = Field(max_length=5000)


@router.put("/review/files/{file_id}/cities/{city}", response_model=ReviewFileDetail)
def save_tops(
    file_id: uuid.UUID, city: str, body: TopsIn, me: CurrentUser, db: Db
) -> ReviewFileDetail:
    """Save a city's Top businesses. When every city that is on has a Top, the file is
    ready and locked."""
    ensure(me, Action.REVIEW_TOPS)
    sub = _open(db, file_id, lock=True)
    item = _city(sub, city)
    key = files.city_key(city)
    if key not in files.cities_on(cities(sub)):
        raise ApiError(409, "city_off", f"{item['name']} has under 10 businesses: it is off.")
    known = {b["key"] for b in files.city_businesses(sub.content, sub.niche, key)}
    wanted = list(dict.fromkeys(body.tops))
    if not set(wanted) <= known:
        raise ApiError(422, "invalid", f"These businesses aren't all in {item['name']}.")
    before = len(sub.tops.get(key, []))
    sub.tops = dict(sub.tops, **{key: wanted})
    lock_if_topped(sub)
    audit.record(
        db,
        me,
        "choose Top",
        "file",
        sub.id,
        f"{sub.file_name} · {item['name']}",
        [{"field": "Top", "from": before, "to": len(wanted)}],
    )
    found = _detail(sub)
    db.commit()
    return found
