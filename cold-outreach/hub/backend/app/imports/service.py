"""Preview and confirm a lead file (SPEC section 6.4). Leads are kept in the Hub.

Preview reads the file, cleans and merges its rows, and matches them against the leads the
Hub already knows. A business stays in the batch it was first imported into: matched in
another batch, it is listed as such and updated there. Nothing is written anywhere but the
import itself. Confirm gives Lead IDs and
saves each lead's row, and updates the lists and the do-not-contact list, in one
transaction.
"""

from dataclasses import dataclass
from typing import Any

from sqlalchemy import delete, func, select, text
from sqlalchemy.orm import Session

from app.auth.tokens import now
from app.db.models import Batch, DoNotContact, Import, ImportStatus, Lead, LeadList, User
from app.errors import ApiError
from app.imports import check, reader

SAMPLE = 25  # how many rows each preview list shows
SMALL_CITY = 10  # a batch's city with fewer businesses is switched off (SPEC 6.4 item 8)
# The parts of a lead's row kept in `Lead.data` (the rest have columns of their own).
DATA_FIELDS = (
    "address",
    "website",
    "phone",
    "whatsapp",
    "facebook",
    "instagram",
    "reviews",
    "rating",
    "notes",
)


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
    return dict(lead.values, emails=lead.emails, rows=lead.rows, extra=lead.extra)


def _merged_values(row: dict[str, Any]) -> dict[str, str]:
    """A business's values after its rows are merged, keyed like check.STANDARD."""
    values = {k: str(row.get(k) or "") for k in check.STANDARD if k != "email"}
    return values | {"email": ", ".join(row.get("emails") or [])}


# The file's columns, in the order the team's files have them (SPEC section 6.4).
SHEET_COLUMNS = (
    ("business_name", "Business name"),
    ("gbp_link", "MAP"),
    ("address", "Address"),
    ("city", "City"),
    ("website", "Website"),
    ("phone", "Phone"),
    ("whatsapp", "WA"),
    ("facebook", "Facebook"),
    ("instagram", "Instagram"),
    ("email", "Email"),
    ("reviews", "Reviews"),
    ("rating", "Average"),
    ("notes", "Notes"),
)


def _sheet(report: reader.Report, rows: list[dict[str, Any]], batch: Batch) -> dict[str, Any]:
    """Every row of the file by tab, and what happens to it."""
    lead_of = {where: index for index, row in enumerate(rows) for where in row["rows"]}
    counts: dict[str, int] = {}
    out = []
    for item in report.sheet:
        where = f"{item.tab} row {item.line}"
        index = lead_of.get(where)
        row = rows[index] if index is not None else None
        # Lead Check on the business as it will be saved: rows of one business are merged
        # first (an empty cell is filled from the other row), and counted once.
        found = [] if row is None else check.check_lead(_merged_values(row))
        first = row is not None and row["rows"][0] == where
        if row is None:
            status = "skipped"
        elif not row["lead_id"]:
            status = "new"
        else:
            status = "updated" if row["batch_id"] == str(batch.id) else "other_batch"
        counts[item.tab] = counts.get(item.tab, 0) + 1
        out.append(
            {
                "tab": item.tab,
                "line": item.line,
                "status": status,
                "merged": bool(row and len(row["rows"]) > 1),
                "top": bool(row and row.get("top")),
                "values": item.values,
                "extra": item.extra,
                "raw": item.raw,
                "bad_emails": item.bad_emails,
                # Lead Check (step 26): what is wrong in this row's business, by column.
                "issues": [i.as_dict() for i in found],
                "counted": first,
            }
        )
    return {
        "tabs": [{"name": name, "rows": counts.get(name, 0)} for name in report.tab_names],
        "extra_columns": report.extra_columns,
        "rows": out,
    }


def preview(
    db: Session,
    user: User,
    file_name: str,
    content: bytes,
    batch: Batch,
    chosen_tops: set[str] | None = None,
) -> Import:
    """`chosen_tops`: the businesses chosen Top in Top Review (step 32), by the first row each is
    on; they are saved as Top."""
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
        row["batch_id"] = str(match.batch_id) if match and match.batch_id else ""
        # Top is chosen in the Hub, or in Top Review before the file came (step 32).
        row["chosen_top"] = row["rows"][0] in (chosen_tops or set())
        row["top"] = bool(match and match.level == "Top") or row["chosen_top"]
        if match is None:
            continue
        label = f"{row['business_name'] or row['gbp_link']} ({match.lead_id}"
        if match.batch_id == batch.id:
            updates.append(f"{label})")
        else:
            other = batch_names.get(match.batch_id) if match.batch_id else None
            elsewhere.append(f"{label}, in {other or 'no batch'})")
    known_lists = {
        x.city.lower() for x in db.scalars(select(LeadList).where(LeadList.batch_id == batch.id))
    }
    cities = sorted({row["city"] for row in rows})
    new_lists = [c for c in cities if c.lower() not in known_lists]

    def names(selected: list[dict[str, Any]]) -> list[str]:
        return [f"{r['business_name'] or r['gbp_link']} ({r['rows'][0]})" for r in selected][
            :SAMPLE
        ]

    no_gbp = [r for r in rows if not r["gbp_link"]]
    no_website = [r for r in rows if not r["website"]]
    tops = [r for r in rows if r["top"]]
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
        sheet=_sheet(report, rows, batch),
    )
    imp.preview = imp.preview | {"check": _preview_check(report, imp.sheet["rows"])}
    db.add(imp)
    return imp


def _preview_check(report: reader.Report, sheet_rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Lead Check on the file before it is saved (step 26): errors and warnings by tab, the
    tabs' column problems, and whether saving it would hold its leads."""
    tabs: dict[str, dict[str, Any]] = {}
    for name in report.tab_names:
        layout = report.tab_columns.get(name)
        columns = (
            check.check_tab(layout["fields"], layout["duplicates"], layout["city_not_tab"])
            if layout
            else []
        )
        tabs[name] = {"errors": 0, "warnings": 0, "columns": [i.as_dict() for i in columns]}
    for row in sheet_rows:
        if not row.get("counted"):
            continue  # a business's other rows: counted on its first row
        tab = tabs.setdefault(row["tab"], {"errors": 0, "warnings": 0, "columns": []})
        for item in row.get("issues", []):
            tab["errors" if item["severity"] == "error" else "warnings"] += 1
    errors = sum(t["errors"] for t in tabs.values())
    warnings = sum(t["warnings"] + len(t["columns"]) for t in tabs.values())
    return {"errors": errors, "warnings": warnings, "tabs": tabs}


# --- confirm --------------------------------------------------------------------------------


def _next_number(db: Session) -> int:
    highest = db.scalar(select(func.max(Lead.lead_id)))
    return int(highest[2:]) + 1 if highest else 1


def _apply(db: Session, imp: Import, row: dict[str, Any], lead: Lead | None, number: int) -> Lead:
    values = {k: v for k, v in row.items() if isinstance(v, str)}
    values.pop("lead_id", None)
    values.pop("batch_id", None)
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
    lead.emails = list(dict.fromkeys([*lead.emails, *row.get("emails", [])]))
    # A value from the file replaces the saved one; an empty cell never blanks it.
    lead.data = dict(lead.data or {}) | {f: values[f] for f in DATA_FIELDS if values.get(f)}
    lead.extra = dict(lead.extra or {}) | {k: v for k, v in row.get("extra", {}).items() if v}
    lead.last_import_id = imp.id
    recheck(lead)
    return lead


def recheck(lead: Lead) -> None:
    """Lead Check on the lead's current values (step 26), after a file or an edit."""
    lead.check = [i.as_dict() for i in check.check_lead(check.lead_values(lead))]


def sync_do_not_contact(db: Session, lead: Lead) -> None:
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
    # One import at a time: Lead IDs are numbered from the highest one saved.
    db.execute(text("SELECT pg_advisory_xact_lock(4242001)"))
    registry = Registry.load(db)
    number = _next_number(db)
    added = updated = 0
    lead_of: dict[str, str] = {}
    for row in imp.rows:
        match = registry.match(row)
        lead = _apply(db, imp, row, match, number)
        if row.get("chosen_top"):
            lead.level = "Top"
        for where in row["rows"]:
            lead_of[where] = lead.lead_id
        if match is None:
            number += 1
            added += 1
            registry.add(lead)
        else:
            updated += 1
        if match is not None or lead.level == "Top":
            sync_do_not_contact(db, lead)
    for city in sorted({row["city"] for row in imp.rows}):
        exists = db.scalar(
            select(LeadList).where(
                LeadList.batch_id == imp.batch_id, func.lower(LeadList.city) == city.lower()
            )
        )
        if exists is None and imp.batch_id is not None:
            db.add(LeadList(batch_id=imp.batch_id, city=city, niche=imp.niche))
    db.flush()
    if imp.batch_id is not None:
        mute_small_cities(db, imp.batch_id)
    imp.status = ImportStatus.CONFIRMED
    imp.confirmed_at = now()
    imp.counts = dict(imp.counts, saved_new=added, saved_updated=updated)
    imp.rows = []  # the leads have them now
    # Keep where each row went; its values are the lead's from now on.
    sheet = dict(imp.sheet or {})
    sheet["rows"] = [
        {key: item[key] for key in ("tab", "line", "status", "merged", "top")}
        | {"lead_id": lead_of.get(f"{item['tab']} row {item['line']}")}
        for item in sheet.get("rows", [])
    ]
    imp.sheet = sheet
    return imp


def sync_cities(db: Session, batch_id: Any) -> None:
    """After a lead moved to another city: the batch has a city for each city of its leads
    and none without leads; then the small-city rule (step 27)."""
    used = {
        city.lower(): city
        for city in db.scalars(select(Lead.city).where(Lead.batch_id == batch_id).distinct())
    }
    batch = db.get(Batch, batch_id)
    have = set()
    for item in db.scalars(select(LeadList).where(LeadList.batch_id == batch_id)):
        if item.city.lower() in used:
            have.add(item.city.lower())
        else:
            db.delete(item)
    for key, city in used.items():
        if key not in have and batch is not None:
            db.add(LeadList(batch_id=batch_id, city=city, niche=batch.niche))
    db.flush()
    mute_small_cities(db, batch_id)


def mute_small_cities(db: Session, batch_id: Any) -> None:
    """Cities with fewer than SMALL_CITY businesses in the batch are off, the others on,
    except those a person switched by hand."""
    counts = {
        city.lower(): total
        for city, total in db.execute(
            select(Lead.city, func.count()).where(Lead.batch_id == batch_id).group_by(Lead.city)
        )
    }
    for item in db.scalars(
        select(LeadList).where(LeadList.batch_id == batch_id, LeadList.set_by_hand.is_(False))
    ):
        item.active = counts.get(item.city.lower(), 0) >= SMALL_CITY


def discard(imp: Import) -> None:
    if imp.status != ImportStatus.PREVIEW:
        raise ApiError(409, "not_preview", f"This import is {imp.status.value}.")
    imp.status = ImportStatus.DISCARDED
    imp.rows = []
    imp.sheet = {}


# --- the file tab by tab ------------------------------------------------------------------

SHEET_PAGE = 100
STATUSES = ("new", "updated", "other_batch", "merged", "top", "skipped")


def _lead_values(lead: Lead) -> dict[str, str]:
    data = lead.data or {}
    values = {
        "business_name": lead.business_name,
        "gbp_link": lead.gbp_link,
        "city": lead.city,
        "level": lead.level,
        "email": ", ".join(lead.emails),
        **{f: data.get(f, "") for f in DATA_FIELDS},
    }
    return {k: v for k, v in values.items() if v}


def sheet_page(
    db: Session, imp: Import, tab: str | None, status: str | None, page: int
) -> dict[str, Any]:
    """One page of the file's rows, tab by tab. A waiting file shows its own cleaned
    values; a saved file shows each lead as the Hub has it now."""
    sheet = imp.sheet or {}
    rows = list(sheet.get("rows", []))
    by_tab: dict[str, int] = {}
    by_status = dict.fromkeys(STATUSES, 0)
    for row in rows:
        by_tab[row["tab"]] = by_tab.get(row["tab"], 0) + 1
    shown = [r for r in rows if not tab or r["tab"] == tab]
    for row in shown:
        by_status[row["status"]] += 1
        by_status["merged"] += row["merged"]
        by_status["top"] += row["top"]
    if status in ("merged", "top"):
        shown = [r for r in shown if r[status]]
    elif status:
        shown = [r for r in shown if r["status"] == status]
    pages = max(1, -(-len(shown) // SHEET_PAGE))
    chosen = [dict(r) for r in shown[(page - 1) * SHEET_PAGE : page * SHEET_PAGE]]
    if imp.status == ImportStatus.CONFIRMED:
        ids = [r["lead_id"] for r in chosen if r.get("lead_id")]
        found = {x.lead_id: x for x in db.scalars(select(Lead).where(Lead.lead_id.in_(ids)))}
        for row in chosen:
            lead = found.get(row.get("lead_id") or "")
            row["values"] = _lead_values(lead) if lead else {}
            row["extra"] = dict(lead.extra or {}) if lead else {}
            row["raw"], row["bad_emails"] = {}, []
            row["deleted"] = bool(row.get("lead_id")) and lead is None
    extra_columns = list(sheet.get("extra_columns", []))
    for row in chosen:
        extra_columns += [k for k in row.get("extra", {}) if k not in extra_columns]
    return {
        "kept": bool(sheet.get("rows")),
        "tabs": [
            {"name": t["name"], "rows": by_tab.get(t["name"], 0)} for t in sheet.get("tabs", [])
        ],
        "columns": [{"key": k, "label": label} for k, label in SHEET_COLUMNS]
        + [{"key": f"extra:{name}", "label": name} for name in extra_columns],
        "statuses": by_status,
        "rows": chosen,
        "total": len(shown),
        "page": page,
        "pages": pages,
    }
