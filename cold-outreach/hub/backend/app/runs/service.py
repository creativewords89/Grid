"""Scheduling, budgets, Stop and stale runs (SPEC section 6.3).

Costs are what agents report on their runs. "Today" for an agent's budget is its own time
zone; for the total budget, the Hub's time zone.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import settings_store
from app.agents import service as agents
from app.auth.tokens import now
from app.db.models import ACTIVE_RUN, Agent, Run, RunStatus, RunTrigger, User
from app.errors import ApiError
from app.runs import schedule

# A running run with no progress report for this long is given up on.
HEARTBEAT_TIMEOUT = timedelta(minutes=10)
# A queued run no agent picked up in this long is given up on.
PICKUP_TIMEOUT = timedelta(hours=6)

STOPPED_BY_BUDGET = "The daily budget is used up."
STOPPED_BY_TOTAL = "The total daily budget for all agents is used up."
NOT_ANSWERING = "The agent stopped answering (no progress for 10 minutes)."
NOT_PICKED_UP = "The agent didn't pick up the run (is it running on the server?)."


def hub_zone(db: Session) -> str:
    return str(settings_store.get(db, "time_zone"))


def total_budget(db: Session) -> Decimal:
    return Decimal(str(settings_store.get(db, "daily_total_budget_usd")))


def _spent(db: Session, start: datetime, end: datetime, agent: Agent | None = None) -> Decimal:
    query = select(func.coalesce(func.sum(Run.cost_usd), 0)).where(
        Run.queued_at >= start, Run.queued_at < end
    )
    if agent is not None:
        query = query.where(Run.agent_id == agent.id)
    return Decimal(str(db.scalar(query) or 0))


def spent_today(db: Session, agent: Agent, at: datetime | None = None) -> Decimal:
    start, end = schedule.today_bounds(at or now(), agent.time_zone)
    return _spent(db, start, end, agent)


def total_spent_today(db: Session, at: datetime | None = None) -> Decimal:
    start, end = schedule.today_bounds(at or now(), hub_zone(db))
    return _spent(db, start, end)


def items_today(db: Session, agent: Agent) -> int:
    start, end = schedule.today_bounds(now(), agent.time_zone)
    total = db.scalar(
        select(func.coalesce(func.sum(Run.done + Run.failed), 0)).where(
            Run.agent_id == agent.id, Run.queued_at >= start, Run.queued_at < end
        )
    )
    return int(total or 0)


@dataclass(frozen=True)
class Budget:
    agent_left: Decimal
    total_left: Decimal

    @property
    def left(self) -> Decimal:
        return max(Decimal("0"), min(self.agent_left, self.total_left))

    def stop_reason(self, next_item: Decimal) -> str | None:
        """Why the agent must stop before another item, or None."""
        if self.agent_left <= 0 or self.agent_left < next_item:
            return STOPPED_BY_BUDGET
        if self.total_left <= 0 or self.total_left < next_item:
            return STOPPED_BY_TOTAL
        return None


def budget(db: Session, agent: Agent) -> Budget:
    return Budget(
        agent_left=agent.daily_budget_usd - spent_today(db, agent),
        total_left=total_budget(db) - total_spent_today(db),
    )


def cost_per_item(agent: Agent) -> Decimal:
    manifest = agents.manifest_of(agent)
    return Decimal(str(manifest.cost_per_item_usd)) if manifest else Decimal("0")


# --- the scheduler ---------------------------------------------------------------------------


def _had_scheduled_run(db: Session, agent: Agent, window_start: datetime) -> bool:
    """Whether the run window starting at `window_start` already got its scheduled run."""
    found = db.scalar(
        select(func.count())
        .select_from(Run)
        .where(
            Run.agent_id == agent.id,
            Run.trigger == RunTrigger.SCHEDULE,
            Run.queued_at >= window_start,
            Run.queued_at < window_start + schedule.CATCH_UP,
        )
    )
    return bool(found)


def _window_start(agent: Agent, at: datetime) -> datetime:
    """The start of the window open at `at`, or else of today's window."""
    zone = ZoneInfo(agent.time_zone)
    day = schedule.due_day(at, agent.run_time, agent.time_zone) or at.astimezone(zone).date()
    return schedule.local_start(day, agent.run_time, zone)


def next_run_at(db: Session, agent: Agent, at: datetime | None = None) -> datetime | None:
    """When the next scheduled run starts, for the screens; None while the agent is off."""
    if not agent.enabled:
        return None
    at = at or now()
    done = _had_scheduled_run(db, agent, _window_start(agent, at))
    return schedule.next_run_at(at, agent.run_time, agent.time_zone, done)


def queue_due_runs(db: Session, at: datetime | None = None) -> list[Run]:
    """Queue a scheduled run for every agent whose window is open and hasn't had one."""
    at = at or now()
    queued = []
    candidates = db.scalars(
        select(Agent).where(Agent.enabled.is_(True), Agent.manifest.is_not(None))
    ).all()
    for agent in candidates:
        day = schedule.due_day(at, agent.run_time, agent.time_zone)
        if day is None:
            continue
        start = schedule.local_start(day, agent.run_time, ZoneInfo(agent.time_zone))
        if _had_scheduled_run(db, agent, start):
            continue
        if agents.active_run(db, agent) is not None:
            continue  # a manual run is going; try again on the next tick
        try:
            run = agents.queue_run(db, agent, RunTrigger.SCHEDULE, None)
        except ApiError:
            continue
        run.queued_at = at
        queued.append(run)
    db.commit()
    return queued


def expire_stale_runs(db: Session, at: datetime | None = None) -> list[Run]:
    """Give up on runs an agent stopped reporting on, or never picked up."""
    at = at or now()
    expired = []
    active = db.scalars(select(Run).where(Run.status.in_(ACTIVE_RUN))).all()
    for run in active:
        if run.status == RunStatus.RUNNING:
            last = run.heartbeat_at or run.started_at or run.queued_at
            if at - last >= HEARTBEAT_TIMEOUT:
                run.stop_reason = NOT_ANSWERING
                expired.append(run)
        elif at - run.queued_at >= PICKUP_TIMEOUT:
            run.stop_reason = NOT_PICKED_UP
            expired.append(run)
    for run in expired:
        run.status = RunStatus.TIMED_OUT
        run.finished_at = at
    db.commit()
    return expired


# --- Stop -----------------------------------------------------------------------------------


def request_stop(db: Session, agent: Agent, user: User) -> Run:
    run = agents.active_run(db, agent)
    if run is None:
        raise ApiError(409, "not_running", "Nothing is running.")
    if run.status == RunStatus.QUEUED:  # the agent hasn't started it: just cancel
        run.status = RunStatus.STOPPED
        run.finished_at = now()
        run.stop_reason = f"Stopped by {user.name} before it started."
    run.stop_requested_at = now()
    run.stop_requested_by = user.id
    return run


def stop_message(run: Run) -> str:
    who = run.stopper.name if run.stopper else "someone"
    return f"Stopped by {who} in the Hub."
