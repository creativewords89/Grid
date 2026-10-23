"""`/api/settings`: the Owner's settings (SPEC sections 7.8 and 10).

Each editable key has a check that turns what was sent into the stored value, or explains
what is wrong. Every change is written to the audit log with its old and new value.
"""

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from app import audit, settings_store
from app.ai.pricing import PER_MILLION
from app.answering.claude_answer import EFFORTS
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.config import get_settings as get_app_settings
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


def model(value: Any) -> Any:
    """A Claude model with a known price, or None for the server's .env setting."""
    if value in (None, ""):
        return None
    if value not in PER_MILLION:
        raise ValueError("Choose one of the listed models.")
    return value


def effort(value: Any) -> Any:
    if value not in EFFORTS:
        raise ValueError("Choose low, medium, high, xhigh or max.")
    return value


EDITABLE: dict[str, Check] = {
    # Reviews
    "confidence_threshold": number(0, 100, whole=True),
    "verified_match": number(0.5, 1),
    "review_reminder_hours": number(0.5, 168),
    "review_escalation_hours": number(1, 720),
    "telegram_group_chat_id": chat_id,
    # Answering
    "answer_model": model,
    "rewrite_model": model,
    "check_model": model,
    "answer_effort": effort,
    "min_relevance": number(0, 1),
    # Limits
    "max_upload_mb": number(1, 200, whole=True),
    "questions_per_user_per_day": number(1, 10000, whole=True),
    "monthly_cost_alert_usd": number(0, 100000),
    "thread_auto_close_days": number(1, 365, whole=True),
}


class SettingsOut(BaseModel):
    values: dict[str, Any]
    telegram: dict[str, Any]
    # For the Answering card: what "server default" means, and what may be chosen.
    models: dict[str, Any]


class SettingsPatch(Strict):
    values: dict[str, Any]


def _out(db: Db) -> SettingsOut:
    env = get_app_settings()
    return SettingsOut(
        values={key: settings_store.get(db, key) for key in EDITABLE},
        telegram={
            "configured": get_telegram() is not None,
            "bot_username": settings_store.get(db, "telegram_bot_username") or "",
            "seen_chats": settings_store.get(db, "telegram_seen_chats") or [],
        },
        models={
            "choices": [
                {"id": name, "input_usd": price[0], "output_usd": price[1]}
                for name, price in PER_MILLION.items()
            ],
            "efforts": list(EFFORTS),
            "server": {
                "answer_model": env.answer_model,
                "rewrite_model": env.rewrite_model,
                "check_model": env.check_model,
            },
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
