"""`/api/connections`: the Owner's API keys and connection details (Settings → Connections).

Secrets are write-only: the response says whether each is set, where it comes from (the
portal or the server's .env) and its last four characters, never the value. Every change
is in History as "changed", without values.
"""

import logging
import secrets
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, StringConstraints

from app import audit, connections, settings_store
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.errors import ApiError
from app.mail import Mailer, get_mailer
from app.permissions import Action, ensure
from app.reviews.telegram import TelegramError, get_telegram

log = logging.getLogger(__name__)

router = APIRouter(prefix="/connections", tags=["connections"])

Value = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]


class FieldOut(BaseModel):
    name: str
    label: str
    secret: bool
    number: bool
    placeholder: str
    set: bool
    source: str | None  # "portal", "server" (.env), "default" or None
    value: str | None  # non-secret fields only
    hint: str | None  # secret fields: "••••ab12"


class GroupOut(BaseModel):
    id: str
    name: str
    ready: bool
    fields: list[FieldOut]


class ConnectionsOut(BaseModel):
    groups: list[GroupOut]


class ConnectionsPatch(Strict):
    values: dict[str, Value | None]


class TestResult(BaseModel):
    ok: bool
    message: str


def _out(db: Db) -> ConnectionsOut:
    portal = connections.stored(db)
    effective = connections.current()
    ready = {
        "anthropic": bool(effective.anthropic_api_key),
        "pinecone": bool(effective.pinecone_api_key),
        "telegram": bool(effective.telegram_bot_token),
        "email": effective.email_configured,
    }
    groups = []
    for group, name in connections.GROUPS.items():
        fields = []
        for field_name, field in connections.FIELDS.items():
            if field.group != group:
                continue
            value = getattr(effective, field_name, None)
            text = "" if value is None else str(value)
            fields.append(
                FieldOut(
                    name=field_name,
                    label=field.label,
                    secret=field.secret,
                    number=field.number,
                    placeholder=field.placeholder,
                    set=bool(text),
                    source=connections.source(field_name, portal),
                    value=None if field.secret else text,
                    hint=connections.hint(text) if field.secret and text else None,
                )
            )
        groups.append(GroupOut(id=group, name=name, ready=ready[group], fields=fields))
    return ConnectionsOut(groups=groups)


@router.get("", response_model=ConnectionsOut)
def get_connections(me: CurrentUser, db: Db) -> ConnectionsOut:
    ensure(me, Action.MANAGE_SETTINGS)
    return _out(db)


@router.patch("", response_model=ConnectionsOut)
def update_connections(body: ConnectionsPatch, me: CurrentUser, db: Db) -> ConnectionsOut:
    """Set values; an empty value removes the portal's value (the server's .env, if any,
    applies again)."""
    ensure(me, Action.MANAGE_SETTINGS)
    errors: dict[str, str] = {}
    for name, value in body.values.items():
        field = connections.FIELDS.get(name)
        if field is None:
            errors[name] = "This can't be set here."
        elif field.number and value and not (value.isdigit() and 0 < int(value) < 65536):
            errors[name] = "Enter a port number, like 587 or 465."
    if errors:
        raise ApiError(422, "invalid", next(iter(errors.values())), errors)
    if not body.values:
        return _out(db)
    connections.save(db, dict(body.values))
    changes = [
        {"field": name, "from": None, "to": "(removed)" if not value else "(changed)"}
        for name, value in body.values.items()
    ]
    audit.record(db, me, "update", "connections", None, "Connections", changes)
    db.commit()
    return _out(db)


@router.post("/{group}/test", response_model=TestResult)
def test_connection(
    group: Literal["anthropic", "pinecone", "telegram", "email"],
    me: CurrentUser,
    db: Db,
    mailer: Annotated[Mailer, Depends(get_mailer)],
) -> TestResult:
    """Check a connection works; for Pinecone and Telegram, also finish their setup."""
    ensure(me, Action.MANAGE_SETTINGS)
    settings = connections.current()
    if group == "anthropic":
        if not settings.anthropic_api_key:
            return TestResult(ok=False, message="Enter the API key first.")
        try:
            connections.check_anthropic(settings.anthropic_api_key, settings.rewrite_model)
        except Exception as error:
            return TestResult(ok=False, message=f"Claude refused the key: {_reason(error)}")
        return TestResult(ok=True, message="Claude answered. The key works.")

    if group == "pinecone":
        if not settings.pinecone_api_key:
            return TestResult(ok=False, message="Enter the API key first.")
        try:
            summary, host = connections.setup_pinecone(settings)
        except Exception as error:
            return TestResult(ok=False, message=f"Pinecone refused: {_reason(error)}")
        if host:
            connections.save(db, {"pinecone_host": host})
            db.commit()
        return TestResult(
            ok=True,
            message=f"{summary} Next: Knowledge base → Rebuild index sends your documents.",
        )

    if group == "telegram":
        telegram = get_telegram()
        if telegram is None:
            return TestResult(ok=False, message="Enter the bot token first.")
        if not settings.app_url.startswith("https://"):
            return TestResult(
                ok=False,
                message="Telegram needs the site's https:// address (APP_URL on the server).",
            )
        secret = settings.telegram_webhook_secret
        if len(secret) < 16:
            secret = secrets.token_hex(24)
            connections.save(db, {"telegram_webhook_secret": secret})
        try:
            telegram.set_webhook(settings.link("/api/telegram/webhook"), secret)
            username = telegram.bot_username()
        except TelegramError as error:
            db.rollback()
            return TestResult(ok=False, message=f"Telegram refused: {error}")
        settings_store.put(db, "telegram_bot_username", username)
        db.commit()
        return TestResult(
            ok=True,
            message=f"Connected to @{username}. Add it to your reviewers' group, then choose "
            "the group under Reviews.",
        )

    if not settings.email_configured:
        return TestResult(ok=False, message="Enter the SMTP server and From address first.")
    sent = mailer.send(
        me.email,
        "Answer Engine: test email",
        "This test email shows that the Answer Engine can send email.",
    )
    if not sent:
        return TestResult(
            ok=False, message="The email couldn't be sent. Check the server, port and password."
        )
    return TestResult(ok=True, message=f"Sent a test email to {me.email}.")


def _reason(error: Exception) -> str:
    """A short reason, never the key itself."""
    text: Any = getattr(error, "message", None) or str(error) or type(error).__name__
    return str(text).splitlines()[0][:200]
