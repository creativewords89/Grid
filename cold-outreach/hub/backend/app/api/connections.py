"""`/api/connections`: the Owner's keys and accounts (SPEC section 6.1).

Secrets are write-only: the response says whether each is set and its last four
characters, never the value. Every change is in History as "changed" or "removed",
without values. Each group has a Test button; its last result is kept and shown.
"""

from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter
from pydantic import BaseModel, StringConstraints

from app import audit, connections, providers, settings_store
from app.alerts import service as alerts
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.auth.tokens import now
from app.db.models import User
from app.errors import ApiError
from app.mail import MailerDep
from app.permissions import Action, ensure

router = APIRouter(prefix="/connections", tags=["connections"])

# A service account key file is a few KB; everything else is short.
Value = Annotated[str, StringConstraints(strip_whitespace=True, max_length=20_000)]
Group = Literal["dataforseo", "google", "pagespeed", "email", "telegram"]


class FieldOut(BaseModel):
    name: str
    label: str
    kind: str
    placeholder: str
    required: bool
    set: bool
    unreadable: bool  # saved before SECRET_KEY changed: enter it again
    value: str | None  # non-secret fields only
    hint: str | None  # secret fields: "••••ab12"


class TestOut(BaseModel):
    ok: bool
    message: str
    at: datetime


class GroupOut(BaseModel):
    id: str
    name: str
    ready: bool
    last_test: TestOut | None
    fields: list[FieldOut]


class ConnectionsOut(BaseModel):
    groups: list[GroupOut]


class ConnectionsPatch(Strict):
    values: dict[str, Value | None]


def _out(db: Db) -> ConnectionsOut:
    values = connections.stored(db)
    broken = connections.unreadable(db)
    tests = settings_store.get(db, "connection_tests") or {}
    groups = []
    for group, name in connections.GROUPS.items():
        fields = []
        for field_name, field in connections.FIELDS.items():
            if field.group != group:
                continue
            text = values.get(field_name, "")
            fields.append(
                FieldOut(
                    name=field_name,
                    label=field.label,
                    kind=field.kind,
                    placeholder=field.placeholder,
                    required=field.required,
                    set=bool(text),
                    unreadable=field_name in broken,
                    value=None if field.secret else text,
                    hint=connections.hint(text) if field.secret and text else None,
                )
            )
        last = tests.get(group)
        groups.append(
            GroupOut(
                id=group,
                name=name,
                ready=connections.ready(values, group),
                last_test=TestOut.model_validate(last) if last else None,
                fields=fields,
            )
        )
    return ConnectionsOut(groups=groups)


@router.get("", response_model=ConnectionsOut)
def get_connections(me: CurrentUser, db: Db) -> ConnectionsOut:
    ensure(me, Action.MANAGE_CONNECTIONS)
    return _out(db)


@router.patch("", response_model=ConnectionsOut)
def update_connections(body: ConnectionsPatch, me: CurrentUser, db: Db) -> ConnectionsOut:
    """Set values; an empty value removes it."""
    ensure(me, Action.MANAGE_CONNECTIONS)
    errors: dict[str, str] = {}
    for name, value in body.values.items():
        if name not in connections.FIELDS:
            errors[name] = "This can't be set here."
        elif value:
            reason = connections.problem(name, value)
            if reason:
                errors[name] = reason
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


@router.post("/{group}/test", response_model=TestOut)
def test_connection(group: Group, me: CurrentUser, db: Db, mailer: MailerDep) -> TestOut:
    ensure(me, Action.MANAGE_CONNECTIONS)
    values = connections.stored(db)
    if not connections.ready(values, group):
        return TestOut(ok=False, message="Fill in the fields first.", at=now())
    try:
        message = _run_test(group, values, me, db, mailer)
        result = TestOut(ok=True, message=message, at=now())
    except providers.ProviderError as error:
        result = TestOut(ok=False, message=str(error), at=now())
    tests = dict(settings_store.get(db, "connection_tests") or {})
    if not result.ok and (tests.get(group) or {}).get("ok"):
        alerts.connection_broke(db, group, result.message)
    tests[group] = result.model_dump(mode="json")
    settings_store.put(db, "connection_tests", tests)
    db.commit()
    return result


def _run_test(group: str, values: dict[str, str], me: User, db: Db, mailer: MailerDep) -> str:
    if group == "dataforseo":
        balance = providers.dataforseo_balance(
            values["dataforseo_login"], values["dataforseo_password"]
        )
        return f"Connected. Balance: ${balance:,.2f}."

    if group == "google":
        token = providers.google_token(values["google_service_account"])
        sheet = connections.sheet_id(values["google_sheet_url"]) or ""
        title, tabs = providers.google_sheet_tabs(token, sheet)
        providers.google_drive_write_test(
            token, connections.folder_id(values["google_drive_folder_url"]) or ""
        )
        if "Leads" in tabs:
            headers = providers.google_sheet_headers(token, sheet, "Leads")
            leads = f"its Leads tab has {len(headers)} columns"
        else:
            leads = "it has no Leads tab yet (the first import creates it)"
        return f"Opened “{title}”: {leads}. The Drive folder can be written to."

    if group == "pagespeed":
        score = providers.pagespeed_score(values["pagespeed_api_key"])
        return f"The key works (example.com scores {score} on mobile)."

    if group == "email":
        sent = mailer.send(
            me.email,
            "Agent Hub: test email",
            "This test email shows that the Agent Hub can send email.",
        )
        if not sent:
            raise providers.ProviderError(
                "The email couldn't be sent. Check the server, port, username and password."
            )
        return f"Sent a test email to {me.email}."

    token = values["telegram_bot_token"]
    bot = providers.telegram_bot_name(token)
    chat = values.get("telegram_chat_id", "")
    found = ""
    if not chat:
        group_found = providers.telegram_find_group(token)
        if group_found is None:
            raise providers.ProviderError(
                f"@{bot} works, but hasn't seen your alerts group yet. Add @{bot} to the group, "
                "send any message there, then press Test again."
            )
        chat, title = group_found
        connections.save(db, {"telegram_chat_id": chat})
        found = f" Found the group “{title}” and saved it."
    providers.telegram_send(token, chat, "✅ Agent Hub alerts will arrive in this group.")
    return f"@{bot} sent a test message to the alerts group.{found}"
