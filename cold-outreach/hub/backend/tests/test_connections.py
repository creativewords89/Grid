"""The Connections screen (SPEC section 6.1): Owner only, encrypted and write-only values,
and every Test button against fake services."""

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx2
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import connections, mail, providers, settings_store
from app.config import get_settings
from app.db.models import AuditEntry, Role, User
from tests.conftest import FakeMailer, UserFactory, sign_in

DFS_PASSWORD = "dfs-secret-password-9876"
BOT_TOKEN = "123456:bot-secret-token-abcd"


@pytest.fixture
def owner(client: TestClient, make_user: UserFactory) -> User:
    user = make_user(Role.OWNER, name="Olivia", email="olivia@example.com")
    sign_in(client, user.email)
    return user


Handler = Callable[[httpx2.Request], httpx2.Response]


@dataclass
class FakeWeb:
    """Outside services answer from `routes` (keyed by host); every request is kept."""

    routes: dict[str, Handler] = field(default_factory=dict)
    seen: list[httpx2.Request] = field(default_factory=list)

    def __setitem__(self, host: str, handler: Handler) -> None:
        self.routes[host] = handler

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.seen.append(request)
        handler = self.routes.get(request.url.host)
        if handler is None:
            return httpx2.Response(599, json={"error": "unexpected host"})
        return handler(request)


@pytest.fixture
def fake_web(monkeypatch: pytest.MonkeyPatch) -> FakeWeb:
    web = FakeWeb()
    monkeypatch.setattr(providers, "transport", httpx2.MockTransport(web.handle))
    return web


def _service_account() -> str:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    return json.dumps(
        {
            "type": "service_account",
            "client_email": "hub@project.iam.gserviceaccount.com",
            "private_key": pem,
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    )


SHEET_URL = "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit"
FOLDER_URL = "https://drive.google.com/drive/folders/1FolderIdAbCdEf123456"


def _save(client: TestClient, **values: str | None) -> dict[str, Any]:
    response = client.patch("/api/connections", json={"values": values})
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def _group(body: dict[str, Any], group: str) -> dict[str, Any]:
    return next(g for g in body["groups"] if g["id"] == group)


def _field(body: dict[str, Any], name: str) -> dict[str, Any]:
    return next(f for g in body["groups"] for f in g["fields"] if f["name"] == name)


# --- who may use it ---------------------------------------------------------------------


@pytest.mark.parametrize("role", [Role.ADMIN, Role.VIEWER])
def test_only_owners_see_or_change_connections(
    client: TestClient, make_user: UserFactory, role: Role
) -> None:
    sign_in(client, make_user(role).email)

    responses = [
        client.get("/api/connections"),
        client.patch("/api/connections", json={"values": {"smtp_host": "x"}}),
        client.post("/api/connections/email/test"),
    ]

    assert [r.status_code for r in responses] == [403, 403, 403]


def test_signed_out_is_refused(client: TestClient) -> None:
    assert client.get("/api/connections").status_code == 401


# --- storing ------------------------------------------------------------------------------


def test_every_group_is_listed_empty_at_first(client: TestClient, owner: User) -> None:
    body = client.get("/api/connections").json()

    assert [g["id"] for g in body["groups"]] == [
        "dataforseo",
        "google",
        "pagespeed",
        "email",
        "telegram",
    ]
    assert not any(g["ready"] for g in body["groups"])


def test_secrets_are_encrypted_and_never_returned(
    client: TestClient, owner: User, db: Session
) -> None:
    body = _save(client, dataforseo_login="me@gridrankers.com", dataforseo_password=DFS_PASSWORD)

    assert DFS_PASSWORD not in json.dumps(body)
    assert DFS_PASSWORD not in client.get("/api/connections").text
    password = _field(body, "dataforseo_password")
    assert (password["set"], password["value"], password["hint"]) == (True, None, "••••9876")
    assert _field(body, "dataforseo_login")["value"] == "me@gridrankers.com"
    assert _group(body, "dataforseo")["ready"] is True
    raw = settings_store.get(db, "connections")
    assert DFS_PASSWORD not in json.dumps(raw)
    assert connections.decrypt(raw["dataforseo_password"]) == DFS_PASSWORD


def test_the_key_file_is_write_only_too(client: TestClient, owner: User) -> None:
    key_file = _service_account()

    body = _save(client, google_service_account=key_file)

    field = _field(body, "google_service_account")
    assert (field["set"], field["value"], field["kind"]) == (True, None, "json")
    assert "PRIVATE KEY" not in json.dumps(body)


def test_changes_are_in_history_without_values(
    client: TestClient, owner: User, db: Session
) -> None:
    _save(client, dataforseo_password=DFS_PASSWORD)
    _save(client, dataforseo_password=None)

    entries = db.scalars(select(AuditEntry).order_by(AuditEntry.at)).all()
    assert [e.changes for e in entries] == [
        [{"field": "dataforseo_password", "from": None, "to": "(changed)"}],
        [{"field": "dataforseo_password", "from": None, "to": "(removed)"}],
    ]
    assert DFS_PASSWORD not in json.dumps([e.changes for e in entries])


def test_an_empty_value_removes_it(client: TestClient, owner: User) -> None:
    _save(client, smtp_host="smtp.example.com")

    body = _save(client, smtp_host="")

    assert _field(body, "smtp_host")["set"] is False


@pytest.mark.parametrize(
    ("name", "value", "message"),
    [
        ("smtp_port", "99999", "port number"),
        ("smtp_port", "abc", "port number"),
        ("smtp_from", "not-an-email", "email address"),
        ("google_sheet_url", "https://example.com/sheet", "Sheet's link"),
        ("google_drive_folder_url", "https://drive.google.com/", "folder's link"),
        ("google_service_account", "{not json", "isn't a JSON key file"),
        ("google_service_account", '{"type": "user"}', "isn't a service account key"),
        ("google_service_account", '{"type": "service_account"}', "incomplete"),
        ("telegram_chat_id", "my group", "is a number"),
        ("anthropic_api_key", "sk-1", "can't be set here"),
    ],
)
def test_bad_values_are_refused_without_saving(
    client: TestClient, owner: User, db: Session, name: str, value: str, message: str
) -> None:
    response = client.patch("/api/connections", json={"values": {name: value}})

    assert response.status_code == 422
    assert message in response.json()["error"]["fields"][name]
    assert settings_store.get(db, "connections") == {}


def test_a_changed_secret_key_asks_for_values_again(
    client: TestClient, owner: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    _save(client, pagespeed_api_key="AIza-pagespeed-key-1234")
    monkeypatch.setenv("SECRET_KEY", "a-completely-different-secret-key-0000")
    get_settings.cache_clear()
    connections.invalidate()

    field = _field(client.get("/api/connections").json(), "pagespeed_api_key")

    assert (field["set"], field["unreadable"]) == (False, True)


def test_values_never_reach_the_logs(
    client: TestClient, owner: User, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)

    _save(client, dataforseo_password=DFS_PASSWORD, telegram_bot_token=BOT_TOKEN)
    client.get("/api/connections")

    assert DFS_PASSWORD not in caplog.text
    assert BOT_TOKEN not in caplog.text


# --- Test buttons ---------------------------------------------------------------------------


def test_a_test_needs_the_fields_first(client: TestClient, owner: User) -> None:
    result = client.post("/api/connections/dataforseo/test").json()

    assert (result["ok"], result["message"]) == (False, "Fill in the fields first.")


def test_dataforseo_shows_the_balance(client: TestClient, owner: User, fake_web: FakeWeb) -> None:
    def dataforseo(request: httpx2.Request) -> httpx2.Response:
        assert request.url.path == "/v3/appendix/user_data"
        assert request.headers["authorization"].startswith("Basic ")
        return httpx2.Response(
            200,
            json={
                "status_code": 20000,
                "tasks": [{"status_code": 20000, "result": [{"money": {"balance": 48.5}}]}],
            },
        )

    fake_web["api.dataforseo.com"] = dataforseo
    _save(client, dataforseo_login="me@gridrankers.com", dataforseo_password=DFS_PASSWORD)

    result = client.post("/api/connections/dataforseo/test").json()

    assert (result["ok"], result["message"]) == (True, "Connected. Balance: $48.50.")
    last = _group(client.get("/api/connections").json(), "dataforseo")["last_test"]
    assert last["ok"] is True


def test_dataforseo_wrong_password(client: TestClient, owner: User, fake_web: FakeWeb) -> None:
    fake_web["api.dataforseo.com"] = lambda _: httpx2.Response(
        401, json={"status_code": 40100, "status_message": "You are not authorized."}
    )
    _save(client, dataforseo_login="me@gridrankers.com", dataforseo_password=DFS_PASSWORD)

    result = client.post("/api/connections/dataforseo/test").json()

    assert (result["ok"], result["message"]) == (
        False,
        "DataForSEO refused the login or password.",
    )


def _google_routes(fake_web: FakeWeb, *, tabs: list[str], drive_status: int) -> None:
    fake_web["oauth2.googleapis.com"] = lambda _: httpx2.Response(
        200, json={"access_token": "ya29.token", "expires_in": 3600}
    )

    def sheets(request: httpx2.Request) -> httpx2.Response:
        assert request.headers["authorization"] == "Bearer ya29.token"
        if "/values/" in request.url.path:
            return httpx2.Response(200, json={"values": [["Lead ID", "City", "Niche"]]})
        return httpx2.Response(
            200,
            json={
                "properties": {"title": "Leads Master"},
                "sheets": [{"properties": {"title": t}} for t in tabs],
            },
        )

    def drive(request: httpx2.Request) -> httpx2.Response:
        if request.method == "POST":
            if drive_status != 200:
                return httpx2.Response(
                    drive_status,
                    json={
                        "error": {
                            "message": "Service Accounts do not have storage quota.",
                            "errors": [{"reason": "storageQuotaExceeded"}],
                        }
                    },
                )
            assert json.loads(request.content)["parents"] == ["1FolderIdAbCdEf123456"]
            return httpx2.Response(200, json={"id": "file-1"})
        assert request.method == "DELETE"
        return httpx2.Response(204)

    fake_web["sheets.googleapis.com"] = sheets
    fake_web["www.googleapis.com"] = drive


def test_google_opens_the_sheet_and_writes_to_the_folder(
    client: TestClient, owner: User, fake_web: FakeWeb
) -> None:
    _google_routes(fake_web, tabs=["Leads"], drive_status=200)
    _save(
        client,
        google_service_account=_service_account(),
        google_sheet_url=SHEET_URL,
        google_drive_folder_url=FOLDER_URL,
    )

    result = client.post("/api/connections/google/test").json()

    assert result["ok"] is True, result
    assert result["message"] == (
        "Opened “Leads Master”: its Leads tab has 3 columns. The Drive folder can be written to."
    )
    token_request = next(r for r in fake_web.seen if r.url.host == "oauth2.googleapis.com")
    assertion = token_request.content.decode().split("assertion=")[1]
    assert assertion.count(".") == 2  # a signed JWT


def test_google_without_a_leads_tab_yet(client: TestClient, owner: User, fake_web: FakeWeb) -> None:
    _google_routes(fake_web, tabs=["Sheet1"], drive_status=200)
    _save(
        client,
        google_service_account=_service_account(),
        google_sheet_url=SHEET_URL,
        google_drive_folder_url=FOLDER_URL,
    )

    result = client.post("/api/connections/google/test").json()

    assert result["ok"] is True
    assert "no Leads tab yet" in result["message"]


def test_google_explains_the_shared_drive_problem(
    client: TestClient, owner: User, fake_web: FakeWeb
) -> None:
    _google_routes(fake_web, tabs=["Leads"], drive_status=403)
    _save(
        client,
        google_service_account=_service_account(),
        google_sheet_url=SHEET_URL,
        google_drive_folder_url=FOLDER_URL,
    )

    result = client.post("/api/connections/google/test").json()

    assert result["ok"] is False
    assert "Shared Drive" in result["message"]


def test_pagespeed_key(client: TestClient, owner: User, fake_web: FakeWeb) -> None:
    def pagespeed(request: httpx2.Request) -> httpx2.Response:
        assert request.url.params["strategy"] == "mobile"
        return httpx2.Response(
            200, json={"lighthouseResult": {"categories": {"performance": {"score": 0.97}}}}
        )

    fake_web["www.googleapis.com"] = pagespeed
    _save(client, pagespeed_api_key="AIza-pagespeed-key-1234")

    result = client.post("/api/connections/pagespeed/test").json()

    assert (result["ok"], result["message"]) == (
        True,
        "The key works (example.com scores 97 on mobile).",
    )


def test_email_sends_a_test_message(client: TestClient, owner: User, mailer: FakeMailer) -> None:
    _save(client, smtp_host="smtp.example.com", smtp_port="587", smtp_from="hub@example.com")

    result = client.post("/api/connections/email/test").json()

    assert (result["ok"], result["message"]) == (True, "Sent a test email to olivia@example.com.")
    assert mailer.outbox[-1].subject == "Agent Hub: test email"


def test_email_failure_is_explained(client: TestClient, owner: User, mailer: FakeMailer) -> None:
    mailer.working = False
    _save(client, smtp_host="smtp.example.com", smtp_port="587", smtp_from="hub@example.com")

    result = client.post("/api/connections/email/test").json()

    assert result["ok"] is False
    assert "couldn't be sent" in result["message"]


def test_saved_smtp_is_what_sends_invites(client: TestClient, owner: User) -> None:
    assert isinstance(mail.get_mailer(), mail.UnconfiguredMailer)

    _save(client, smtp_host="smtp.example.com", smtp_port="465", smtp_from="hub@example.com")
    mailer = mail.get_mailer()

    assert isinstance(mailer, mail.SmtpMailer)
    assert (mailer.host, mailer.port, mailer.sender) == ("smtp.example.com", 465, "hub@example.com")


def _telegram_routes(fake_web: FakeWeb, updates: list[dict[str, Any]]) -> list[Any]:
    sent: list[Any] = []

    def telegram(request: httpx2.Request) -> httpx2.Response:
        method = request.url.path.rsplit("/", 1)[1]
        if method == "getMe":
            return httpx2.Response(200, json={"ok": True, "result": {"username": "gr_hub_bot"}})
        if method == "getUpdates":
            return httpx2.Response(200, json={"ok": True, "result": updates})
        sent.append(json.loads(request.content))
        return httpx2.Response(200, json={"ok": True, "result": {"message_id": 1}})

    fake_web["api.telegram.org"] = telegram
    return sent


def test_telegram_finds_the_group_saves_it_and_says_hello(
    client: TestClient, owner: User, fake_web: FakeWeb
) -> None:
    sent = _telegram_routes(
        fake_web,
        [
            {"message": {"chat": {"id": 42, "type": "private"}}},
            {"message": {"chat": {"id": -1001234567890, "type": "supergroup", "title": "Alerts"}}},
        ],
    )
    _save(client, telegram_bot_token=BOT_TOKEN)

    result = client.post("/api/connections/telegram/test").json()

    assert result["ok"] is True
    assert "Found the group “Alerts” and saved it." in result["message"]
    assert sent[0]["chat_id"] == "-1001234567890"
    body = client.get("/api/connections").json()
    assert _field(body, "telegram_chat_id")["value"] == "-1001234567890"
    assert BOT_TOKEN not in json.dumps(body)


def test_telegram_explains_how_to_add_the_bot(
    client: TestClient, owner: User, fake_web: FakeWeb
) -> None:
    _telegram_routes(fake_web, [])
    _save(client, telegram_bot_token=BOT_TOKEN)

    result = client.post("/api/connections/telegram/test").json()

    assert result["ok"] is False
    assert "Add @gr_hub_bot to the group" in result["message"]


def test_telegram_wrong_token_never_repeats_it(
    client: TestClient, owner: User, fake_web: FakeWeb
) -> None:
    fake_web["api.telegram.org"] = lambda _: httpx2.Response(
        401, json={"ok": False, "description": "Unauthorized"}
    )
    _save(client, telegram_bot_token=BOT_TOKEN)

    result = client.post("/api/connections/telegram/test").json()

    assert result["ok"] is False
    assert "refused the bot token" in result["message"]
    assert BOT_TOKEN not in result["message"]
