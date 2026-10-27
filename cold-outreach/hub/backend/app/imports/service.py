"""Preview and confirm a lead file (SPEC section 6.4).

Preview reads the file, cleans and merges its rows, and matches them against the leads the
Hub already knows. A business stays in the batch it was first imported into: matched in
another batch, it is listed as such and updated there. Nothing is written anywhere but the
import itself. Confirm gives Lead IDs,
updates the registry, lists and do-not-contact list, and writes the Master Sheet; if the
Sheet can't be written, nothing is saved, so the same IDs are used on the next try.
"""

from dataclasses import dataclass
from typing import Any

from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session

from app import connections, providers
from app.auth.tokens import now
from app.db.models import Batch, DoNotContact, Import, ImportStatus, Lead, LeadList, User
from app.errors import ApiError
from app.imports import reader, sheet

SAMPLE = 25  # how many rows each preview list shows


def _registry_keys(lead: Lead) -> dict[str, str]:
    return {
        "gbp_link": lead.gbp_link,
        "phone": lead.phone_digits,
        "name_address": lead.name_address,
    }


@dataclass
class Registry:
    """The known leads, indexed for matching."""

    by_gbp: dict[str, Lead]
    by_phone: dict[str, list[Lead]]
    by_name: dict[str, list[Lead]]

    @classmethod
    def load(cls, db: Session) -> "Registry":
        registry = cls({}, {}, {})
        for lead in db.scalars(select(Lead)):
            registry.add(lead)
        return registry

    def add(self, lead: Lead) -> None:
        if lead.gbp_link:
            self.by_gbp[lead.gbp_link] = lead
        if lead.phone_digits:
            self.by_phone.setdefault(lead.phone_digits, []).append(lead)
        if lead.name_address:
            self.by_name.setdefault(lead.name_address, []).append(lead)

    def match(self, values: dict[str, str]) -> Lead | None:
        """The same rule as within a file: GBP link, else phone or name + address unless
        both have different GBP links."""
        link = values.get("gbp_link", "")
        if link and link in self.by_gbp:
            return self.by_gbp[link]
        candidates = self.by_phone.get(reader.phone_digits(values.get("phone", "")), []) + (
            self.by_name.get(reader.name_place(values), [])
        )
        for lead in candidates:
            if not (link and lead.gbp_link and link != lead.gbp_link):
                return lead
        return None


def _lead_row(lead: reader.Lead) -> dict[str, Any]:
    return dict(lead.values, emails=lead.emails, rows=lead.rows)


def preview(db: Session, user: User, file_name: str, content: bytes, batch: Batch) -> Import:
    niche = batch.niche
    try:
        report = reader.read(content, niche)
    except reader.ReadError as error:
        raise ApiError(422, "unreadable", str(error), {"file": str(error)}) from None
    registry = Registry.load(db)
    batch_names = {b.id: b.name for b in db.scalars(select(Batch))}
    rows = [_lead_row(lead) for lead in report.leads]
    updates = []
    elsewhere = []
    for row in rows:
        match = registry.match(row)
        row["lead_id"] = match.lead_id if match else ""
        if match is None:
            continue
        label = f"{row['business_name'] or row['gbp_link']} ({match.lead_id}"
        if match.batch_id == batch.id:
            updates.append(f"{label})")
        else:
            other = batch_names.get(match.batch_id) if match.batch_id else None
            elsewhere.append(f"{label}, in {other or 'no batch'})")
    known_lists = {(x.city.lower(), x.niche.lower()) for x in db.scalars(select(LeadList))}
    cities = sorted({row["city"] for row in rows})
    new_lists = [c for c in cities if (c.lower(), niche.lower()) not in known_lists]

    def names(selected: list[dict[str, Any]]) -> list[str]:
        return [f"{r['business_name'] or r['gbp_link']} ({r['rows'][0]})" for r in selected][
            :SAMPLE
        ]

    no_gbp = [r for r in rows if not r["gbp_link"]]
    no_website = [r for r in rows if not r["website"]]
    tops = [r for r in rows if r["level"] == "Top"]
    counts = {
        "tabs": report.tabs,
        "leads": len(rows),
        "new": len(rows) - len(updates) - len(elsewhere),
        "updated": len(updates),
        "other_batch": len(elsewhere),
        "merged": len(report.merged_rows),
        "top": len(tops),
        "no_gbp_link": len(no_gbp),
        "no_website": len(no_website),
        "skipped_rows": len(report.skipped_rows),
        "invalid_emails": len(report.invalid_emails),
        "cities": len(cities),
        "new_lists": len(new_lists),
    }
    imp = Import(
        file_name=file_name[:255],
        niche=niche,
        batch_id=batch.id,
        uploaded_by=user.id,
        status=ImportStatus.PREVIEW,
        counts=counts,
        preview={
            "has_level_column": report.has_level_column,
            "empty_tabs": report.empty_tabs,
            "unknown_columns": report.unknown_columns,
            "skipped_rows": report.skipped_rows[:SAMPLE],
            "invalid_emails": report.invalid_emails[:SAMPLE],
            "merged_rows": report.merged_rows[:SAMPLE],
            "updated": updates[:SAMPLE],
            "other_batch": elsewhere[:SAMPLE],
            "no_gbp_link": names(no_gbp),
            "top": names(tops),
            "new_lists": new_lists,
        },
        rows=rows,
    )
    db.add(imp)
    return imp


# --- confirm --------------------------------------------------------------------------------


def google_sheet() -> sheet.Sheet:
    values = connections.current()
    if not connections.ready(values, "google"):
        raise ApiError(
            409, "no_google", "Set up Google (Sheets and Drive) on the Connections screen first."
        )
    token = providers.google_token(values["google_service_account"])
    return sheet.Sheet(token, connections.sheet_id(values["google_sheet_url"]) or "")


def _next_number(db: Session) -> int:
    highest = db.scalar(select(func.max(Lead.lead_id)))
    return int(highest[2:]) + 1 if highest else 1


def _apply(db: Session, imp: Import, row: dict[str, Any], lead: Lead | None, number: int) -> Lead:
    values = {k: v for k, v in row.items() if isinstance(v, str)}
    if lead is None:
        lead = Lead(
            lead_id=f"L-{number:06d}",
            batch_id=imp.batch_id,
            niche=imp.niche,
            city=values["city"][:120],
            business_name=values.get("business_name", "")[:255],
            level="",
            gbp_link="",
            phone_digits="",
            name_address="",
            website_domain="",
            emails=[],
            first_import_id=imp.id,
        )
        db.add(lead)
    if values.get("gbp_link"):
        lead.gbp_link = values["gbp_link"][:500]
    if reader.phone_digits(values.get("phone", "")):
        lead.phone_digits = reader.phone_digits(values["phone"])
    if reader.name_place(values):
        lead.name_address = reader.name_place(values)[:600]
    if values.get("website"):
        lead.website_domain = reader.website_domain(values["website"])[:255]
    if values.get("business_name"):
        lead.business_name = values["business_name"][:255]
    if imp.preview.get("has_level_column"):
        lead.level = values.get("level", "")
    lead.emails = list(dict.fromkeys([*lead.emails, *row.get("emails", [])]))
    lead.last_import_id = imp.id
    return lead


def _do_not_contact(db: Session, lead: Lead) -> None:
    """Top leads' email, phone and GBP link are never contacted (PLAN.md section 3.4)."""
    db.execute(
        delete(DoNotContact).where(
            DoNotContact.lead_id == lead.lead_id, DoNotContact.reason == "top"
        )
    )
    if lead.level != "Top":
        return
    entries = [("gbp", lead.gbp_link), ("phone", lead.phone_digits)]
    entries += [("email", email) for email in lead.emails]
    for kind, value in entries:
        if value:
            db.add(DoNotContact(kind=kind, value=value, reason="top", lead_id=lead.lead_id))


def confirm(db: Session, imp: Import, user: User) -> Import:
    if imp.status != ImportStatus.PREVIEW:
        raise ApiError(409, "not_preview", f"This import is {imp.status.value}.")
    target = google_sheet()
    # One import at a time: Lead IDs are numbered from the highest one saved.
    db.execute(text("SELECT pg_advisory_xact_lock(4242001)"))
    registry = Registry.load(db)
    batch_names = {b.id: b.name for b in db.scalars(select(Batch))}
    number = _next_number(db)
    written: list[dict[str, str]] = []
    for row in imp.rows:
        match = registry.match(row)
        lead = _apply(db, imp, row, match, number)
        if match is None:
            number += 1
            registry.add(lead)
        if match is not None or lead.level == "Top":
            _do_not_contact(db, lead)
        values = {k: v for k, v in row.items() if isinstance(v, str)}
        values["lead_id"] = lead.lead_id
        values["niche"] = lead.niche  # a business found in another batch stays there
        values["batch"] = batch_names.get(lead.batch_id, "") if lead.batch_id else ""
        values["email"] = ", ".join(lead.emails)
        written.append(values)
    for city in sorted({row["city"] for row in imp.rows}):
        exists = db.scalar(
            select(LeadList).where(
                func.lower(LeadList.city) == city.lower(),
                func.lower(LeadList.niche) == imp.niche.lower(),
            )
        )
        if exists is None:
            db.add(LeadList(city=city, niche=imp.niche))
    try:
        added, updated = sheet.write_leads(
            target, written, write_level=bool(imp.preview.get("has_level_column"))
        )
    except providers.ProviderError as error:
        db.rollback()
        raise ApiError(502, "sheet_failed", f"{error} Nothing was saved; try again.") from None
    imp.status = ImportStatus.CONFIRMED
    imp.confirmed_at = now()
    imp.counts = dict(imp.counts, sheet_added=added, sheet_updated=updated)
    imp.rows = []  # the Sheet and the registry have them now
    return imp


def discard(imp: Import) -> None:
    if imp.status != ImportStatus.PREVIEW:
        raise ApiError(409, "not_preview", f"This import is {imp.status.value}.")
    imp.status = ImportStatus.DISCARDED
    imp.rows = []
