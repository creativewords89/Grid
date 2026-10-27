"""`/api/agent/v1`: what agents call (SPEC section 6.2). An agent signs in with its token
(`Authorization: Bearer …`) and can only see and change its own runs."""

import uuid
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Request, Response, status
from pydantic import BaseModel, Field, StringConstraints, ValidationError
from sqlalchemy import func, or_, select

from app.agents import service
from app.agents.manifest import Manifest
from app.api.schemas import Strict
from app.auth.deps import Db
from app.auth.tokens import now
from app.benchmarks.standard import version_label
from app.db.models import (
    Agent,
    DoNotContact,
    GbpBenchmark,
    LeadList,
    Run,
    RunStatus,
    WebsiteStandard,
)
from app.errors import ApiError
from app.imports.reader import phone_digits
from app.runs import service as runs

router = APIRouter(prefix="/agent/v1", tags=["agent api"])


def current_agent(request: Request, db: Db) -> Agent:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    agent = service.find_by_token(db, token.strip()) if scheme.lower() == "bearer" else None
    if agent is None:
        raise ApiError(401, "bad_token", "Unknown agent token.")
    agent.last_seen_at = now()
    return agent


CurrentAgent = Annotated[Agent, Depends(current_agent)]


@router.put("/manifest")
def put_manifest(body: dict[str, Any], agent: CurrentAgent, db: Db) -> dict[str, Any]:
    try:
        manifest = Manifest.model_validate(body)
    except ValidationError as error:
        first = error.errors()[0]
        where = ".".join(str(part) for part in first.get("loc", ()))
        raise ApiError(
            422, "bad_manifest", f"Manifest: {where} {first.get('msg')}".strip()
        ) from None
    agent.manifest = manifest.model_dump(mode="json")
    db.commit()
    return {"ok": True, "config": service.config_of(agent)}


class RunOut(BaseModel):
    run_id: str
    trigger: str
    config: dict[str, Any]
    daily_limit: int
    # What is left today: items under the daily limit, and money under both budgets.
    items_left: int
    budget_left_usd: Decimal
    connections: dict[str, dict[str, str]]


@router.get("/next-run", response_model=RunOut, responses={204: {"description": "Nothing to do"}})
def next_run(agent: CurrentAgent, db: Db, response: Response) -> RunOut | Response:
    if agent.manifest is None:
        raise ApiError(409, "no_manifest", "Send the manifest first (PUT /api/agent/v1/manifest).")
    run = service.start_next(db, agent)
    if run is not None:
        budget = runs.budget(db, agent)
        reason = budget.stop_reason(runs.cost_per_item(agent))
        if reason:  # nothing can be spent today: the run ends before it starts
            run.status = RunStatus.STOPPED
            run.stop_reason = reason
            run.finished_at = now()
            run = None
    db.commit()
    if run is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    return RunOut(
        run_id=str(run.id),
        trigger=run.trigger.value,
        config=service.config_of(agent),
        daily_limit=agent.daily_limit,
        items_left=max(0, agent.daily_limit - runs.items_today(db, agent)),
        budget_left_usd=budget.left,
        connections=service.run_connections(agent),
    )


Count = Annotated[int, Field(ge=0, le=10_000_000)]
Cost = Annotated[Decimal, Field(ge=0, le=100_000, max_digits=12, decimal_places=4)]


class ProgressIn(Strict):
    done: Count = 0
    failed: Count = 0
    skipped: Count = 0
    cost_usd: Cost = Decimal("0")


class ProgressOut(BaseModel):
    action: Literal["continue", "stop"]
    reason: str | None = None


class FinishIn(ProgressIn):
    status: Literal["succeeded", "failed", "stopped"]
    stop_reason: Annotated[str, StringConstraints(max_length=255)] | None = None
    summary: dict[str, Any] = Field(default_factory=dict)


def _own_running_run(db: Db, agent: Agent, run_id: str) -> Run:
    try:
        run = db.get(Run, uuid.UUID(run_id))
    except ValueError:
        run = None
    if run is None or run.agent_id != agent.id:
        raise ApiError(404, "not_found", "That run doesn't exist.")
    if run.status != RunStatus.RUNNING:
        raise ApiError(409, "not_running", f"That run is {run.status.value}.")
    return run


def _record(run: Run, body: ProgressIn) -> None:
    run.done, run.failed, run.skipped = body.done, body.failed, body.skipped
    run.cost_usd = body.cost_usd
    run.heartbeat_at = now()


@router.post("/runs/{run_id}/progress", response_model=ProgressOut)
def progress(run_id: str, body: ProgressIn, agent: CurrentAgent, db: Db) -> ProgressOut:
    run = _own_running_run(db, agent, run_id)
    _record(run, body)
    db.commit()
    if run.stop_requested_at is not None:
        return ProgressOut(action="stop", reason=runs.stop_message(run))
    if not agent.enabled:
        return ProgressOut(action="stop", reason="The agent was switched off in the Hub.")
    reason = runs.budget(db, agent).stop_reason(runs.cost_per_item(agent))
    if reason:
        return ProgressOut(action="stop", reason=reason)
    return ProgressOut(action="continue")


@router.post("/runs/{run_id}/finish", status_code=status.HTTP_204_NO_CONTENT)
def finish(run_id: str, body: FinishIn, agent: CurrentAgent, db: Db) -> None:
    run = _own_running_run(db, agent, run_id)
    _record(run, body)
    run.status = RunStatus(body.status)
    run.stop_reason = body.stop_reason
    run.summary = body.summary
    run.finished_at = now()
    db.commit()


# --- reference data the audits and outreach need (SPEC section 6.2) -------------------------


@router.get("/lists")
def lists(agent: CurrentAgent, db: Db) -> list[dict[str, Any]]:
    """Every City + Niche list; agents leave the leads of inactive lists alone."""
    db.commit()  # records last_seen_at
    return [
        {"city": x.city, "niche": x.niche, "active": x.active, "daily_limit": x.daily_limit}
        for x in db.scalars(select(LeadList).order_by(LeadList.niche, LeadList.city))
    ]


@router.get("/benchmarks")
def benchmarks(
    agent: CurrentAgent,
    db: Db,
    niche: Annotated[str | None, Query(max_length=80)] = None,
    city: Annotated[str | None, Query(max_length=120)] = None,
) -> list[dict[str, Any]]:
    db.commit()
    query = select(GbpBenchmark).order_by(GbpBenchmark.niche, GbpBenchmark.city)
    if niche:
        query = query.where(func.lower(GbpBenchmark.niche) == niche.lower())
    if city:
        query = query.where(func.lower(GbpBenchmark.city) == city.lower())
    out = []
    for row in db.scalars(query):
        out.append(
            {
                "city": row.city,
                "niche": row.niche,
                "reference_businesses": row.reference_businesses,
                **{
                    name: (None if getattr(row, name) is None else float(getattr(row, name)))
                    for name in (
                        "additional_categories",
                        "services",
                        "photos",
                        "posts_90_days",
                        "description_length",
                        "reviews",
                        "rating",
                        "review_reply_pct",
                    )
                },
            }
        )
    return out


@router.get("/website-standards/{niche}")
def website_standard(niche: str, agent: CurrentAgent, db: Db) -> dict[str, Any]:
    """The niche's latest locked Website Standard; 404 means NO_STANDARD."""
    db.commit()
    row = db.scalar(
        select(WebsiteStandard)
        .where(
            func.lower(WebsiteStandard.niche) == niche.lower(),
            WebsiteStandard.version.is_not(None),
        )
        .order_by(WebsiteStandard.version.desc())
        .limit(1)
    )
    if row is None or row.version is None:
        raise ApiError(404, "no_standard", f"No locked Website Standard for {niche}.")
    return {
        "niche": row.niche,
        "version": row.version,
        "label": version_label(row.niche, row.version),
        "standard": row.standard,
    }


@router.get("/do-not-contact/check")
def do_not_contact(
    agent: CurrentAgent,
    db: Db,
    email: Annotated[list[str] | None, Query()] = None,
    phone: Annotated[str | None, Query(max_length=40)] = None,
    gbp: Annotated[str | None, Query(max_length=500)] = None,
    domain: Annotated[str | None, Query(max_length=255)] = None,
) -> dict[str, Any]:
    """Whether any of these may never be contacted, and why."""
    db.commit()
    wanted = [("email", e.strip().lower()) for e in (email or []) if e.strip()]
    if phone and phone_digits(phone):
        wanted.append(("phone", phone_digits(phone)))
    if gbp:
        wanted.append(("gbp", gbp.strip().rstrip("/")))
    if domain:
        wanted.append(("domain", domain.strip().lower().removeprefix("www.")))
    if not wanted:
        return {"blocked": False, "matches": []}
    found = db.scalars(
        select(DoNotContact).where(
            or_(*[(DoNotContact.kind == k) & (DoNotContact.value == v) for k, v in wanted])
        )
    ).all()
    matches = [{"kind": d.kind, "value": d.value, "reason": d.reason} for d in found]
    return {"blocked": bool(matches), "matches": matches}
