"""Fix files (SPEC step 28): download the leads with a Lead Check problem as Excel, each
wrong cell marked, fix them offline and upload the file back. The upload shows what would
change first (nothing saved); confirming saves it, lead by lead, in History."""

import re
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, File, Form, Response, UploadFile
from sqlalchemy import func, select

from app import audit
from app.api.batches import get_batch
from app.auth.deps import CurrentUser, Db
from app.db.models import Import, ImportStatus, Lead
from app.errors import ApiError
from app.imports import check, fixes, lead_check
from app.leads import edit
from app.permissions import Action, ensure

router = APIRouter(tags=["fixes"])

MAX_BYTES = 20 * 1024 * 1024
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _excel(content: bytes, stem: str) -> Response:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", stem)[:80] or "leads"
    return Response(
        content,
        media_type=XLSX,
        headers={"Content-Disposition": f'attachment; filename="fix-{safe}.xlsx"'},
    )


def _with_problems(db: Db, batch_id: uuid.UUID, ids: list[str] | None = None) -> list[Lead]:
    lead_check.ensure_checked(db, batch_id)
    query = select(Lead).where(
        Lead.batch_id == batch_id,
        Lead.check.is_not(None),
        func.jsonb_array_length(Lead.check) > 0,
    )
    if ids is not None:
        query = query.where(Lead.lead_id.in_(ids))
    return list(db.scalars(query.order_by(func.lower(Lead.city), Lead.lead_id)))


@router.get("/batches/{batch_id}/fixes.xlsx")
def batch_fix_file(batch_id: uuid.UUID, me: CurrentUser, db: Db) -> Response:
    """Every lead of the batch with a problem (errors and warnings), one tab per city."""
    ensure(me, Action.VIEW_HUB)
    batch = get_batch(db, batch_id)
    content = fixes.build(_with_problems(db, batch.id))
    db.commit()  # leads saved before Lead Check were checked just now
    return _excel(content, batch.name)


@router.get("/imports/{import_id}/fixes.xlsx")
def file_fix_file(import_id: uuid.UUID, me: CurrentUser, db: Db) -> Response:
    """The leads of one saved file with a problem."""
    ensure(me, Action.VIEW_HUB)
    imp = db.get(Import, import_id)
    if imp is None or imp.status != ImportStatus.CONFIRMED or imp.batch_id is None:
        raise ApiError(404, "not_found", "That saved file doesn't exist.")
    content = fixes.build(_with_problems(db, imp.batch_id, lead_check.file_leads(imp)))
    db.commit()
    return _excel(content, imp.file_name.rsplit(".", 1)[0])


def _counts(issues: list[dict[str, Any]] | None) -> tuple[int, int]:
    errors = check.errors(issues)
    return errors, len(issues or []) - errors


@router.post("/batches/{batch_id}/fixes")
def upload_fixes(
    batch_id: uuid.UUID,
    me: CurrentUser,
    db: Db,
    file: Annotated[UploadFile, File()],
    confirm: Annotated[bool, Form()] = False,
) -> dict[str, Any]:
    """A fix file back from Excel: rows matched by Lead ID within this batch, every column
    of the file changing its field (an empty cell clears it). Without `confirm` nothing is
    saved: the answer says what would change and what Lead Check would say then."""
    ensure(me, Action.EDIT_LEADS)
    batch = get_batch(db, batch_id)
    content = file.file.read(MAX_BYTES + 1)
    if len(content) > MAX_BYTES:
        raise ApiError(413, "too_large", "The file is over 20 MB.", {"file": "Over 20 MB."})
    try:
        rows = fixes.read(content)
    except fixes.FixFileError as error:
        raise ApiError(422, "unreadable", str(error), {"file": str(error)}) from None
    lead_check.ensure_checked(db, batch.id)
    ids = {row.lead_id for row in rows if row.lead_id}
    leads = {lead.lead_id: lead for lead in db.scalars(select(Lead).where(Lead.lead_id.in_(ids)))}
    changed: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    refused: list[dict[str, Any]] = []
    seen: set[str] = set()
    unchanged = errors_before = errors_after = warnings_after = 0
    for row in rows:
        where = {"tab": row.tab, "line": row.line, "lead_id": row.lead_id}
        lead = leads.get(row.lead_id)
        if not row.lead_id:
            skipped.append(where | {"reason": "No Lead ID: new businesses go in a lead file."})
            continue
        if lead is None or lead.batch_id != batch.id:
            skipped.append(where | {"reason": f"Not a lead of {batch.name}."})
            continue
        if row.lead_id in seen:
            skipped.append(where | {"reason": "This Lead ID is on an earlier row too."})
            continue
        seen.add(row.lead_id)
        before = _counts(lead.check)
        try:
            changes = edit.apply(db, lead, row.values)
        except edit.EditError as error:
            label = fixes.LABELS.get(error.field, error.field)
            refused.append(
                where
                | {"business_name": lead.business_name, "field": label, "message": error.message}
            )
            errors_before += before[0]
            errors_after += before[0]
            continue
        after = _counts(lead.check)
        errors_before += before[0]
        errors_after += after[0]
        warnings_after += after[1]
        if not changes:
            unchanged += 1
            continue
        changed.append(
            where
            | {
                "business_name": lead.business_name,
                "city": lead.city,
                "changes": [
                    {
                        "field": fixes.LABELS.get(c["field"], c["field"]),
                        "from": c["from"],
                        "to": c["to"],
                    }
                    for c in changes
                ],
                "errors": after[0],
                "warnings": after[1],
            }
        )
        if confirm:
            audit.record(db, me, "edit", "lead", lead.lead_id, lead.business_name, changes)
    db.flush()
    held_after = len(lead_check.held(db, batch.id))
    if confirm:
        db.commit()
    else:
        db.rollback()  # a preview: nothing is saved
    return {
        "saved": confirm,
        "rows": len(rows),
        "changed": changed,
        "unchanged": unchanged,
        "skipped": skipped,
        "refused": refused,
        "errors_before": errors_before,
        "errors_after": errors_after,
        "warnings_after": warnings_after,
        "held_files_after": held_after,
    }
