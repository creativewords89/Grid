"""`/api/agents`: the Agents screen (SPEC sections 6.2 and 7).

Everyone sees the agents. Owners and Admins switch them on and off, run them and change
their settings. Only Owners add an agent or replace its token; a token is shown once.
"""

import uuid
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Annotated, Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones

from fastapi import APIRouter
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit, connections
from app.agents import service
from app.agents.manifest import AGENT_KEY, RUN_TIME, check_value
from app.api.schemas import Name, Strict
from app.auth.deps import CurrentUser, Db
from app.auth.tokens import hash_secret, now
from app.db.models import Agent, Batch, Run, RunTrigger
from app.errors import ApiError
from app.permissions import Action, ensure
from app.runs import service as runs

router = APIRouter(prefix="/agents", tags=["agents"])

# An agent polls every 30 s; after 2 minutes of silence the screen says it's not connected.
CONNECTED_WITHIN = timedelta(minutes=2)


class RunOut(BaseModel):
    id: uuid.UUID
    trigger: str
    status: str
    queued_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    done: int
    failed: int
    skipped: int
    cost_usd: Decimal
    stop_reason: str | None
    requested_by: str | None
    stop_requested: bool
    agent_key: str
    agent_name: str

    @classmethod
    def of(cls, run: Run) -> "RunOut":
        return cls(
            id=run.id,
            trigger=run.trigger.value,
            status=run.status.value,
            queued_at=run.queued_at,
            started_at=run.started_at,
            finished_at=run.finished_at,
            done=run.done,
            failed=run.failed,
            skipped=run.skipped,
            cost_usd=run.cost_usd,
            stop_reason=run.stop_reason,
            requested_by=run.requester.name if run.requester else None,
            stop_requested=run.stop_requested_at is not None,
            agent_key=run.agent.key,
            agent_name=run.agent.name,
        )


class BatchRef(BaseModel):
    id: uuid.UUID
    name: str
    ready: bool  # has a benchmark: agents skip a batch without one


class AgentOut(BaseModel):
    key: str
    name: str
    enabled: bool
    connected: bool
    last_seen_at: datetime | None
    manifest: dict[str, Any] | None
    config: dict[str, Any]
    daily_limit: int
    run_time: str
    time_zone: str
    daily_budget_usd: Decimal
    batches: list[BatchRef]  # in the order it works through them
    missing_connections: list[str]
    last_run: RunOut | None
    next_run_at: datetime | None
    spent_today_usd: Decimal


def _out(db: Session, agent: Agent) -> AgentOut:
    seen = agent.last_seen_at
    last = service.last_run(db, agent)
    return AgentOut(
        key=agent.key,
        name=agent.name,
        enabled=agent.enabled,
        connected=bool(seen and now() - seen < CONNECTED_WITHIN),
        last_seen_at=seen,
        manifest=agent.manifest,
        config=service.config_of(agent),
        daily_limit=agent.daily_limit,
        run_time=agent.run_time,
        time_zone=agent.time_zone,
        daily_budget_usd=agent.daily_budget_usd,
        batches=[
            BatchRef(id=b.id, name=b.name, ready=b.benchmark_id is not None)
            for b in service.batches_of(db, agent)
        ],
        missing_connections=service.missing_connections(agent, connections.current()),
        last_run=RunOut.of(last) if last else None,
        next_run_at=runs.next_run_at(db, agent),
        spent_today_usd=runs.spent_today(db, agent),
    )


def _get(db: Session, key: str) -> Agent:
    agent = db.scalar(select(Agent).where(Agent.key == key))
    if agent is None:
        raise ApiError(404, "not_found", "That agent doesn't exist.")
    return agent


@router.get("", response_model=list[AgentOut])
def list_agents(me: CurrentUser, db: Db) -> list[AgentOut]:
    ensure(me, Action.VIEW_HUB)
    agents = db.scalars(select(Agent).order_by(Agent.created_at)).all()
    return [_out(db, agent) for agent in agents]


Key = Annotated[str, StringConstraints(strip_whitespace=True, to_lower=True, max_length=40)]


class AgentIn(Strict):
    key: Key
    name: Name


class TokenOut(BaseModel):
    agent: AgentOut
    token: str  # shown once


@router.post("", response_model=TokenOut, status_code=201)
def add_agent(body: AgentIn, me: CurrentUser, db: Db) -> TokenOut:
    ensure(me, Action.MANAGE_AGENT_TOKENS)
    if not AGENT_KEY.match(body.key):
        message = "Use 2–40 lower-case letters, digits and dashes, like gbp-audit."
        raise ApiError(422, "invalid", message, {"key": message})
    if db.scalar(select(func.count()).select_from(Agent).where(Agent.key == body.key)):
        raise ApiError(409, "key_taken", "An agent with that key exists.", {"key": "Already used."})
    token = service.new_token()
    agent = Agent(key=body.key, name=body.name, token_hash=hash_secret(token))
    db.add(agent)
    db.flush()
    audit.record(db, me, "create", "agent", agent.key, agent.name, [])
    db.commit()
    return TokenOut(agent=_out(db, agent), token=token)


@router.post("/{key}/token", response_model=TokenOut)
def replace_token(key: str, me: CurrentUser, db: Db) -> TokenOut:
    """A new token; the old one stops working at once."""
    ensure(me, Action.MANAGE_AGENT_TOKENS)
    agent = _get(db, key)
    token = service.new_token()
    agent.token_hash = hash_secret(token)
    audit.record(db, me, "new_token", "agent", agent.key, agent.name, [])
    db.commit()
    return TokenOut(agent=_out(db, agent), token=token)


class SwitchIn(Strict):
    enabled: bool


@router.put("/{key}/enabled", response_model=AgentOut)
def switch(key: str, body: SwitchIn, me: CurrentUser, db: Db) -> AgentOut:
    ensure(me, Action.OPERATE_AGENTS)
    agent = _get(db, key)
    if agent.enabled != body.enabled:
        changes = [{"field": "enabled", "from": agent.enabled, "to": body.enabled}]
        agent.enabled = body.enabled
        audit.record(db, me, "switch", "agent", agent.key, agent.name, changes)
        db.commit()
    return _out(db, agent)


class SettingsIn(Strict):
    config: dict[str, Any] | None = None
    daily_limit: Annotated[int, Field(ge=1, le=100_000)] | None = None
    run_time: str | None = None
    time_zone: str | None = None
    daily_budget_usd: Annotated[Decimal, Field(ge=0, le=10_000, decimal_places=2)] | None = None
    batch_ids: Annotated[list[uuid.UUID], Field(max_length=200)] | None = None


@router.patch("/{key}", response_model=AgentOut)
def update_settings(key: str, body: SettingsIn, me: CurrentUser, db: Db) -> AgentOut:
    ensure(me, Action.CONFIGURE_AGENTS)
    agent = _get(db, key)
    errors: dict[str, str] = {}
    if body.run_time is not None and not RUN_TIME.match(body.run_time):
        errors["run_time"] = "Use 24-hour time, like 02:00."
    if body.time_zone is not None and not _valid_zone(body.time_zone):
        errors["time_zone"] = "Pick a time zone from the list."
    new_config = dict(agent.config or {})
    if body.config is not None:
        manifest = service.manifest_of(agent)
        settings = {s.key: s for s in manifest.settings} if manifest else {}
        for name, value in body.config.items():
            setting = settings.get(name)
            if setting is None:
                errors[f"config.{name}"] = "This agent has no such setting."
                continue
            if value is None:
                new_config.pop(name, None)  # back to the default
                continue
            problem = check_value(setting, value)
            if problem:
                errors[f"config.{name}"] = f"{setting.label} {problem}."
            else:
                new_config[name] = value
    if body.batch_ids is not None:
        known = set(db.scalars(select(Batch.id).where(Batch.id.in_(body.batch_ids))))
        if len(set(body.batch_ids)) != len(body.batch_ids):
            errors["batch_ids"] = "Each batch may be chosen once."
        elif known != set(body.batch_ids):
            errors["batch_ids"] = "One of these batches doesn't exist any more."
    if errors:
        raise ApiError(422, "invalid", next(iter(errors.values())), errors)

    before = _settings_view(agent)
    if body.batch_ids is not None:
        agent.batch_ids = [str(batch_id) for batch_id in body.batch_ids]
    agent.config = new_config
    for name in ("daily_limit", "run_time", "time_zone", "daily_budget_usd"):
        value = getattr(body, name)
        if value is not None:
            setattr(agent, name, value)
    changes = audit.diff(before, _settings_view(agent))
    if changes:
        audit.record(db, me, "edit", "agent", agent.key, agent.name, changes)
    db.commit()
    return _out(db, agent)


def _settings_view(agent: Agent) -> dict[str, Any]:
    return {
        "config": dict(agent.config or {}),
        "daily_limit": agent.daily_limit,
        "run_time": agent.run_time,
        "time_zone": agent.time_zone,
        "daily_budget_usd": str(agent.daily_budget_usd),
        "batch_ids": list(agent.batch_ids or []),
    }


def _valid_zone(name: str) -> bool:
    if name not in available_timezones():
        return False
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return False
    return True


@router.post("/{key}/run", response_model=RunOut, status_code=201)
def run_now(key: str, me: CurrentUser, db: Db) -> RunOut:
    ensure(me, Action.OPERATE_AGENTS)
    agent = _get(db, key)
    run = service.queue_run(db, agent, RunTrigger.MANUAL, me)
    audit.record(db, me, "run", "agent", agent.key, agent.name, [])
    db.commit()
    db.refresh(run)
    return RunOut.of(run)


@router.post("/{key}/stop", response_model=RunOut)
def stop(key: str, me: CurrentUser, db: Db) -> RunOut:
    """Stop the agent's run: a waiting run is cancelled, a running one is told to stop at
    its next progress report."""
    ensure(me, Action.OPERATE_AGENTS)
    agent = _get(db, key)
    run = runs.request_stop(db, agent, me)
    audit.record(db, me, "stop", "agent", agent.key, agent.name, [])
    db.commit()
    db.refresh(run)
    return RunOut.of(run)
