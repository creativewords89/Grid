"""Agents and their runs (SPEC sections 6.2 and 6.3): tokens, queueing a run, handing it to
the agent with only the connections its manifest declared, and recording what it reports."""

import secrets
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import connections
from app.agents.manifest import Manifest, effective_config
from app.auth.tokens import hash_secret, now
from app.db.models import ACTIVE_RUN, Agent, Run, RunStatus, RunTrigger, User
from app.errors import ApiError

TOKEN_PREFIX = "hub_agent_"  # noqa: S105  (a marker, not a secret)


def new_token() -> str:
    return TOKEN_PREFIX + secrets.token_urlsafe(32)


def find_by_token(db: Session, token: str) -> Agent | None:
    if not token.startswith(TOKEN_PREFIX):
        return None
    return db.scalar(select(Agent).where(Agent.token_hash == hash_secret(token)))


def manifest_of(agent: Agent) -> Manifest | None:
    return Manifest.model_validate(agent.manifest) if agent.manifest else None


def config_of(agent: Agent) -> dict[str, Any]:
    return effective_config(manifest_of(agent), agent.config or {})


def missing_connections(agent: Agent, values: dict[str, str]) -> list[str]:
    """Connection groups the manifest needs that aren't filled in yet."""
    manifest = manifest_of(agent)
    if manifest is None:
        return []
    return [group for group in manifest.connections if not connections.ready(values, group)]


def active_run(db: Session, agent: Agent) -> Run | None:
    return db.scalar(select(Run).where(Run.agent_id == agent.id, Run.status.in_(ACTIVE_RUN)))


def last_run(db: Session, agent: Agent) -> Run | None:
    return db.scalar(
        select(Run).where(Run.agent_id == agent.id).order_by(Run.queued_at.desc()).limit(1)
    )


def queue_run(db: Session, agent: Agent, trigger: RunTrigger, user: User | None) -> Run:
    """Queue a run; refused while the agent is off, has never connected or is busy."""
    if not agent.enabled:
        raise ApiError(409, "agent_off", "Switch the agent on first.")
    if agent.manifest is None:
        raise ApiError(
            409, "never_connected", "This agent hasn't connected to the Hub yet. Start it first."
        )
    if active_run(db, agent) is not None:
        raise ApiError(409, "busy", "This agent already has a run waiting or in progress.")
    run = Run(
        agent_id=agent.id,
        trigger=trigger,
        status=RunStatus.QUEUED,
        requested_by=user.id if user else None,
    )
    db.add(run)
    try:
        db.flush()
    except IntegrityError:  # two requests at once: the unique index lets only one in
        db.rollback()
        raise ApiError(
            409, "busy", "This agent already has a run waiting or in progress."
        ) from None
    return run


def start_next(db: Session, agent: Agent) -> Run | None:
    """Mark the agent's queued run as running, if it has one and is switched on."""
    if not agent.enabled:
        return None
    run = db.scalar(
        select(Run)
        .where(Run.agent_id == agent.id, Run.status == RunStatus.QUEUED)
        .order_by(Run.queued_at)
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    if run is None:
        return None
    run.status = RunStatus.RUNNING
    run.started_at = run.heartbeat_at = now()
    return run


def run_connections(agent: Agent) -> dict[str, dict[str, str]]:
    """The values of the connection groups this agent's manifest declared, and no others."""
    manifest = manifest_of(agent)
    if manifest is None:
        return {}
    values = connections.current()
    out: dict[str, dict[str, str]] = {}
    for group in manifest.connections:
        out[group] = {
            name: values[name]
            for name, field in connections.FIELDS.items()
            if field.group == group and name in values
        }
    return out
