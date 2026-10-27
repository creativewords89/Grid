"""`/api/alerts` and `/api/alert-settings` (SPEC section 6.6): the latest alerts for everyone,
and where alerts go, set by Owners."""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import select

from app import audit, settings_store
from app.agents.manifest import RUN_TIME
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.db.models import Alert
from app.errors import ApiError
from app.permissions import Action, can, ensure

router = APIRouter(tags=["alerts"])


class AlertOut(BaseModel):
    id: uuid.UUID
    kind: str
    title: str
    body: str
    created_at: datetime
    sent_at: datetime | None
    emailed_to: int
    telegram_sent: bool
    error: str | None


@router.get("/alerts", response_model=list[AlertOut])
def recent_alerts(me: CurrentUser, db: Db) -> list[AlertOut]:
    ensure(me, Action.VIEW_HUB)
    found = db.scalars(select(Alert).order_by(Alert.created_at.desc()).limit(20))
    return [
        AlertOut(
            id=a.id,
            kind=a.kind,
            title=a.title,
            body=a.body,
            created_at=a.created_at,
            sent_at=a.sent_at,
            emailed_to=len(a.emailed_to),
            telegram_sent=a.telegram_sent,
            error=a.error,
        )
        for a in found
    ]


class AlertSettings(Strict):
    alerts_telegram: bool
    daily_summary: bool
    daily_summary_time: str
    low_balance_usd: Annotated[Decimal, Field(ge=0, le=100_000, decimal_places=2)]


class AlertSettingsOut(AlertSettings):
    can_change: bool


def _current(db: Db, me: CurrentUser) -> AlertSettingsOut:
    return AlertSettingsOut(
        alerts_telegram=bool(settings_store.get(db, "alerts_telegram")),
        daily_summary=bool(settings_store.get(db, "daily_summary")),
        daily_summary_time=str(settings_store.get(db, "daily_summary_time")),
        low_balance_usd=Decimal(str(settings_store.get(db, "low_balance_usd"))),
        can_change=can(me, Action.MANAGE_CONNECTIONS),
    )


@router.get("/alert-settings", response_model=AlertSettingsOut)
def get_alert_settings(me: CurrentUser, db: Db) -> AlertSettingsOut:
    ensure(me, Action.VIEW_HUB)
    return _current(db, me)


@router.put("/alert-settings", response_model=AlertSettingsOut)
def put_alert_settings(body: AlertSettings, me: CurrentUser, db: Db) -> AlertSettingsOut:
    ensure(me, Action.MANAGE_CONNECTIONS)
    if not RUN_TIME.match(body.daily_summary_time):
        message = "Use 24-hour time, like 08:00."
        raise ApiError(422, "invalid", message, {"daily_summary_time": message})
    before = _current(db, me).model_dump(mode="json", exclude={"can_change"})
    after = body.model_dump(mode="json")
    for key, value in after.items():
        settings_store.put(db, key, value)
    changes = audit.diff(before, after)
    if changes:
        audit.record(db, me, "edit", "alert_settings", None, "Alerts", changes)
    db.commit()
    return _current(db, me)
