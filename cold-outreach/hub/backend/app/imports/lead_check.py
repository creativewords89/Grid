"""Lead Check in the database (steps 26 and 27): checking the leads not checked yet, which
files are held back because one of their leads has an error, and each file's report.

A file is **held** while any lead it brought or updated in its batch has an error (🔴):
agents get none of that file's leads until every error is fixed (SPEC step 26).
"""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Import, ImportStatus, Lead
from app.imports import check
from app.imports.service import recheck


def ensure_checked(db: Session, batch_id: uuid.UUID) -> None:
    """Check the batch's leads that never were (saved before Lead Check existed)."""
    leads = db.scalars(select(Lead).where(Lead.batch_id == batch_id, Lead.check.is_(None)))
    changed = False
    for lead in leads:
        recheck(lead)
        changed = True
    if changed:
        db.flush()


def file_leads(imp: Import) -> list[str]:
    """The Lead IDs a saved file brought or updated, in its order, once each."""
    ids = [row.get("lead_id") for row in (imp.sheet or {}).get("rows", [])]
    return list(dict.fromkeys(i for i in ids if i))


def files_of(db: Session, batch_id: uuid.UUID) -> list[Import]:
    return list(
        db.scalars(
            select(Import)
            .where(Import.batch_id == batch_id, Import.status == ImportStatus.CONFIRMED)
            .order_by(Import.confirmed_at)
        )
    )


def problems(db: Session, batch_id: uuid.UUID) -> dict[str, list[dict[str, Any]]]:
    """Each of the batch's leads with a problem: Lead ID -> its problems."""
    ensure_checked(db, batch_id)
    rows = db.execute(select(Lead.lead_id, Lead.check).where(Lead.batch_id == batch_id))
    return {lead_id: found for lead_id, found in rows if found}


def held(db: Session, batch_id: uuid.UUID) -> dict[uuid.UUID, int]:
    """The batch's held files: file id -> how many of its leads have an error."""
    wrong = {k for k, v in problems(db, batch_id).items() if check.errors(v)}
    out: dict[uuid.UUID, int] = {}
    if not wrong:
        return out
    for imp in files_of(db, batch_id):
        count = sum(1 for lead_id in file_leads(imp) if lead_id in wrong)
        if count:
            out[imp.id] = count
    return out


def held_leads(db: Session, batch_id: uuid.UUID) -> set[str]:
    """Every lead of the batch's held files: agents leave them alone."""
    files = held(db, batch_id)
    if not files:
        return set()
    out: set[str] = set()
    for imp in files_of(db, batch_id):
        if imp.id in files:
            out.update(file_leads(imp))
    return out


def report(db: Session, imp: Import) -> dict[str, Any]:
    """A file's Lead Check report: held or clear, counts by city, its tabs' column problems
    and every problem of its leads (as they are now)."""
    batch_id = imp.batch_id
    found = problems(db, batch_id) if batch_id else {}
    ids = [i for i in file_leads(imp) if i in found]
    leads = {lead.lead_id: lead for lead in db.scalars(select(Lead).where(Lead.lead_id.in_(ids)))}
    issues = []
    by_city: dict[str, dict[str, int]] = {}
    for lead_id in ids:
        lead = leads.get(lead_id)
        if lead is None or lead.batch_id != batch_id:
            continue
        values = check.lead_values(lead)
        city = by_city.setdefault(lead.city, {"errors": 0, "warnings": 0})
        for item in found[lead_id]:
            kind = "errors" if item["severity"] == "error" else "warnings"
            city[kind] += 1
            issues.append(
                {
                    "lead_id": lead_id,
                    "business_name": lead.business_name,
                    "city": lead.city,
                    "value": values.get(item["field"], ""),
                    "fix": check.fix_for(item["code"], values),
                }
                | item
            )
    tabs = {
        name: tab["columns"]
        for name, tab in (imp.preview or {}).get("check", {}).get("tabs", {}).items()
        if tab.get("columns")
    }
    errors = sum(c["errors"] for c in by_city.values())
    return {
        "import_id": imp.id,
        "file_name": imp.file_name,
        "held": errors > 0,
        "errors": errors,
        "warnings": sum(c["warnings"] for c in by_city.values()),
        "cities": [{"city": k} | v for k, v in sorted(by_city.items(), key=lambda x: x[0].lower())],
        "tabs": tabs,
        "issues": sorted(issues, key=lambda i: (i["severity"] != "error", i["city"], i["lead_id"])),
    }
