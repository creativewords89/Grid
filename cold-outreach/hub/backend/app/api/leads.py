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
from pydantic import BaseModel, StringConstraints
from sqlalchemy import Select, String, cast, func, or_, select
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
        results=lead.results or {},
    )


def _agent_labels(db: Session) -> dict[str, str]:
    labels = {}
    for agent in db.scalars(select(Agent).order_by(Agent.created_at)):
        label = (agent.manifest or {}).get("result_label") or agent.name
        labels[agent.key] = str(label)
    return labels


Sort = Literal["lead_id", "name", "city", "newest", "score"]


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
    elif sort == "name":
        query = query.order_by(func.lower(Lead.business_name), Lead.lead_id)
    elif sort == "city":
        query = query.order_by(func.lower(Lead.city), Lead.lead_id)
    elif sort == "newest":
        query = query.order_by(Lead.lead_id.desc())
    else:
        query = query.order_by(Lead.lead_id)
    return query


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
    level: Literal["Top", ""] | None = None
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
    """Change a lead's email(s), phone, website, Top mark or notes. Top keeps its email,
    phone and GBP link on the do-not-contact list; an empty value clears a field."""
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
    if body.level is not None:
        lead.level = body.level
    lead.data = {key: value for key, value in data.items() if value}
    changes = audit.diff(before, _view(lead))
    if changes:
        sync_do_not_contact(db, lead)
        audit.record(db, me, "edit", "lead", lead.lead_id, lead.business_name, changes)
    db.commit()
    return _detail(db, me, lead)


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
