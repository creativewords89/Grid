"""The cities of the files handed in (SPEC step 39). A file's Lead Check is run against the
other files and the batches: a city that another file of the niche (handed in earlier) or
the niche's batch already has is muted, and a business already handed in is an error. Once
a Reviewer chooses a city's Top it is ready, and goes on to its niche's batch an hour later
(or when someone sends it now): only that city's businesses are saved there. Each niche
has one batch, named after it, made when its first city comes."""

import logging
from typing import Literal

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app import audit
from app.auth.tokens import now
from app.db.models import Batch, Benchmark, FileCity, Lead, LeadList, Submission, User
from app.errors import ApiError
from app.imports import check, reader, service
from app.imports import submissions as files

log = logging.getLogger("file_cities")

CityState = Literal["muted", "in_batch", "ready", "needs_top", "small"]


def state(city: FileCity) -> CityState:
    """muted; in the batch; ready (has a Top, waiting to go); needs a Top (10 businesses or
    more); small (fewer, without a Top: it doesn't go unless one is chosen)."""
    if city.moved_at is not None:
        return "in_batch"
    if city.muted:
        return "muted"
    if city.tops:
        return "ready"
    return "needs_top" if city.businesses >= service.SMALL_CITY else "small"


def sent_without_errors(sub: Submission) -> bool:
    """Past its Final check, checked and without errors: its cities are in Top Review."""
    return sub.state == "checked" and sub.sent_at is not None and not sub.check.get("errors")


def _niche(text_: str) -> str:
    return text_.strip().lower()


def others(db: Session, sub: Submission) -> files.Others:
    """What `sub` is checked against: the cities of its niche other files (handed in earlier,
    or already in the batch) or the batch have, and every business handed in before it."""
    niche = _niche(sub.niche)
    own_moved = {c.key for c in sub.cities if c.moved_at is not None}
    own_imports = {c.import_id for c in sub.cities if c.import_id is not None}
    cities: dict[str, str] = {}
    taken = db.execute(
        select(FileCity, Submission.number, Submission.file_name)
        .join(Submission, FileCity.submission_id == Submission.id)
        .where(
            func.lower(func.trim(Submission.niche)) == niche,
            FileCity.submission_id != sub.id,
            FileCity.muted == "",
        )
        .order_by(Submission.number)
    )
    for city, number, name in taken:
        if city.key in own_moved or (city.moved_at is None and number > sub.number):
            continue
        where = "in the batch" if city.moved_at else "handed in earlier"
        cities.setdefault(city.key, f"{city.name} is already in file F{number} ({name}), {where}")
    in_batches = db.execute(
        select(LeadList.city, Batch.name)
        .join(Batch, LeadList.batch_id == Batch.id)
        .where(func.lower(func.trim(Batch.niche)) == niche)
    )
    for city_name, batch_name in in_batches:
        key = files.city_key(city_name)
        if key not in own_moved:
            cities.setdefault(key, f"{city_name} is already in the {batch_name} batch")

    # Businesses in a batch (not the ones this file brought there itself) ...
    registry = service.Registry({}, {}, {})
    query = select(Lead)
    if own_imports:
        query = query.where(
            Lead.first_import_id.is_(None) | Lead.first_import_id.not_in(own_imports)
        )
    for lead in db.scalars(query):
        registry.add(lead)
    batch_names = {b.id: b.name for b in db.scalars(select(Batch))}
    # ... and in the files handed in before it, of any niche, not yet in a batch.
    by_key: dict[str, list[tuple[dict[str, str], str]]] = {}
    earlier = db.scalars(
        select(Submission).where(
            Submission.id != sub.id,
            Submission.number < sub.number,
            Submission.state == "checked",
        )
    )
    for other in earlier:
        moved = {c.key for c in other.cities if c.moved_at is not None}
        for item in other.leads:
            values = item["values"]
            if item.get("muted") or files.city_key(values.get("city", "")) in moved:
                continue
            label = f"in file F{other.number} ({other.file_name}) as {item.get('id', '')}"
            for key in reader.keys(values):
                by_key.setdefault(key, []).append((values, label))

    def same(values: dict[str, str]) -> str | None:
        match = registry.match(values)
        if match is not None:
            batch = batch_names.get(match.batch_id) if match.batch_id else None
            return f"in the {batch or 'Hub'} batch as {match.lead_id}"
        for key in reader.keys(values):
            for known, label in by_key.get(key, []):
                if reader.same_business(known, values):
                    return label
        return None

    return files.Others(cities=cities, same=same)


def sync(sub: Submission, found: dict[str, dict[str, object]]) -> None:
    """Keep the file's cities as its check found them. A city in the batch stays as it is;
    a city muted now loses its Top."""
    have = {c.key: c for c in sub.cities}
    for key, item in found.items():
        city = have.pop(key, None)
        if city is None:
            city = FileCity(key=key[:120], tops=[])
            sub.cities.append(city)
        city.name = str(item["name"])[:120] or key[:120]
        city.businesses = int(str(item["businesses"]))
        if city.moved_at is None:
            city.muted = str(item.get("muted") or "")[:300]
            if city.muted:
                city.tops, city.topped_at = [], None
    for city in have.values():
        if city.moved_at is None:
            sub.cities.remove(city)


def forget_tops(sub: Submission) -> None:
    """A new version of the file: its cities' Tops (by row) start again."""
    for city in sub.cities:
        if city.moved_at is None:
            city.tops, city.topped_at = [], None


def niche_batch(db: Session, niche: str, user: User | None) -> Batch:
    """The niche's batch, made (named after the niche) when its first city comes: with the
    niche's benchmark when it has one, else without (it can't be started until one is
    chosen)."""
    key = _niche(niche)
    batch = db.scalar(
        select(Batch)
        .where(func.lower(func.trim(Batch.niche)) == key)
        .order_by(Batch.position, Batch.created_at)
        .limit(1)
    )
    if batch is not None:
        return batch
    choices = list(
        db.scalars(select(Benchmark).where(func.lower(func.trim(Benchmark.niche)) == key))
    )
    name = niche.strip()
    if db.scalar(select(Batch.id).where(func.lower(Batch.name) == name.lower())) is not None:
        name = f"{name} batch"
    batch = Batch(
        name=name,
        niche=niche.strip(),
        benchmark_id=choices[0].id if len(choices) == 1 else None,
        created_by=user.id if user is not None else None,
        position=(db.scalar(select(func.max(Batch.position))) or 0) + 1,
    )
    db.add(batch)
    db.flush()
    audit.record(db, user, "create", "batch", batch.id, batch.name, [])
    return batch


def move(db: Session, sub: Submission, city: FileCity, user: User | None) -> Batch:
    """Save a ready city's businesses in its niche's batch, its Top as Top."""
    db.execute(text("SELECT pg_advisory_xact_lock(4242003)"))  # one batch per niche
    batch = niche_batch(db, sub.niche, user)
    imp = service.preview(
        db,
        user,
        f"{sub.file_name} · {city.name}",
        sub.content,
        batch,
        set(city.tops),
        city=city.key,
        uploaded_by=sub.uploaded_by,
    )
    db.flush()
    service.confirm(db, imp, user)
    city.moved_at, city.import_id = now(), imp.id
    audit.record(
        db,
        user,
        "send to batch",
        "file",
        sub.id,
        f"{sub.file_name} · {city.name}",
        [{"field": "batch", "from": None, "to": batch.name}],
    )
    return batch


def movable(sub: Submission, city: FileCity) -> bool:
    return sent_without_errors(sub) and state(city) == "ready"


def move_due(db: Session) -> int:
    """Ready cities whose hour is over go on to their batch (in the scheduler)."""
    due = list(
        db.scalars(
            select(FileCity)
            .join(Submission, FileCity.submission_id == Submission.id)
            .where(
                FileCity.moved_at.is_(None),
                FileCity.muted == "",
                FileCity.topped_at.is_not(None),
                FileCity.topped_at <= now() - files.READY_WAIT,
                Submission.state == "checked",
                Submission.sent_at.is_not(None),
            )
            .order_by(FileCity.topped_at)
            .with_for_update(of=FileCity, skip_locked=True)
        )
    )
    moved = 0
    for city in due:
        if not movable(city.file, city):
            continue
        try:
            with db.begin_nested():
                move(db, city.file, city, None)
            moved += 1
        except ApiError as error:
            log.warning("city %s of file %s didn't move: %s", city.name, city.file.id, error)
    return moved


def unmute_sent(db: Session, sub: Submission, city: FileCity) -> None:
    """Unmute a city of a file already sent on to Top Review (step 41): the file isn't
    checked again, only the city's businesses are, here and now. With an error among them
    it stays muted (it would have held the file back)."""
    against = others(db, sub)
    bad = 0
    leads = []
    for lead in sub.leads:
        if files.city_key(lead["values"].get("city", "")) == city.key:
            found = check.check_lead(lead["values"])
            if len(lead.get("rows", [])) > 1 or against.same(lead["values"]):
                found.append(check.issue("SAME_ELSEWHERE", "business_name"))
            bad += bool(found)
            lead = {k: v for k, v in lead.items() if k != "muted"}
        leads.append(lead)
    if bad:
        raise ApiError(
            409,
            "city_errors",
            f"{bad} {'business' if bad == 1 else 'businesses'} of {city.name} have errors: "
            "a city of a file sent on to Top Review is unmuted only without errors.",
        )
    sub.leads = leads
    city.muted = ""
    city.items = files.city_businesses(leads, city.key)
