"""`/api/usage`: what Claude has cost, by kind, day and person (Owner, SPEC 7.8 and 9.5)."""

import re
from datetime import date, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import ColumnElement, func, select

from app import settings_store
from app.auth.deps import CurrentUser, Db
from app.auth.tokens import now
from app.db.models import UsageDaily, User
from app.errors import ApiError
from app.permissions import Action, ensure

router = APIRouter(prefix="/usage", tags=["usage"])

MONTH = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")


class Totals(BaseModel):
    requests: int
    tokens_in: int
    tokens_out: int
    cost_usd: float


class KindRow(Totals):
    kind: str


class DayRow(Totals):
    date: date


class PersonRow(Totals):
    user_id: str | None
    name: str  # "System" for work nobody asked for (nightly jobs)


class UsageOut(BaseModel):
    month: str
    total: Totals
    alert_usd: float
    by_kind: list[KindRow]
    by_day: list[DayRow]
    by_person: list[PersonRow]


def _sums() -> tuple[ColumnElement[Any], ...]:
    return (
        func.coalesce(func.sum(UsageDaily.requests), 0),
        func.coalesce(func.sum(UsageDaily.tokens_in), 0),
        func.coalesce(func.sum(UsageDaily.tokens_out), 0),
        func.coalesce(func.sum(UsageDaily.cost_usd), 0),
    )


def _totals(row: tuple[Any, ...]) -> dict[str, int | float]:
    requests, tokens_in, tokens_out, cost = row[-4:]
    return {
        "requests": int(requests),
        "tokens_in": int(tokens_in),
        "tokens_out": int(tokens_out),
        "cost_usd": round(float(cost), 4),
    }


@router.get("", response_model=UsageOut)
def usage(
    me: CurrentUser,
    db: Db,
    month: Annotated[str | None, Query(max_length=7)] = None,
) -> UsageOut:
    ensure(me, Action.VIEW_USAGE)
    if month is None:
        month = now().strftime("%Y-%m")
    match = MONTH.match(month)
    if match is None:
        raise ApiError(422, "invalid", "Choose a month like 2026-10.")
    start = date(int(match[1]), int(match[2]), 1)
    end = (start + timedelta(days=32)).replace(day=1)
    window = (UsageDaily.date >= start, UsageDaily.date < end)
    sums = _sums()

    total = db.execute(select(*sums).where(*window)).one()
    kinds = db.execute(
        select(UsageDaily.kind, *sums)
        .where(*window)
        .group_by(UsageDaily.kind)
        .order_by(UsageDaily.kind)
    ).all()
    days = db.execute(
        select(UsageDaily.date, *sums)
        .where(*window)
        .group_by(UsageDaily.date)
        .order_by(UsageDaily.date)
    ).all()
    people = db.execute(
        select(UsageDaily.user_id, User.name, *sums)
        .outerjoin(User, User.id == UsageDaily.user_id)
        .where(*window)
        .group_by(UsageDaily.user_id, User.name)
        .order_by(func.sum(UsageDaily.cost_usd).desc())
    ).all()
    return UsageOut(
        month=month,
        total=Totals(**_totals(tuple(total))),
        alert_usd=float(settings_store.get(db, "monthly_cost_alert_usd") or 0),
        by_kind=[KindRow(kind=r[0].value, **_totals(tuple(r))) for r in kinds],
        by_day=[DayRow(date=r[0], **_totals(tuple(r))) for r in days],
        by_person=[
            PersonRow(
                user_id=str(r[0]) if r[0] else None,
                name=r[1] or ("System" if r[0] is None else "Removed person"),
                **_totals(tuple(r)),
            )
            for r in people
        ],
    )
