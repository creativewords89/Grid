"""`/api/leads`: the Leads screen (SPEC sections 6.4 and 7). Every lead is kept in the Hub:
its row from the lead files and what each agent found. Everyone can look and download an
Excel file; Owners and Admins can change a few fields or delete a lead.
"""

import io
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query
from fastapi.responses import FileResponse, Response
from openpyxl import Workbook
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import Float, Select, String, case, cast, func, or_, select
from sqlalchemy.orm import Session

from app import audit
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.db.models import Agent, Batch, Lead, LeadFile
from app.errors import ApiError
from app.imports import reader
from app.imports.service import sync_do_not_contact
from app.leads import files
from app.permissions import Action, can, ensure

router = APIRouter(tags=["leads"])

PAGE = 100
MAX_EXPORT = 50_000
DATA_COLUMNS = (
    ("Address", "address"),
    ("Website", "website"),
    ("Phone", "phone"),
    ("WhatsApp", "whatsapp"),
    ("Facebook", "facebook"),
    ("Instagram", "instagram"),
    ("Reviews", "reviews"),
    ("Rating", "rating"),
    ("Notes", "notes"),
)


class FileOut(BaseModel):
    id: uuid.UUID
    agent_key: str
    name: str
    content_type: str
    size: int
    created_at: datetime


class LeadOut(BaseModel):
    lead_id: str
    batch_id: uuid.UUID | None
    batch_name: str | None
    niche: str
    city: str
    business_name: str
    level: str
    gbp_link: str
    emails: list[str]
    data: dict[str, str]
    extra: dict[str, str]  # the file's other columns, by their header
    results: dict[str, Any]


class LeadDetail(LeadOut):
    files: list[FileOut]
    can_edit: bool


class LeadPage(BaseModel):
    leads: list[LeadOut]
    total: int
    page: int
    pages: int
    agents: dict[str, str]  # agent key -> the label of its results
    extra_columns: list[str]  # the file's other columns these leads have


def _out(lead: Lead, batches: dict[uuid.UUID, str]) -> LeadOut:
    return LeadOut(
        lead_id=lead.lead_id,
        batch_id=lead.batch_id,
        batch_name=batches.get(lead.batch_id) if lead.batch_id else None,
        niche=lead.niche,
        city=lead.city,
        business_name=lead.business_name,
        level=lead.level,
        gbp_link=lead.gbp_link,
        emails=lead.emails,
        data=lead.data or {},
        extra=lead.extra or {},
        results=lead.results or {},
    )


def _agent_labels(db: Session) -> dict[str, str]:
    labels = {}
    for agent in db.scalars(select(Agent).order_by(Agent.created_at)):
        label = (agent.manifest or {}).get("result_label") or agent.name
        labels[agent.key] = str(label)
    return labels


Sort = Literal["lead_id", "name", "city", "newest", "score", "rating", "reviews"]


def _number(field: str) -> Any:
    """A number from the lead file's text (e.g. "4.7", "1,234"); None when it isn't one."""
    text = func.replace(Lead.data[field].astext, ",", "")
    return case((text.op("~")(r"^[0-9]+(\.[0-9]+)?$"), cast(text, Float)), else_=None)


def _query(
    batch_id: uuid.UUID | None,
    q: str | None,
    city: str | None,
    level: Literal["top", "not_top"] | None,
    website: Literal["yes", "no"] | None,
    sort: Sort,
    score_of: str | None,
) -> Select[Lead]:
    query = select(Lead)
    if batch_id is not None:
        query = query.where(Lead.batch_id == batch_id)
    if q:
        like = f"%{q.strip().lower()}%"
        query = query.where(
            or_(
                func.lower(Lead.business_name).like(like),
                func.lower(Lead.lead_id).like(like),
                func.lower(Lead.city).like(like),
                func.lower(Lead.gbp_link).like(like),
                Lead.website_domain.like(like),
                func.lower(cast(Lead.emails, String)).like(like),
                Lead.phone_digits.like(f"%{reader.phone_digits(q) or q.strip()}%"),
            )
        )
    if city:
        query = query.where(func.lower(Lead.city) == city.strip().lower())
    if level == "top":
        query = query.where(Lead.level == "Top")
    elif level == "not_top":
        query = query.where(Lead.level != "Top")
    if website == "yes":
        query = query.where(Lead.website_domain != "")
    elif website == "no":
        query = query.where(Lead.website_domain == "")
    if sort == "score" and score_of:
        score = Lead.results[score_of]["score"].as_float()
        query = query.order_by(score.desc().nulls_last(), Lead.lead_id)
    elif sort in ("rating", "reviews"):
        query = query.order_by(_number(sort).desc().nulls_last(), Lead.lead_id)
    elif sort == "name":
        query = query.order_by(func.lower(Lead.business_name), Lead.lead_id)
    elif sort == "city":
        query = query.order_by(func.lower(Lead.city), Lead.lead_id)
    elif sort == "newest":
        query = query.order_by(Lead.lead_id.desc())
    else:
        query = query.order_by(Lead.lead_id)
    return query


def _extra_columns(db: Session, query: Select[Lead]) -> list[str]:
    """The headers of the file's other columns that these leads have, A to Z."""
    leads = query.order_by(None).subquery()
    keys = db.scalars(select(func.jsonb_object_keys(leads.c.extra)).distinct())
    return sorted(keys, key=str.lower)


Search = Annotated[str | None, Query(max_length=200)]
City = Annotated[str | None, Query(max_length=120)]
AgentKey = Annotated[str | None, Query(max_length=40)]


@router.get("/leads", response_model=LeadPage)
def list_leads(
    me: CurrentUser,
    db: Db,
    batch_id: uuid.UUID | None = None,
    q: Search = None,
    city: City = None,
    level: Literal["top", "not_top"] | None = None,
    website: Literal["yes", "no"] | None = None,
    sort: Sort = "lead_id",
    score_of: AgentKey = None,
    page: Annotated[int, Query(ge=1, le=100_000)] = 1,
) -> LeadPage:
    """100 leads a page, filtered and sorted (`sort=score&score_of=<agent>`: best first)."""
    ensure(me, Action.VIEW_HUB)
    query = _query(batch_id, q, city, level, website, sort, score_of)
    total = db.scalar(select(func.count()).select_from(query.order_by(None).subquery())) or 0
    found = db.scalars(query.offset((page - 1) * PAGE).limit(PAGE))
    batches = {b.id: b.name for b in db.scalars(select(Batch))}
    return LeadPage(
        leads=[_out(lead, batches) for lead in found],
        total=total,
        page=page,
        pages=max(1, -(-total // PAGE)),
        agents=_agent_labels(db),
        extra_columns=_extra_columns(db, query),
    )


def _cell(value: Any) -> Any:
    """Text stays text in Excel: a value starting with "=" isn't run as a formula."""
    return value if value is None or isinstance(value, int | float) else str(value)


@router.get("/leads/export")
def export_leads(
    me: CurrentUser,
    db: Db,
    batch_id: uuid.UUID | None = None,
    q: Search = None,
    city: City = None,
    level: Literal["top", "not_top"] | None = None,
    website: Literal["yes", "no"] | None = None,
    sort: Sort = "lead_id",
    score_of: AgentKey = None,
) -> Response:
    """The leads on screen (same filters), every column, as an Excel file."""
    ensure(me, Action.VIEW_HUB)
    query = _query(batch_id, q, city, level, website, sort, score_of).limit(MAX_EXPORT)
    batches = {b.id: b.name for b in db.scalars(select(Batch))}
    labels = _agent_labels(db)
    book = Workbook()
    sheet = book.active
    assert sheet is not None
    sheet.title = "Leads"
    header = ["Lead ID", "Batch", "Niche", "City", "Level", "Business Name", "GBP Link", "Email"]
    header += [title for title, _ in DATA_COLUMNS]
    extra_columns = _extra_columns(db, query)
    header += extra_columns
    for label in labels.values():
        header += [f"{label} Status", f"{label} Score", f"{label} Summary", f"{label} Checked"]
    sheet.append(header)
    for lead in db.scalars(query):
        data = lead.data or {}
        line: list[Any] = [
            lead.lead_id,
            batches.get(lead.batch_id, "") if lead.batch_id else "",
            lead.niche,
            lead.city,
            lead.level,
            lead.business_name,
            lead.gbp_link,
            ", ".join(lead.emails),
        ]
        line += [data.get(key, "") for _, key in DATA_COLUMNS]
        line += [(lead.extra or {}).get(name, "") for name in extra_columns]
        for key in labels:
            result = (lead.results or {}).get(key) or {}
            line += [result.get(k) for k in ("status", "score", "summary", "at")]
        sheet.append([_cell(value) for value in line])
        for cell in sheet[sheet.max_row]:
            if isinstance(cell.value, str):
                cell.data_type = "s"
    out = io.BytesIO()
    book.save(out)
    stamp = datetime.now(UTC).strftime("%Y-%m-%d")
    return Response(
        out.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="leads-{stamp}.xlsx"'},
    )


def _get(db: Session, lead_id: str) -> Lead:
    lead = db.get(Lead, lead_id)
    if lead is None:
        raise ApiError(404, "not_found", "That lead doesn't exist.")
    return lead


def _detail(db: Session, me: CurrentUser, lead: Lead) -> LeadDetail:
    batches = {b.id: b.name for b in db.scalars(select(Batch))}
    found = db.scalars(
        select(LeadFile).where(LeadFile.lead_id == lead.lead_id).order_by(LeadFile.created_at)
    )
    return LeadDetail(
        **_out(lead, batches).model_dump(),
        files=[FileOut.model_validate(f, from_attributes=True) for f in found],
        can_edit=can(me, Action.EDIT_LEADS),
    )


@router.get("/leads/{lead_id}", response_model=LeadDetail)
def read_lead(lead_id: str, me: CurrentUser, db: Db) -> LeadDetail:
    ensure(me, Action.VIEW_HUB)
    return _detail(db, me, _get(db, lead_id))


Short = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]


class LeadPatch(Strict):
    email: Annotated[str, StringConstraints(max_length=2000)] | None = None
    phone: Short | None = None
    website: Short | None = None
    notes: Annotated[str, StringConstraints(strip_whitespace=True, max_length=4000)] | None = None


def _view(lead: Lead) -> dict[str, Any]:
    data = lead.data or {}
    return {
        "email": ", ".join(lead.emails),
        "phone": data.get("phone", ""),
        "website": data.get("website", ""),
        "level": lead.level,
        "notes": data.get("notes", ""),
    }


@router.patch("/leads/{lead_id}", response_model=LeadDetail)
def update_lead(lead_id: str, body: LeadPatch, me: CurrentUser, db: Db) -> LeadDetail:
    """Change a lead's email(s), phone, website or notes; an empty value clears a field. Top
    is chosen in a city (`mark_top`), not here; a Top lead keeps its email, phone and GBP
    link on the do-not-contact list."""
    ensure(me, Action.EDIT_LEADS)
    lead = _get(db, lead_id)
    before = _view(lead)
    data = dict(lead.data or {})
    if body.email is not None:
        valid, invalid = reader.split_emails(body.email)
        if invalid:
            message = f"This doesn't look like an email: {invalid[0]}"
            raise ApiError(422, "invalid", message, {"email": message})
        lead.emails = list(dict.fromkeys(valid))
    if body.phone is not None:
        data["phone"] = body.phone
        lead.phone_digits = reader.phone_digits(body.phone)
    if body.website is not None:
        data["website"] = reader.clean_website(body.website)
        lead.website_domain = reader.website_domain(data["website"])[:255] if body.website else ""
    if body.notes is not None:
        data["notes"] = body.notes
    lead.data = {key: value for key, value in data.items() if value}
    changes = audit.diff(before, _view(lead))
    if changes:
        sync_do_not_contact(db, lead)
        audit.record(db, me, "edit", "lead", lead.lead_id, lead.business_name, changes)
    db.commit()
    return _detail(db, me, lead)


class TopIn(Strict):
    batch_id: uuid.UUID
    city: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
    lead_ids: Annotated[list[str], Field(min_length=1, max_length=500)]
    top: bool


@router.post("/leads/top")
def mark_top(body: TopIn, me: CurrentUser, db: Db) -> dict[str, int]:
    """Mark leads of one city of a batch as Top (never audited or contacted) or take Top
    off, many at once (SPEC section 6.4 item 9, step 19). Every lead must be in that city of
    that batch. Top keeps their email, phone and GBP link on the do-not-contact list."""
    ensure(me, Action.EDIT_LEADS)
    level = "Top" if body.top else ""
    wanted = set(body.lead_ids)
    found = list(db.scalars(select(Lead).where(Lead.lead_id.in_(wanted))))
    city = body.city.lower()
    if len(found) != len(wanted) or any(
        lead.batch_id != body.batch_id or lead.city.strip().lower() != city for lead in found
    ):
        raise ApiError(
            422, "invalid", f"Top is chosen in one city: these leads are not all in {body.city}."
        )
    changed = 0
    for lead in found:
        if lead.level != level:
            lead.level = level
            sync_do_not_contact(db, lead)
            changed += 1
    if changed:
        audit.record(
            db,
            me,
            "mark_top" if body.top else "remove_top",
            "lead",
            None,
            f"{changed} leads",
            [{"field": "Top", "from": not body.top, "to": body.top}],
        )
    db.commit()
    return {"changed": changed}


@router.delete("/leads/{lead_id}", status_code=204)
def delete_lead(lead_id: str, me: CurrentUser, db: Db) -> None:
    """Delete a lead and its files. Its do-not-contact entries stay, so a Top business
    imported again later is still never contacted."""
    ensure(me, Action.EDIT_LEADS)
    lead = _get(db, lead_id)
    stored = list(db.scalars(select(LeadFile.id).where(LeadFile.lead_id == lead.lead_id)))
    audit.record(db, me, "delete", "lead", lead.lead_id, lead.business_name, [])
    db.delete(lead)
    db.commit()
    for file_id in stored:
        files.remove(lead_id, file_id)


@router.get("/leads/{lead_id}/files/{file_id}")
def download_file(lead_id: str, file_id: uuid.UUID, me: CurrentUser, db: Db) -> FileResponse:
    """Always a download (never shown in the page), with the type it was saved with."""
    ensure(me, Action.VIEW_HUB)
    row = db.get(LeadFile, file_id)
    if row is None or row.lead_id != lead_id or not files.path_of(lead_id, file_id).exists():
        raise ApiError(404, "not_found", "That file doesn't exist.")
    return FileResponse(
        files.path_of(lead_id, file_id),
        media_type=row.content_type,
        filename=row.name,
        content_disposition_type="attachment",
    )
