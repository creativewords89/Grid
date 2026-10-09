"""`/api/settings`: the Owner's settings (SPEC sections 7.8 and 10).

Each editable key has a check that turns what was sent into the stored value, or explains
what is wrong. Every change is written to the audit log with its old and new value.
"""

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from app import audit, settings_store
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.errors import ApiError
from app.permissions import Action, ensure
from app.reviews.jobs import group_chat
from app.reviews.telegram import TelegramError, get_telegram

router = APIRouter(prefix="/settings", tags=["settings"])

Check = Callable[[Any], Any]


def number(low: float, high: float, whole: bool = False) -> Check:
    def check(value: Any) -> Any:
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise ValueError("Enter a number.")
        if whole and value != int(value):
            raise ValueError("Enter a whole number.")
        if not low <= value <= high:
            raise ValueError(f"Enter a number from {low:g} to {high:g}.")
        return int(value) if whole else float(value)

    return check


def chat_id(value: Any) -> Any:
    if value in (None, ""):
        return None
    try:
        return int(str(value).strip())
    except ValueError:
        raise ValueError("A Telegram chat ID is a number, like -1001234567890.") from None


EDITABLE: dict[str, Check] = {
    "confidence_threshold": number(0, 100, whole=True),
    "min_relevance": number(0, 1),
    "review_reminder_hours": number(0.5, 168),
    "review_escalation_hours": number(1, 720),
    "telegram_group_chat_id": chat_id,
}


class SettingsOut(BaseModel):
    values: dict[str, Any]
    telegram: dict[str, Any]


class SettingsPatch(Strict):
    values: dict[str, Any]


def _out(db: Db) -> SettingsOut:
    return SettingsOut(
        values={key: settings_store.get(db, key) for key in EDITABLE},
        telegram={
            "configured": get_telegram() is not None,
            "bot_username": settings_store.get(db, "telegram_bot_username") or "",
            "seen_chats": settings_store.get(db, "telegram_seen_chats") or [],
        },
    )


@router.get("", response_model=SettingsOut)
def get_settings_(me: CurrentUser, db: Db) -> SettingsOut:
    ensure(me, Action.MANAGE_SETTINGS)
    return _out(db)


@router.patch("", response_model=SettingsOut)
def update_settings(body: SettingsPatch, me: CurrentUser, db: Db) -> SettingsOut:
    ensure(me, Action.MANAGE_SETTINGS)
    errors: dict[str, str] = {}
    clean: dict[str, Any] = {}
    for key, value in body.values.items():
        check = EDITABLE.get(key)
        if check is None:
            errors[key] = "This setting can't be changed here."
            continue
        try:
            clean[key] = check(value)
        except ValueError as error:
            errors[key] = str(error)
    reminder = clean.get("review_reminder_hours", settings_store.get(db, "review_reminder_hours"))
    escalation = clean.get(
        "review_escalation_hours", settings_store.get(db, "review_escalation_hours")
    )
    if "review_escalation_hours" not in errors and float(escalation) <= float(reminder):
        errors["review_escalation_hours"] = "Escalate later than the reminder."
    if errors:
        raise ApiError(422, "invalid", next(iter(errors.values())), errors)
    before = {key: settings_store.get(db, key) for key in clean}
    for key, value in clean.items():
        settings_store.put(db, key, value)
    changes = audit.diff(before, clean)
    if changes:
        audit.record(db, me, "update", "settings", None, "Settings", changes)
    db.commit()
    return _out(db)


@router.post("/telegram-test", response_model=dict[str, str])
def telegram_test(me: CurrentUser, db: Db) -> dict[str, str]:
    """Post a test message to the review group, to check the bot and the chat ID."""
    ensure(me, Action.MANAGE_SETTINGS)
    telegram = get_telegram()
    chat = group_chat(db)
    if telegram is None:
        raise ApiError(409, "not_configured", "Add TELEGRAM_BOT_TOKEN to the server's .env first.")
    if chat is None:
        raise ApiError(409, "no_group", "Choose the review group first.")
    try:
        telegram.send_message(chat, "✅ The Answer Engine can post review requests here.")
    except TelegramError as error:
        raise ApiError(502, "telegram", f"Telegram refused the message: {error}") from None
    return {"message": "Sent. Check the group."}
