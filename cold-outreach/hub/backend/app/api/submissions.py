"""`/api/submissions`: the Files screen (SPEC steps 31, 32 and 39). The external team
(Collectors) hand in lead files, see Lead Check's problems and fix them until there is no
error; after the Final check the file goes on to Top Review (`app/api/review`), where each
city gets its Top, and each city with a Top goes on to its niche's batch (step 39,
`app/imports/file_cities`).

A Collector sees only their own files and changes them only until they are sent on to Top
Review; Owners, Admins and Viewers see every file. A file with a city in its batch can't be
deleted."""

import re
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, File, Form, Query, Response, UploadFile
from pydantic import BaseModel, StringConstraints
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session, selectinload

from app import audit
from app.api.imports import MAX_BYTES, NicheName
from app.api.niches import niche_names
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.db.models import Batch, FileCity, Niche, Role, Submission, User
from app.errors import ApiError
from app.imports import check, file_cities, fixes
from app.imports import submissions as files
from app.permissions import Action, can, ensure

router = APIRouter(tags=["files"])

# checking (or failed: unreadable) → errors (Collectors fix them) → final_check (an hour, or
# until sent on) → top_review (its cities get their Top and go on to the batch) → in_batch
Status = Literal["checking", "failed", "errors", "final_check", "top_review", "in_batch"]


class CityOut(BaseModel):
    key: str
    name: str
    businesses: int
    state: file_cities.CityState
    tops: int
    muted: str  # why, when it is muted
    moves_at: datetime | None  # a ready city goes on to the batch then
    moved_at: datetime | None


class FileOut(BaseModel):
    id: uuid.UUID
    number: int  # its businesses' File IDs are F<number>-0001… (step 35)
    file_name: str
    niche: str
    batch_name: str  # the niche's batch its cities go to (step 39): named after the niche
    version: int
    businesses: int
    errors: int
    warnings: int
    status: Status
    uploaded_by: str | None
    mine: bool
    created_at: datetime
    updated_at: datetime
    # The same leads were handed in before as another file (a warning on the screen).
    same_as: str | None = None
    # Its cities (step 39): those that go on to the batch (10 businesses or more, or with a
    # Top), how many of them are in it, ready (have a Top) or muted.
    cities_going: int = 0
    cities_in_batch: int = 0
    cities_ready: int = 0
    cities_muted: int = 0
    # Checked in the background (step 33): how far, and why it couldn't be read.
    progress: int = 100
    error: str | None = None
    # In its Final check (step 36): when it goes on to Top Review by itself.
    sends_at: datetime | None = None
    can_send_cities: bool = False  # may send its ready cities to the batch now


class Duplicates(BaseModel):
    """What Remove duplicates (step 40) takes out of the file."""

    rows: int  # extra rows of a business on several rows (its first row stays)
    elsewhere: int  # businesses already handed in (another file, or a batch)


class FileDetail(FileOut):
    tabs: dict[str, Any]
    problems: list[dict[str, Any]]
    cities: list[CityOut]
    duplicates: Duplicates


def status_of(sub: Submission) -> Status:
    if sub.state in ("checking", "failed"):
        return "checking" if sub.state == "checking" else "failed"
    if sub.check.get("errors"):
        return "errors"
    if sub.sent_at is None:
        return "final_check"
    if any(file_cities.state(c) in ("ready", "needs_top") for c in sub.cities):
        return "top_review"
    return "in_batch"


def _same_as(db: Session, me: User, sub: Submission) -> str | None:
    """Another file with the same leads: named when the person may see it."""
    if not sub.sha256:
        return None  # not checked yet
    others = list(
        db.scalars(
            select(Submission)
            .where(Submission.sha256 == sub.sha256, Submission.id != sub.id)
            .order_by(Submission.created_at)
        )
    )
    if not others:
        return None
    shown = [o for o in others if _may_see(me, o)]
    if not shown:
        return "The same leads were handed in before as another file."
    return f'Same leads as "{shown[0].file_name}".'


def _city(city: FileCity) -> CityOut:
    found = file_cities.state(city)
    return CityOut(
        key=city.key,
        name=city.name,
        businesses=city.businesses,
        state=found,
        tops=len(city.tops),
        muted=city.muted,
        moves_at=city.topped_at + files.READY_WAIT if found == "ready" and city.topped_at else None,
        moved_at=city.moved_at,
    )


def batch_names(db: Session) -> dict[str, str]:
    """Each niche (lower case) -> the name of its batch."""
    found: dict[str, str] = {}
    for batch in db.scalars(select(Batch).order_by(Batch.position, Batch.created_at)):
        found.setdefault(batch.niche.strip().lower(), batch.name)
    return found


def _may_send_cities(me: User, sub: Submission) -> bool:
    """Anyone but a Viewer sends a file's ready cities on (step 39); a Collector only their
    own file's."""
    if not can(me, Action.SEND_TO_BATCH):
        return False
    return me.role != Role.COLLECTOR or sub.uploaded_by == me.id


def _out(db: Session, me: User, sub: Submission, names: dict[str, str] | None = None) -> FileOut:
    states = [file_cities.state(c) for c in sub.cities]
    status = status_of(sub)
    names = batch_names(db) if names is None else names
    return FileOut(
        id=sub.id,
        number=sub.number,
        file_name=sub.file_name,
        niche=sub.niche,
        batch_name=names.get(sub.niche.strip().lower(), sub.niche),
        version=sub.version,
        businesses=sub.businesses,
        errors=int(sub.check.get("errors", 0)),
        warnings=int(sub.check.get("warnings", 0)),
        status=status,
        uploaded_by=sub.uploader.name if sub.uploader else None,
        mine=sub.uploaded_by == me.id,
        created_at=sub.created_at,
        updated_at=sub.updated_at,
        same_as=_same_as(db, me, sub),
        cities_going=sum(1 for s in states if s in ("in_batch", "ready", "needs_top")),
        cities_in_batch=states.count("in_batch"),
        cities_ready=states.count("ready"),
        cities_muted=states.count("muted"),
        progress=sub.progress,
        error=sub.error,
        sends_at=sub.clean_since + files.FINAL_CHECK
        if status == "final_check" and sub.clean_since
        else None,
        can_send_cities=status == "top_review" and "ready" in states and _may_send_cities(me, sub),
    )


def _detail(db: Session, me: User, sub: Submission) -> FileDetail:
    order = {"needs_top": 0, "ready": 1, "small": 2, "muted": 3, "in_batch": 4}
    cities = sorted((_city(c) for c in sub.cities), key=lambda c: (order[c.state], c.name.lower()))
    return FileDetail(
        **_out(db, me, sub).model_dump(),
        tabs=sub.check.get("tabs", {}),
        problems=sub.problems,
        cities=cities,
        duplicates=Duplicates(
            rows=sum(len(lead.get("rows", [])) - 1 for lead in sub.leads if not _elsewhere(lead)),
            elsewhere=sum(1 for lead in sub.leads if _elsewhere(lead)),
        ),
    )


def _elsewhere(lead: dict[str, Any]) -> bool:
    """A business already handed in, in another file or a batch (step 39)."""
    return any(i["code"] == "SAME_ELSEWHERE" for i in lead["issues"])


def _may_see(me: User, sub: Submission) -> bool:
    if can(me, Action.VIEW_ALL_FILES):
        return True
    return can(me, Action.SUBMIT_FILES) and sub.uploaded_by == me.id


def _get(db: Session, me: User, file_id: uuid.UUID) -> Submission:
    """A file the person may see; someone else's file reads as not there for a Collector."""
    sub = db.get(Submission, file_id)
    if sub is None or not _may_see(me, sub):
        raise ApiError(404, "not_found", "That file doesn't exist.")
    return sub


def _changeable(db: Session, me: User, file_id: uuid.UUID, revise: bool) -> Submission:
    """A file the person may revise or delete: their own (or any, for Owners and Admins),
    until it is sent on to Top Review (step 39: then nobody revises it). Owners and Admins
    delete it later too, until a city of it is in its batch."""
    sub = _get(db, me, file_id)
    ensure(me, Action.SUBMIT_FILES)
    if sub.uploaded_by != me.id and not can(me, Action.USE_FILES):
        raise ApiError(403, "forbidden", "Only the person who handed it in can change it.")
    if status_of(sub) in ("checking", "failed", "errors", "final_check"):
        return sub
    if revise or not can(me, Action.USE_FILES):
        raise ApiError(
            409, "sent_on", "This file is sent on to Top Review: it can't be changed any more."
        )
    if any(c.moved_at is not None for c in sub.cities):
        raise ApiError(409, "in_batch", "A city of this file is in its batch: it can't be deleted.")
    return sub


def _read(file: UploadFile) -> bytes:
    content = file.file.read(MAX_BYTES + 1)
    if len(content) > MAX_BYTES:
        raise ApiError(413, "too_large", "The file is over 20 MB.", {"file": "Over 20 MB."})
    return content


def _store(sub: Submission, content: bytes) -> None:
    """Keep the file as it came; the file checker checks it in the background (step 33)."""
    sub.content = content
    sub.state, sub.progress, sub.error, sub.claimed_at = "checking", 0, None, None
    sub.sha256, sub.businesses, sub.check, sub.problems, sub.leads = "", 0, {}, [], []
    sub.clean_since, sub.sent_at = None, None
    file_cities.forget_tops(sub)


@router.get("/submissions/niches", response_model=list[NicheName])
def niches(me: CurrentUser, db: Db) -> list[str]:
    """The niches a file can be handed in for (those of the benchmarks and batches)."""
    ensure(me, Action.SUBMIT_FILES)
    return sorted(niche_names(db).values(), key=str.lower)


@router.get("/submissions", response_model=list[FileOut])
def list_files(me: CurrentUser, db: Db) -> list[FileOut]:
    if not can(me, Action.VIEW_ALL_FILES):
        ensure(me, Action.SUBMIT_FILES)
    query = (
        select(Submission)
        .options(selectinload(Submission.cities), selectinload(Submission.uploader))
        .order_by(Submission.created_at.desc())
        .limit(500)
    )
    if not can(me, Action.VIEW_ALL_FILES):
        query = query.where(Submission.uploaded_by == me.id)
    names = batch_names(db)
    return [_out(db, me, sub, names) for sub in db.scalars(query)]


@router.post("/submissions", response_model=FileDetail, status_code=201)
def hand_in(
    me: CurrentUser,
    db: Db,
    file: Annotated[UploadFile, File()],
    niche: Annotated[str, Form(), StringConstraints(strip_whitespace=True, max_length=80)],
) -> FileDetail:
    """Hand in a lead file: Lead Check runs on it at once, in the background."""
    ensure(me, Action.SUBMIT_FILES)
    chosen = niche_names(db).get(niche.strip().lower())
    if chosen is None:
        raise ApiError(422, "unknown_niche", "Choose one of the niches.", {"niche": "Unknown."})
    content = _read(file)
    # One file at a time takes the next number (its File IDs start with it, step 35).
    db.execute(text("SELECT pg_advisory_xact_lock(4242002)"))
    number = (db.scalar(select(func.max(Submission.number))) or 0) + 1
    if db.scalar(select(Niche.id).where(func.lower(Niche.name) == chosen.lower())) is None:
        db.add(Niche(name=chosen))
    sub = Submission(
        file_name=(file.filename or "leads.xlsx")[:255],
        niche=chosen,
        uploaded_by=me.id,
        number=number,
    )
    _store(sub, content)
    db.add(sub)
    db.flush()
    audit.record(db, me, "hand in", "file", sub.id, sub.file_name, [])
    db.commit()
    db.refresh(sub)
    return _detail(db, me, sub)


@router.get("/submissions/{file_id}", response_model=FileDetail)
def get_file(file_id: uuid.UUID, me: CurrentUser, db: Db) -> FileDetail:
    return _detail(db, me, _get(db, me, file_id))


@router.post("/submissions/{file_id}/version", response_model=FileDetail)
def revise(
    file_id: uuid.UUID, me: CurrentUser, db: Db, file: Annotated[UploadFile, File()]
) -> FileDetail:
    """A revised version replaces the file and is checked again (its Tops start again)."""
    sub = _changeable(db, me, file_id, revise=True)
    _replace(db, me, sub, _read(file))
    db.refresh(sub)
    return _detail(db, me, sub)


def _replace(db: Session, me: User, sub: Submission, content: bytes) -> None:
    """A whole new version of the file, checked again."""
    _store(sub, content)
    sub.version += 1
    audit.record(
        db,
        me,
        "revise",
        "file",
        sub.id,
        sub.file_name,
        [{"field": "version", "from": sub.version - 1, "to": sub.version}],
    )
    db.commit()


@router.get("/submissions/{file_id}/marked.xlsx")
def marked(file_id: uuid.UUID, me: CurrentUser, db: Db) -> Response:
    """The fix file (steps 34 and 35): the businesses with a problem on one sheet by city,
    each with its File ID and wrong cells marked, to fix in Excel and send with Upload fixes."""
    sub = _get(db, me, file_id)
    if status_of(sub) in ("checking", "failed"):
        raise ApiError(409, "not_checked", "This file isn't checked yet.")
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", sub.file_name.rsplit(".", 1)[0])[:80]
    name = f"{stem or 'file'}-v{sub.version}-to-fix.xlsx"
    return Response(
        files.fix_file(sub.leads),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


@router.post("/submissions/{file_id}/fixes")
def upload_fixes(
    file_id: uuid.UUID,
    me: CurrentUser,
    db: Db,
    file: Annotated[UploadFile, File()],
    confirm: Annotated[bool, Form()] = False,
) -> dict[str, Any]:
    """The fix file back from Excel (steps 34 and 35): each row found by its File ID, every
    column of the file changing its value (an empty cell clears it), Delete = Yes taking the
    business out. Without `confirm` nothing is saved: the answer says what would change. Saved,
    the file is made again with the fixes, as a new version, and checked again.

    A file without a File ID column is a whole new version (step 37): the answer says so, and
    with `confirm` it replaces the file, as Upload revised version did."""
    sub = _changeable(db, me, file_id, revise=True)
    content = _read(file)
    try:
        rows = files.read_fixes(content)
    except files.NoFileId:
        if confirm:
            _replace(db, me, sub, content)
        return {
            "saved": confirm,
            "whole_file": True,
            "version_after": sub.version if confirm else sub.version + 1,
            "rows": 0,
            "changed": [],
            "removed": [],
            "skipped": [],
            "businesses_after": None,
        }
    except fixes.FixFileError as error:
        raise ApiError(422, "unreadable", str(error), {"file": str(error)}) from None
    leads = [dict(lead, values=dict(lead["values"])) for lead in sub.leads]
    by_key = {lead["id"]: lead for lead in leads}
    changed: list[dict[str, Any]] = []
    removed: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        where = {"tab": row.tab, "line": row.line, "file_id": row.key}
        lead = by_key.get(row.key)
        if lead is None:
            skipped.append(where | {"reason": "No business of this file has that File ID."})
            continue
        if row.key in seen:
            skipped.append(where | {"reason": "This File ID is on an earlier row too."})
            continue
        seen.add(row.key)
        name = lead["values"].get("business_name") or lead["values"].get("gbp_link", "")
        if row.delete:
            removed.append(where | {"business_name": name})
            lead["removed"] = True
            continue
        changes = [
            {"field": fixes.LABELS[f], "from": lead["values"].get(f, ""), "to": value}
            for f, value in row.values.items()
            if value != lead["values"].get(f, "")
        ]
        for f, value in row.values.items():
            if value:
                lead["values"][f] = value[:500]
            else:
                lead["values"].pop(f, None)
        if changes:
            changed.append(where | {"business_name": name, "changes": changes})
    kept = [lead for lead in leads if not lead.get("removed")]
    if confirm and (changed or removed):
        if not kept:
            raise ApiError(409, "empty", "That would take every business out of the file.")
        _store(sub, files.rebuilt(kept))
        sub.version += 1
        audit.record(
            db,
            me,
            "fix",
            "file",
            sub.id,
            sub.file_name,
            [
                {"field": "version", "from": sub.version - 1, "to": sub.version},
                {"field": "businesses changed", "from": None, "to": len(changed)},
                {"field": "businesses taken out", "from": None, "to": len(removed)},
            ],
        )
        db.commit()
    return {
        "saved": bool(confirm and (changed or removed)),
        "whole_file": False,
        "version_after": sub.version,
        "rows": len(rows),
        "changed": changed,
        "removed": removed,
        "skipped": skipped,
        "businesses_after": len(kept),
    }


@router.post("/submissions/{file_id}/remove-duplicates", response_model=FileDetail)
def remove_duplicates(file_id: uuid.UUID, me: CurrentUser, db: Db) -> FileDetail:
    """Remove duplicates (step 40): a business on several rows keeps its first row (gaps
    filled from the others, emails pooled), and a business already handed in (in another
    file or a batch) is taken out of this file. The file is made again as a new version and
    checked again. Whoever may upload fixes may do this."""
    sub = _changeable(db, me, file_id, revise=True)
    if sub.state != "checked":
        raise ApiError(409, "not_checked", "This file isn't checked yet.")
    extra = sum(len(lead.get("rows", [])) - 1 for lead in sub.leads if not _elsewhere(lead))
    taken_out = [lead for lead in sub.leads if _elsewhere(lead)]
    if not extra and not taken_out:
        raise ApiError(409, "no_duplicates", "This file has no duplicates.")
    kept = [lead for lead in sub.leads if not _elsewhere(lead)]
    if not kept:
        raise ApiError(409, "empty", "That would take every business out of the file.")
    _store(sub, files.rebuilt(kept, once=True))
    sub.version += 1
    audit.record(
        db,
        me,
        "remove duplicates",
        "file",
        sub.id,
        sub.file_name,
        [
            {"field": "version", "from": sub.version - 1, "to": sub.version},
            {"field": "duplicate rows removed", "from": None, "to": extra},
            {"field": "already handed in, taken out", "from": None, "to": len(taken_out)},
        ],
    )
    db.commit()
    db.refresh(sub)
    return _detail(db, me, sub)


LEADS_PAGE = 100


def _matches(lead: dict[str, Any], words: list[str]) -> bool:
    found = " ".join([lead.get("id", ""), *lead["values"].values()]).lower()
    return all(word in found for word in words)


def _number(text: str) -> float:
    count = check.reviews_count(text.replace(",", "")) if text else None
    return count if count is not None else -1.0


@router.get("/submissions/{file_id}/leads")
def file_leads(
    file_id: uuid.UUID,
    me: CurrentUser,
    db: Db,
    search: Annotated[str, Query(max_length=200)] = "",
    city: Annotated[str, Query(max_length=120)] = "",
    problems: Annotated[Literal["", "problems", "errors", "warnings", "ok"], Query()] = "",
    sort: Annotated[
        Literal["row", "id", "name", "city", "reviews", "rating", "problems"], Query()
    ] = "row",
    page: Annotated[int, Query(ge=1, le=10_000)] = 1,
) -> dict[str, Any]:
    """The file's businesses as a table (step 33), filtered, sorted and a page at a time:
    each with its tab and row, values and Lead Check problems. Only to look at: fixes are
    made in Excel and handed in as a revised version."""
    sub = _get(db, me, file_id)
    rows: list[dict[str, Any]] = list(sub.leads)

    def errors(lead: dict[str, Any]) -> int:
        return sum(1 for i in lead["issues"] if i["severity"] == "error")

    def kinds(lead: dict[str, Any]) -> set[str]:
        """Errors and Warnings are the businesses with one; Problems those with either."""
        found = {i["severity"] + "s" for i in lead["issues"]}
        return found | {"problems"} if found else {"ok"}

    if city:
        rows = [r for r in rows if r["values"].get("city", "").lower() == city.strip().lower()]
    if words := search.lower().split():
        rows = [r for r in rows if _matches(r, words)]
    counts = {"all": len(rows), "problems": 0, "errors": 0, "warnings": 0, "ok": 0}
    for row in rows:
        for found in kinds(row):
            counts[found] += 1
    if problems:
        rows = [r for r in rows if problems in kinds(r)]
    if sort == "id":
        rows.sort(key=lambda r: r.get("id", ""))
    elif sort == "name":
        rows.sort(key=lambda r: r["values"].get("business_name", "").lower())
    elif sort == "city":
        rows.sort(key=lambda r: (r["values"].get("city", "").lower(), r["line"]))
    elif sort in ("reviews", "rating"):
        rows.sort(key=lambda r: -_number(r["values"].get(sort, "")))
    elif sort == "problems":
        rows.sort(key=lambda r: (-errors(r), -len(r["issues"])))
    pages = max(1, -(-len(rows) // LEADS_PAGE))
    cities = sorted({r["values"].get("city", "") for r in sub.leads} - {""}, key=str.lower)
    return {
        "total": len(rows),
        "page": page,
        "pages": pages,
        "counts": counts,
        "cities": cities,
        "leads": rows[(page - 1) * LEADS_PAGE : page * LEADS_PAGE],
    }


@router.delete("/submissions/{file_id}", status_code=204)
def delete_file(file_id: uuid.UUID, me: CurrentUser, db: Db) -> None:
    """Delete a file before it is added to a batch."""
    sub = _changeable(db, me, file_id, revise=False)
    audit.record(db, me, "delete", "file", sub.id, sub.file_name, [])
    db.delete(sub)
    db.commit()


@router.post("/submissions/{file_id}/send", response_model=FileOut)
def send(file_id: uuid.UUID, me: CurrentUser, db: Db) -> FileOut:
    """Send a file without errors on to Top Review now, before its Final check hour is over
    (step 36): by whoever handed it in, or an Owner or Admin."""
    sub = _get(db, me, file_id)
    if not (
        can(me, Action.USE_FILES) or (can(me, Action.SUBMIT_FILES) and sub.uploaded_by == me.id)
    ):
        raise ApiError(403, "forbidden", "Only the person who handed it in can send it on.")
    if status_of(sub) != "final_check":
        raise ApiError(409, "not_final_check", "Only a file in its Final check is sent on.")
    files.send_on(sub)
    audit.record(db, me, "send to Top Review", "file", sub.id, sub.file_name, [])
    db.commit()
    db.refresh(sub)
    return _out(db, me, sub)


class ToBatchIn(Strict):
    # One city (lower case), or every ready city of the file when left out.
    city: Annotated[str, StringConstraints(max_length=120)] | None = None


@router.post("/submissions/{file_id}/to-batch", response_model=FileDetail)
def to_batch(file_id: uuid.UUID, body: ToBatchIn, me: CurrentUser, db: Db) -> FileDetail:
    """Send a file's ready cities (those with a Top) to the niche's batch now, before their
    hour is over (step 39): anyone but a Viewer; a Collector only for their own file."""
    sub = db.scalar(select(Submission).where(Submission.id == file_id).with_for_update())
    if sub is None or not (_may_see(me, sub) or can(me, Action.REVIEW_TOPS)):
        raise ApiError(404, "not_found", "That file doesn't exist.")
    if not _may_send_cities(me, sub):
        raise ApiError(403, "forbidden", "Only its sender, a Reviewer or an Owner or Admin can.")
    chosen = [c for c in sub.cities if body.city is None or c.key == files.city_key(body.city)]
    if body.city is not None and not chosen:
        raise ApiError(404, "not_found", "That city isn't in this file.")
    ready = [c for c in chosen if file_cities.movable(sub, c)]
    if not ready:
        raise ApiError(409, "not_ready", "No city of it is ready: choose its Top first.")
    for city in ready:
        file_cities.move(db, sub, city, me)
    db.commit()
    db.refresh(sub)
    return _detail(db, me, sub)


@router.post("/submissions/{file_id}/cities/{city}/unmute", response_model=FileDetail)
def unmute(file_id: uuid.UUID, city: str, me: CurrentUser, db: Db) -> FileDetail:
    """An Owner or Admin unmutes a muted city once no other file or batch has it (step 39):
    the file is checked again, the city's businesses too."""
    ensure(me, Action.USE_FILES)
    sub = _get(db, me, file_id)
    found = next((c for c in sub.cities if c.key == files.city_key(city)), None)
    if found is None:
        raise ApiError(404, "not_found", "That city isn't in this file.")
    if file_cities.state(found) != "muted":
        raise ApiError(409, "not_muted", f"{found.name} isn't muted.")
    if sub.state != "checked":
        raise ApiError(409, "checking", "This file is being checked: try again in a moment.")
    still = file_cities.others(db, sub).cities.get(found.key)
    if still:
        raise ApiError(409, "still_taken", f"It can't be unmuted: {still}.")
    sub.state, sub.progress, sub.claimed_at = "checking", 0, None
    audit.record(db, me, "unmute", "file", sub.id, f"{sub.file_name} · {found.name}", [])
    db.commit()
    db.refresh(sub)
    return _detail(db, me, sub)
