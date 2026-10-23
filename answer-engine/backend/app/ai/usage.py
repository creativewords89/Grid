"""Daily Claude usage per person and kind, and the monthly cost alert (SPEC section 9.5)."""

import uuid
from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app import settings_store
from app.ai.pricing import cost_usd
from app.auth.tokens import now
from app.db.models import UsageDaily, UsageKind
from app.notifications.service import notify_owners

COST_ALERT = "cost_alert"


@dataclass
class Usage:
    requests: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0

    def add(self, model: str, input_tokens: int, output_tokens: int) -> None:
        self.requests += 1
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens
        self.cost_usd += cost_usd(model, input_tokens, output_tokens)


def record(db: Session, user_id: uuid.UUID | None, kind: UsageKind, usage: Usage) -> None:
    if not usage.requests:
        return
    stmt = insert(UsageDaily).values(
        date=now().date(),
        user_id=user_id,
        kind=kind,
        requests=usage.requests,
        tokens_in=usage.input_tokens,
        tokens_out=usage.output_tokens,
        cost_usd=usage.cost_usd,
    )
    db.execute(
        stmt.on_conflict_do_update(
            index_elements=[UsageDaily.date, UsageDaily.user_id, UsageDaily.kind],
            set_={
                "requests": UsageDaily.requests + stmt.excluded.requests,
                "tokens_in": UsageDaily.tokens_in + stmt.excluded.tokens_in,
                "tokens_out": UsageDaily.tokens_out + stmt.excluded.tokens_out,
                "cost_usd": UsageDaily.cost_usd + stmt.excluded.cost_usd,
            },
        )
    )
    check_cost_alert(db)


def month_cost(db: Session, month: date) -> float:
    """What Claude has cost so far in the month that `month` falls in."""
    start = month.replace(day=1)
    end = (start + timedelta(days=32)).replace(day=1)
    total = db.scalar(
        select(func.coalesce(func.sum(UsageDaily.cost_usd), 0)).where(
            UsageDaily.date >= start, UsageDaily.date < end
        )
    )
    return float(total or 0)


def check_cost_alert(db: Session) -> None:
    """Tell the Owners once a month when the month's cost passes the alert amount."""
    limit = float(settings_store.get(db, "monthly_cost_alert_usd") or 0)
    if limit <= 0:
        return
    today = now().date()
    spent = month_cost(db, today)
    if spent < limit:
        return
    month = today.strftime("%Y-%m")
    notify_owners(
        db,
        COST_ALERT,
        f"Claude usage passed ${limit:,.0f} this month",
        f"${spent:,.2f} so far in {today.strftime('%B %Y')}. "
        "See Settings → Usage for who and what it was spent on.",
        link="/settings",
        ref=("cost_month", month),
        once=True,
    )
