"""`/api/submissions`: the Files screen (SPEC steps 31 and 32). The external team
(Collectors) hand in lead files, see Lead Check's problems and upload revised versions until
there is no error; then Reviewers choose each city's Top businesses (Top Review,
`app/api/review`); an Owner or Admin adds the ready file to a batch of its niche, once.

A Collector sees only their own files and changes them only while they have errors;
Owners, Admins and Viewers see every file. A file being added to a batch (its preview waits)
or used (saved in a batch) can't be changed or deleted."""

import re
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, File, Form, Query, Response, UploadFile
from pydantic import BaseModel, StringConstraints
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app import audit
from app.api.batches import get_batch
from app.api.imports import MAX_BYTES, NicheName
from app.api.niches import niche_names
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.db.models import ImportStatus, Submission, User
from app.errors import ApiError
from app.imports import check, fixes, service
from app.imports import submissions as files
from app.permissions import Action, can, ensure

router = APIRouter(tags=["files"])

# checking (or failed: unreadable) → errors (Collectors fix them) → final_check (an hour, or
# until sent on) → needs_top (Top Review) → ready → adding → used
Status = Literal[
    "checking", "failed", "errors", "final_check", "needs_top", "ready", "adding", "used"
]


class BatchRef(BaseModel):
    batch_id: uuid.UUID | None
    batch_name: str | None
    import_id: uuid.UUID
    at: datetime | None
    by: str | None


class FileOut(BaseModel):
    id: uuid.UUID
    number: int  # its businesses' File IDs are F<number>-0001… (step 35)
    file_name: str
    niche: str
    version: int
    businesses: int
    errors: int
    warnings: int
    status: Status
    uploaded_by: str | None
    mine: bool
    created_at: datetime
    updated_at: datetime
    # Saved in a batch (used), or waiting for its preview to be confirmed there (adding).
    batch: BatchRef | None
    # The same leads were handed in before as another file (a warning on the screen).
    same_as: str | None = None
    # Top Review (step 32): the cities that need a Top (10 businesses or more) and how many
    # of them have one.
    cities_on: int = 0
    cities_topped: int = 0
    # Checked in the background (step 33): how far, and why it couldn't be read.
    progress: int = 100
    error: str | None = None
    # In its Final check (step 36): when it goes on to Top Review by itself.
    sends_at: datetime | None = None


class FileDetail(FileOut):
    tabs: dict[str, Any]
    problems: list[dict[str, Any]]


def status_of(sub: Submission) -> Status:
    imp = sub.imp
    if imp is not None and imp.status == ImportStatus.CONFIRMED:
        return "used"
    if imp is not None and imp.status == ImportStatus.PREVIEW:
        return "adding"
    if sub.state in ("checking", "failed"):
        return "checking" if sub.state == "checking" else "failed"
    if sub.check.get("errors"):
        return "errors"
    if sub.sent_at is None:
        return "final_check"
    return "needs_top" if sub.topped_at is None else "ready"


def _batch(sub: Submission) -> BatchRef | None:
    imp = sub.imp
    if imp is None or imp.status not in (ImportStatus.CONFIRMED, ImportStatus.PREVIEW):
        return None
    return BatchRef(
        batch_id=imp.batch_id,
        batch_name=imp.batch.name if imp.batch else None,
        import_id=imp.id,
        at=imp.confirmed_at or imp.created_at,
        by=imp.uploader.name if imp.uploader else None,
    )


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
    first = next((o for o in shown if status_of(o) == "used"), shown[0])
    where = _batch(first)
    if where and status_of(first) == "used":
        return f'Same leads as "{first.file_name}", used in {where.batch_name or "a batch"}.'
    return f'Same leads as "{first.file_name}".'


def _out(db: Session, me: User, sub: Submission) -> FileOut:
    on = files.cities_on(files.cities(sub))
    return FileOut(
        id=sub.id,
        number=sub.number,
        file_name=sub.file_name,
        niche=sub.niche,
        version=sub.version,
        businesses=sub.businesses,
        errors=int(sub.check.get("errors", 0)),
        warnings=int(sub.check.get("warnings", 0)),
        status=status_of(sub),
        uploaded_by=sub.uploader.name if sub.uploader else None,
        mine=sub.uploaded_by == me.id,
        created_at=sub.created_at,
        updated_at=sub.updated_at,
        batch=_batch(sub),
        same_as=_same_as(db, me, sub),
        cities_on=len(on),
        cities_topped=sum(1 for key in on if sub.tops.get(key)),
        progress=sub.progress,
        error=sub.error,
        sends_at=sub.clean_since + files.FINAL_CHECK
        if status_of(sub) == "final_check" and sub.clean_since
        else None,
    )


def _detail(db: Session, me: User, sub: Submission) -> FileDetail:
    return FileDetail(
        **_out(db, me, sub).model_dump(),
        tabs=sub.check.get("tabs", {}),
        problems=sub.problems,
    )


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
    """A file the person may revise or delete: their own (or any, for Owners and Admins).
    Once it has no error it is done for the Collectors (step 32): it is only revised while it
    has errors, and only Owners and Admins delete it then, until it is added to a batch."""
    sub = _get(db, me, file_id)
    ensure(me, Action.SUBMIT_FILES)
    if sub.uploaded_by != me.id and not can(me, Action.USE_FILES):
        raise ApiError(403, "forbidden", "Only the person who handed it in can change it.")
    status = status_of(sub)
    if status == "used":
        raise ApiError(409, "used", "This file is used in a batch: it can't be changed.")
    if status == "adding":
        raise ApiError(
            409, "adding", "This file is being added to a batch: confirm or discard it there."
        )
    if status not in ("checking", "failed", "errors", "final_check") and (
        revise or not can(me, Action.USE_FILES)
    ):
        raise ApiError(409, "no_errors", "This file has no errors: it can't be changed any more.")
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
    sub.tops, sub.topped_at, sub.clean_since, sub.sent_at = {}, None, None, None


@router.get("/submissions/niches", response_model=list[NicheName])
def niches(me: CurrentUser, db: Db) -> list[str]:
    """The niches a file can be handed in for (those of the benchmarks and batches)."""
    ensure(me, Action.SUBMIT_FILES)
    return sorted(niche_names(db).values(), key=str.lower)


@router.get("/submissions", response_model=list[FileOut])
def list_files(me: CurrentUser, db: Db) -> list[FileOut]:
    if not can(me, Action.VIEW_ALL_FILES):
        ensure(me, Action.SUBMIT_FILES)
    query = select(Submission).order_by(Submission.created_at.desc()).limit(500)
    if not can(me, Action.VIEW_ALL_FILES):
        query = query.where(Submission.uploaded_by == me.id)
    found = [_out(db, me, sub) for sub in db.scalars(query)]
    db.commit()  # the cities of files handed in before step 32 were read just now
    return found


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
    found = _detail(db, me, _get(db, me, file_id))
    db.commit()
    return found


@router.post("/submissions/{file_id}/version", response_model=FileDetail)
def revise(
    file_id: uuid.UUID, me: CurrentUser, db: Db, file: Annotated[UploadFile, File()]
) -> FileDetail:
    """A revised version replaces the file and is checked again (its Tops start again)."""
    sub = _changeable(db, me, file_id, revise=True)
    _store(sub, _read(file))
    sub.version += 1
    sub.import_id = None  # a discarded preview of the old version is forgotten
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
    db.refresh(sub)
    return _detail(db, me, sub)


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
    business out. Without `confirm` nothing is saved: the answer says what would change. Saved, the
    file is made again with the fixes, as a new version, and checked again."""
    sub = _changeable(db, me, file_id, revise=True)
    try:
        rows = files.read_fixes(_read(file))
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
        sub.import_id = None
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
        "rows": len(rows),
        "changed": changed,
        "removed": removed,
        "skipped": skipped,
        "businesses_after": len(kept),
    }


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


class UseIn(Strict):
    batch_id: uuid.UUID


@router.post("/submissions/{file_id}/use", response_model=FileOut)
def use(file_id: uuid.UUID, body: UseIn, me: CurrentUser, db: Db) -> FileOut:
    """Add a ready file to a batch of its niche: its preview waits in the batch, as if it
    were uploaded there. Once that preview is confirmed the file is used, for good."""
    ensure(me, Action.USE_FILES)
    ensure(me, Action.IMPORT_LEADS)
    sub = db.scalar(select(Submission).where(Submission.id == file_id).with_for_update())
    if sub is None:
        raise ApiError(404, "not_found", "That file doesn't exist.")
    status = status_of(sub)
    if status == "used":
        where = _batch(sub)
        name = where.batch_name if where else None
        raise ApiError(409, "used", f"This file is already used in {name or 'a batch'}.")
    if status == "adding":
        raise ApiError(
            409, "adding", "This file is already being added to a batch: confirm or discard it."
        )
    if status == "errors":
        raise ApiError(409, "not_ready", "This file still has errors: it has to be fixed first.")
    if status == "needs_top":
        raise ApiError(
            409, "needs_top", "Top isn't chosen in every city of this file yet (Top Review)."
        )
    batch = get_batch(db, body.batch_id)
    if batch.niche.strip().lower() != sub.niche.strip().lower():
        raise ApiError(
            409,
            "other_niche",
            f"This file is for {sub.niche}; {batch.name} is a {batch.niche} batch.",
        )
    twin = [
        other
        for other in db.scalars(
            select(Submission).where(
                Submission.sha256 == sub.sha256, Submission.sha256 != "", Submission.id != sub.id
            )
        )
        if status_of(other) == "used"
    ]
    if twin:
        where = _batch(twin[0])
        name = where.batch_name if where else None
        raise ApiError(
            409,
            "same_leads_used",
            f'The same leads were already used ("{twin[0].file_name}" in {name or "a batch"}).',
        )
    tops = {key for chosen in sub.tops.values() for key in chosen}
    imp = service.preview(db, me, sub.file_name, sub.content, batch, tops)
    db.flush()
    sub.import_id = imp.id
    audit.record(db, me, "upload", "import", imp.id, imp.file_name, [])
    audit.record(
        db,
        me,
        "add to batch",
        "file",
        sub.id,
        sub.file_name,
        [{"field": "batch", "from": None, "to": batch.name}],
    )
    db.commit()
    db.refresh(sub)
    return _out(db, me, sub)


@router.post("/submissions/{file_id}/reopen", response_model=FileOut)
def reopen(file_id: uuid.UUID, me: CurrentUser, db: Db) -> FileOut:
    """Give a ready file back to Top Review (its Tops are kept), before it is used."""
    ensure(me, Action.USE_FILES)
    sub = _get(db, me, file_id)
    if status_of(sub) != "ready":
        raise ApiError(409, "not_ready", "Only a ready file that isn't in a batch is reopened.")
    sub.topped_at = None
    audit.record(db, me, "reopen for Top Review", "file", sub.id, sub.file_name, [])
    db.commit()
    db.refresh(sub)
    return _out(db, me, sub)


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
