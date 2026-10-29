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
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session, contains_eager, load_only

from app import audit
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.auth.tokens import now
from app.db.models import Batch, Benchmark, FileCity, Submission
from app.errors import ApiError
from app.imports import check, file_cities
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


def _listed() -> Select[Submission, FileCity]:
    """The cities in Top Review with their file's name and number only: never its content
    or businesses, which are megabytes for a file of hundreds of cities."""
    return (
        select(Submission, FileCity)
        .join(FileCity, FileCity.submission_id == Submission.id)
        .options(
            load_only(Submission.id, Submission.file_name, Submission.number, Submission.niche)
        )
        .where(
            Submission.state == "checked",
            Submission.sent_at.is_not(None),
            func.coalesce(Submission.check["errors"].as_integer(), 0) == 0,
            FileCity.moved_at.is_(None),
            FileCity.muted == "",
        )
    )


@router.get("/review/cities", response_model=ReviewList)
def review_cities(
    me: CurrentUser, db: Db, show: Annotated[Shown, Query()] = "needs_top"
) -> ReviewList:
    """The cities in Top Review, the oldest file first: one of the three lists, with how many
    each list has."""
    ensure(me, Action.REVIEW_TOPS)
    # Only the file's name and number come with each city: never its content or businesses,
    # which are megabytes for a file of hundreds of cities.
    found = db.execute(_listed().order_by(Submission.number, FileCity.name))
    rows = [_row(sub, city) for sub, city in found]
    counts = {
        key: sum(1 for r in rows if r.state == key) for key in ("needs_top", "ready", "small")
    }
    return ReviewList(counts=counts, cities=[r for r in rows if r.state == show])


def _open(db: Session, file_id: uuid.UUID, key: str, lock: bool = False) -> FileCity:
    """A city in Top Review; one in its batch can't be changed here any more. Only the file's
    name and state come with it, never its content or businesses (step 41)."""
    query = (
        select(FileCity)
        .join(Submission, FileCity.submission_id == Submission.id)
        .options(
            contains_eager(FileCity.file).load_only(
                Submission.id,
                Submission.file_name,
                Submission.number,
                Submission.niche,
                Submission.state,
                Submission.sent_at,
                Submission.check,
            )
        )
        .where(Submission.id == file_id, FileCity.key == files.city_key(key))
    )
    city = db.scalar(query.with_for_update(of=FileCity) if lock else query)
    if city is None or not file_cities.sent_without_errors(city.file):
        raise ApiError(404, "not_found", "That city isn't in Top Review.")
    if city.muted:
        raise ApiError(404, "not_found", "That city isn't in Top Review.")
    if city.moved_at is not None:
        raise ApiError(409, "in_batch", f"{city.name} is in its batch already.")
    return city


class BenchmarkHint(BaseModel):
    """What a Top business has at least (the niche's benchmark): ⭐ for the ones that do."""

    name: str
    reviews: float | None
    rating: float | None


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
    benchmark: BenchmarkHint | None = None


COLUMNS = [*check.STANDARD.items(), ("notes", "Notes")]


def _number(text: str | None) -> float | None:
    if not text:
        return None
    try:
        return float(text.replace(",", ""))
    except ValueError:
        return check.reviews_count(text)


def _hint(db: Session, niche: str) -> BenchmarkHint | None:
    """The niche's benchmark: its batch's, else the niche's first."""
    key = niche.strip().lower()
    batch = db.scalar(
        select(Batch)
        .where(func.lower(func.trim(Batch.niche)) == key, Batch.benchmark_id.is_not(None))
        .order_by(Batch.position)
        .limit(1)
    )
    benchmark = (
        batch.benchmark
        if batch is not None
        else db.scalar(
            select(Benchmark)
            .where(func.lower(func.trim(Benchmark.niche)) == key)
            .order_by(Benchmark.name)
            .limit(1)
        )
    )
    if benchmark is None:
        return None
    gbp = benchmark.gbp or {}
    return BenchmarkHint(
        name=benchmark.name,
        reviews=_number(str(gbp["reviews"])) if gbp.get("reviews") is not None else None,
        rating=_number(str(gbp["rating"])) if gbp.get("rating") is not None else None,
    )


def _businesses(city: FileCity, hint: BenchmarkHint | None) -> list[dict[str, Any]]:
    """The city's businesses (kept when the file was sent on, step 41), most reviews first:
    each with whether it is Top and whether it meets the benchmark (⭐ a likely Top)."""
    chosen = set(city.tops)
    found = []
    for item in city.items:
        values = item.get("values", {})
        reviews, rating = _number(values.get("reviews")), _number(values.get("rating"))
        likely = bool(
            hint
            and (hint.reviews is not None or hint.rating is not None)
            and (hint.reviews is None or (reviews or 0) >= hint.reviews)
            and (hint.rating is None or (rating or 0) >= hint.rating)
        )
        found.append(dict(item, top=item["key"] in chosen, likely=likely))
    found.sort(
        key=lambda b: (
            -(_number(b["values"].get("reviews")) or 0),
            -(_number(b["values"].get("rating")) or 0),
        )
    )
    return found


def _columns(found: list[dict[str, Any]]) -> list[dict[str, str]]:
    extra: list[str] = []
    for business in found:
        extra += [name for name in business.get("extra", {}) if name not in extra]
    return [{"key": k, "label": label} for k, label in COLUMNS] + [
        {"key": f"extra:{name}", "label": name} for name in extra
    ]


@router.get("/review/files/{file_id}/cities/{city}", response_model=CityOut)
def review_city(file_id: uuid.UUID, city: str, me: CurrentUser, db: Db) -> CityOut:
    """One city's businesses, with every column, which are Top and which meet the niche's
    benchmark."""
    ensure(me, Action.REVIEW_TOPS)
    found_city = _open(db, file_id, city)
    sub = found_city.file
    hint = _hint(db, sub.niche)
    found = _businesses(found_city, hint)
    row = _row(sub, found_city)
    return CityOut(
        key=found_city.key,
        name=found_city.name,
        state=row.state,
        moves_at=row.moves_at,
        moves_in=row.moves_in,
        file_id=sub.id,
        file_name=sub.file_name,
        columns=_columns(found),
        businesses=found,
        benchmark=hint,
    )


SMALL_PAGE = 30  # cities under 10 on one page


class SmallCity(ReviewCity):
    businesses_list: list[dict[str, Any]]


class SmallPage(BaseModel):
    total: int
    page: int
    pages: int
    columns: list[dict[str, str]]
    benchmark: BenchmarkHint | None
    cities: list[SmallCity]


@router.get("/review/small", response_model=SmallPage)
def small_cities(
    me: CurrentUser, db: Db, page: Annotated[int, Query(ge=1, le=10_000)] = 1
) -> SmallPage:
    """The cities under 10 without a Top, many on one page with their businesses, to tick
    and save at once (step 41)."""
    ensure(me, Action.REVIEW_TOPS)
    found = [
        (sub, city)
        for sub, city in db.execute(_listed().order_by(Submission.number, FileCity.name))
        if file_cities.state(city) == "small"
    ]
    pages = max(1, -(-len(found) // SMALL_PAGE))
    shown = found[(page - 1) * SMALL_PAGE : page * SMALL_PAGE]
    hints: dict[str, BenchmarkHint | None] = {}
    cities = []
    for sub, city in shown:
        if sub.niche not in hints:
            hints[sub.niche] = _hint(db, sub.niche)
        cities.append(
            SmallCity(
                **_row(sub, city).model_dump(),
                businesses_list=_businesses(city, hints[sub.niche]),
            )
        )
    hint = next(iter(hints.values()), None) if len(hints) == 1 else None
    return SmallPage(
        total=len(found),
        page=page,
        pages=pages,
        columns=_columns([b for c in cities for b in c.businesses_list]),
        benchmark=hint,
        cities=cities,
    )


class TopsIn(Strict):
    tops: list[str] = Field(max_length=5000)


def _set_tops(db: Session, me: Any, found: FileCity, tops: list[str]) -> None:
    sub = found.file
    known = {item["key"] for item in found.items}
    wanted = list(dict.fromkeys(tops))
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


@router.put("/review/files/{file_id}/cities/{city}", response_model=ReviewCity)
def save_tops(file_id: uuid.UUID, city: str, body: TopsIn, me: CurrentUser, db: Db) -> ReviewCity:
    """Save a city's Top businesses: with a Top it is ready (its hour starts the first time),
    without one it isn't."""
    ensure(me, Action.REVIEW_TOPS)
    found = _open(db, file_id, city, lock=True)
    _set_tops(db, me, found, body.tops)
    db.commit()
    return _row(found.file, found)


class CityTops(Strict):
    file_id: uuid.UUID
    city: Annotated[str, StringConstraints(max_length=120)]
    tops: list[str] = Field(max_length=500)


class ManyTopsIn(Strict):
    cities: list[CityTops] = Field(max_length=200)


@router.put("/review/tops")
def save_many_tops(body: ManyTopsIn, me: CurrentUser, db: Db) -> dict[str, int]:
    """Save the Tops of many cities at once (the cities under 10, step 41)."""
    ensure(me, Action.REVIEW_TOPS)
    for item in body.cities:
        _set_tops(db, me, _open(db, item.file_id, item.city, lock=True), item.tops)
    db.commit()
    return {"saved": len(body.cities)}
