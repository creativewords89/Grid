"""Alerts (SPEC section 6.6): raised where something happens, sent by the scheduler.

Email goes to every active Owner (and Admin, for "staff" alerts) who hasn't switched alert
emails off; Telegram goes to the alerts group when the Owner left that on. The same alert
(by its key) isn't raised again within REPEAT_AFTER.
"""

import logging
from collections.abc import Callable
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Literal
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import connections, providers, settings_store
from app.auth.tokens import now
from app.db.models import Agent, Alert, Role, Run, RunStatus, User
from app.mail import Mailer, get_mailer
from app.runs import schedule

log = logging.getLogger(__name__)

REPEAT_AFTER = timedelta(hours=6)
FAILED_SHARE = Decimal("0.2")  # more than 20% of a run's items failed
MIN_ITEMS = 5  # …out of at least this many

Audience = Literal["owners", "staff"]


def raise_alert(
    db: Session, kind: str, key: str, title: str, body: str, audience: Audience = "staff"
) -> Alert | None:
    """Add an alert to the current transaction, unless the same one was raised recently."""
    recent = db.scalar(
        select(func.count())
        .select_from(Alert)
        .where(Alert.dedupe_key == key, Alert.created_at > now() - REPEAT_AFTER)
    )
    if recent:
        return None
    alert = Alert(kind=kind, dedupe_key=key, title=title[:200], body=body[:4000], audience=audience)
    db.add(alert)
    return alert


# --- the events -----------------------------------------------------------------------------


def run_ended(db: Session, run: Run) -> None:
    """After a run ends: failed, timed out, stopped by a budget, or too many failed items."""
    agent = run.agent
    counts = f"{run.done} done, {run.failed} failed, ${run.cost_usd:.2f} spent."
    if run.status in (RunStatus.FAILED, RunStatus.TIMED_OUT):
        word = "failed" if run.status == RunStatus.FAILED else "stopped answering"
        raise_alert(
            db,
            "run_failed",
            f"run_failed:{agent.key}",
            f"{agent.name} {word}",
            f"{run.stop_reason or 'No reason given.'} {counts}",
        )
        return
    reason = run.stop_reason or ""
    if run.status == RunStatus.STOPPED and "budget" in reason:
        raise_alert(
            db,
            "budget",
            f"budget:{agent.key}",
            f"{agent.name} stopped: budget used up",
            f"{reason} It starts again tomorrow. {counts}",
        )
        return
    items = run.done + run.failed
    if items >= MIN_ITEMS and Decimal(run.failed) / items > FAILED_SHARE:
        raise_alert(
            db,
            "many_failed",
            f"many_failed:{agent.key}",
            f"{agent.name}: {run.failed} of {items} items failed",
            f"Check the Runs screen for the reasons. {counts}",
        )


def connection_broke(db: Session, group: str, message: str) -> None:
    name = connections.GROUPS.get(group, group)
    raise_alert(
        db,
        "connection",
        f"connection:{group}",
        f"{name} connection stopped working",
        f"Its Test used to pass and now says: {message}",
        audience="owners",
    )


def check_balance(db: Session, at: datetime | None = None) -> None:
    """Once a day: alert the Owners when the DataForSEO balance is low."""
    at = at or now()
    today = at.astimezone(ZoneInfo(str(settings_store.get(db, "time_zone")))).date().isoformat()
    if settings_store.get(db, "last_balance_check_date") == today:
        return
    values = connections.current()
    if not connections.ready(values, "dataforseo"):
        return
    settings_store.put(db, "last_balance_check_date", today)
    try:
        balance = providers.dataforseo_balance(
            values["dataforseo_login"], values["dataforseo_password"]
        )
    except providers.ProviderError as error:
        connection_broke(db, "dataforseo", str(error))
        return
    low = Decimal(str(settings_store.get(db, "low_balance_usd")))
    if Decimal(str(balance)) < low:
        raise_alert(
            db,
            "low_balance",
            "low_balance:dataforseo",
            f"DataForSEO balance is low: ${balance:,.2f}",
            f"It is under ${low:,.2f}. Top it up at app.dataforseo.com so the GBP audits "
            "don't stop.",
            audience="owners",
        )


def daily_summary(db: Session, at: datetime | None = None) -> str | None:
    """Once a day at the summary time: yesterday's runs and spending, for the Telegram group."""
    at = at or now()
    zone = str(settings_store.get(db, "time_zone"))
    local = at.astimezone(ZoneInfo(zone))
    today = local.date()
    due = schedule.local_start(
        today, str(settings_store.get(db, "daily_summary_time")), ZoneInfo(zone)
    )
    if (
        not settings_store.get(db, "daily_summary")
        or at < due
        or settings_store.get(db, "last_summary_date") == today.isoformat()
    ):
        return None
    settings_store.put(db, "last_summary_date", today.isoformat())
    start, end = schedule.day_bounds(today - timedelta(days=1), zone)
    lines = [f"Agent Hub · {(today - timedelta(days=1)).strftime('%a %d %b')}"]
    total = Decimal(0)
    for agent in db.scalars(select(Agent).order_by(Agent.created_at)):
        runs = db.scalars(
            select(Run).where(Run.agent_id == agent.id, Run.queued_at >= start, Run.queued_at < end)
        ).all()
        if not runs and not agent.enabled:
            continue
        done = sum(r.done for r in runs)
        failed = sum(r.failed for r in runs)
        cost = sum((r.cost_usd for r in runs), Decimal(0))
        total += cost
        state = "on" if agent.enabled else "off"
        lines.append(
            f"• {agent.name} ({state}): {len(runs)} runs, {done} done, {failed} failed, ${cost:.2f}"
        )
    lines.append(f"Total spent: ${total:.2f}")
    text = "\n".join(lines)
    raise_alert(db, "summary", f"summary:{today.isoformat()}", "Daily summary", text)
    return text


# --- sending ----------------------------------------------------------------------------------

TelegramSend = Callable[[str, str, str], None]


def deliver_pending(
    db: Session,
    mailer: Mailer | None = None,
    telegram_send: TelegramSend | None = None,
) -> int:
    """Send every alert not sent yet. Returns how many were sent."""
    mailer = mailer or get_mailer()
    telegram_send = telegram_send or providers.telegram_send
    pending = db.scalars(select(Alert).where(Alert.sent_at.is_(None)).order_by(Alert.created_at))
    values = connections.current()
    use_telegram = bool(settings_store.get(db, "alerts_telegram")) and bool(
        values.get("telegram_bot_token") and values.get("telegram_chat_id")
    )
    sent = 0
    for alert in pending:
        roles = [Role.OWNER] if alert.audience == "owners" else [Role.OWNER, Role.ADMIN]
        people = db.scalars(
            select(User).where(
                User.role.in_(roles),
                User.active.is_(True),
                User.password_hash.is_not(None),
                User.alert_email.is_(True),
            )
        ).all()
        if alert.kind != "summary":  # the daily summary is for the Telegram group only
            for person in people:
                if mailer.send(person.email, f"Agent Hub: {alert.title}", alert.body):
                    alert.emailed_to = [*alert.emailed_to, person.email]
        if use_telegram:
            try:
                text = alert.body if alert.kind == "summary" else f"⚠️ {alert.title}\n{alert.body}"
                telegram_send(values["telegram_bot_token"], values["telegram_chat_id"], text)
                alert.telegram_sent = True
            except providers.ProviderError as error:
                alert.error = str(error)[:500]
                log.warning("alert %s not sent to Telegram: %s", alert.id, error)
        alert.sent_at = now()
        sent += 1
    db.commit()
    return sent
