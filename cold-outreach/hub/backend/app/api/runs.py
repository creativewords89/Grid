"""`/api/runs`, `/api/overview` and `/api/budget`: the Runs and Overview screens
(SPEC sections 6.3 and 7)."""

from datetime import datetime
from decimal import Decimal
from typing import Annotated
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app import audit, settings_store
from app.api.agents import AgentOut, RunOut, _out, _valid_zone
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.auth.tokens import now
from app.db.models import Agent, Run, RunStatus
from app.errors import ApiError
from app.permissions import Action, can, ensure
from app.runs import schedule
from app.runs import service as runs

router = APIRouter(tags=["runs"])

PAGE = 50


class RunPage(BaseModel):
    runs: list[RunOut]
    more: bool


@router.get("/runs", response_model=RunPage)
def list_runs(
    me: CurrentUser,
    db: Db,
    agent: Annotated[str | None, Query(max_length=40)] = None,
    status: RunStatus | None = None,
    before: datetime | None = None,
) -> RunPage:
    """Newest first, 50 at a time; `before` is the oldest `queued_at` already shown."""
    ensure(me, Action.VIEW_HUB)
    query = (
        select(Run)
        .options(selectinload(Run.agent), selectinload(Run.requester))
        .order_by(Run.queued_at.desc(), Run.id.desc())
        .limit(PAGE + 1)
    )
    if agent:
        query = query.join(Agent).where(Agent.key == agent)
    if status:
        query = query.where(Run.status == status)
    if before:
        query = query.where(Run.queued_at < before)
    found = db.scalars(query).all()
    return RunPage(runs=[RunOut.of(run) for run in found[:PAGE]], more=len(found) > PAGE)


class BudgetOut(BaseModel):
    daily_total_budget_usd: Decimal
    time_zone: str
    spent_today_usd: Decimal
    spent_this_month_usd: Decimal
    can_change: bool


class OverviewOut(BudgetOut):
    agents: list[AgentOut]


def _budget(db: Db, me: CurrentUser) -> BudgetOut:
    zone = runs.hub_zone(db)
    today = now().astimezone(ZoneInfo(zone)).date()
    month_start, _ = schedule.day_bounds(today.replace(day=1), zone)
    month_spent = db.scalar(
        select(func.coalesce(func.sum(Run.cost_usd), 0)).where(Run.queued_at >= month_start)
    )
    return BudgetOut(
        daily_total_budget_usd=runs.total_budget(db),
        time_zone=zone,
        spent_today_usd=runs.total_spent_today(db),
        spent_this_month_usd=Decimal(str(month_spent or 0)),
        can_change=can(me, Action.MANAGE_TOTAL_BUDGET),
    )


@router.get("/overview", response_model=OverviewOut)
def overview(me: CurrentUser, db: Db) -> OverviewOut:
    ensure(me, Action.VIEW_HUB)
    agents = db.scalars(select(Agent).order_by(Agent.created_at)).all()
    return OverviewOut(**_budget(db, me).model_dump(), agents=[_out(db, agent) for agent in agents])


class BudgetIn(Strict):
    daily_total_budget_usd: Annotated[Decimal, Field(ge=0, le=100_000, decimal_places=2)]
    time_zone: str


@router.put("/budget", response_model=BudgetOut)
def set_budget(body: BudgetIn, me: CurrentUser, db: Db) -> BudgetOut:
    ensure(me, Action.MANAGE_TOTAL_BUDGET)
    if not _valid_zone(body.time_zone):
        message = "Pick a time zone from the list."
        raise ApiError(422, "invalid", message, {"time_zone": message})
    before = {
        "daily_total_budget_usd": str(runs.total_budget(db)),
        "time_zone": runs.hub_zone(db),
    }
    after = {
        "daily_total_budget_usd": str(body.daily_total_budget_usd),
        "time_zone": body.time_zone,
    }
    settings_store.put(db, "daily_total_budget_usd", after["daily_total_budget_usd"])
    settings_store.put(db, "time_zone", body.time_zone)
    changes = audit.diff(before, after)
    if changes:
        audit.record(db, me, "edit", "budget", None, "Total daily budget", changes)
    db.commit()
    return _budget(db, me)
