"""Settings → Connections (API keys entered in the portal) and the first-run setup page."""

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import connections
from app.answering.claude_answer import ClaudeAnswerer, get_answerer
from app.api.setup import setup_code
from app.db.models import AuditEntry, Role, Setting, User
from app.kb.store import get_store
from app.reviews.telegram import get_telegram
from tests.conftest import PASSWORD, FakeMailer, UserFactory, sign_in
from tests.fakes import FakeTelegram

KEY = "sk-ant-api03-abcdefghijklmnop-WXYZ"


@pytest.fixture
def owner(client: TestClient, make_user: UserFactory) -> TestClient:
    sign_in(client, make_user(Role.OWNER).email)
    return client


def group(body: dict[str, Any], name: str) -> dict[str, Any]:
    found: dict[str, Any] = next(g for g in body["groups"] if g["id"] == name)
    return found


def field(body: dict[str, Any], name: str) -> dict[str, Any]:
    for g in body["groups"]:
        for f in g["fields"]:
            if f["name"] == name:
                found: dict[str, Any] = f
                return found
    raise AssertionError(name)


# --- saving keys ------------------------------------------------------------------------------


def test_a_key_saved_in_the_portal_is_never_shown_again(owner: TestClient, db: Session) -> None:
    before = owner.get("/api/connections").json()
    assert group(before, "anthropic")["ready"] is False
    assert field(before, "anthropic_api_key")["set"] is False

    saved = owner.patch("/api/connections", json={"values": {"anthropic_api_key": f"  {KEY} "}})

    assert saved.status_code == 200, saved.text
    body = saved.json()
    key = field(body, "anthropic_api_key")
    assert key == key | {"set": True, "source": "portal", "value": None, "hint": "••••WXYZ"}
    assert group(body, "anthropic")["ready"] is True
    assert KEY not in saved.text
    assert KEY not in owner.get("/api/connections").text
    # Stored encrypted, and History says only that it changed.
    row = db.get(Setting, "connections")
    assert row is not None and KEY not in json.dumps(row.value)
    entry = db.scalars(select(AuditEntry).where(AuditEntry.entity == "connections")).one()
    assert KEY not in json.dumps(entry.changes)
    assert entry.changes == [{"field": "anthropic_api_key", "from": None, "to": "(changed)"}]


def test_portal_values_are_used_straight_away(owner: TestClient, db: Session) -> None:
    assert get_answerer(db) is None
    assert get_store() is None
    assert get_telegram() is None

    owner.patch(
        "/api/connections",
        json={
            "values": {
                "anthropic_api_key": KEY,
                "pinecone_api_key": "pcsk_test_1234567890",
                "telegram_bot_token": "123456:portal-token",
                "smtp_host": "smtp.example.com",
                "smtp_port": "465",
                "smtp_from": "answers@example.com",
            }
        },
    )

    answerer = get_answerer(db)
    assert isinstance(answerer, ClaudeAnswerer)
    assert get_telegram() is not None
    settings = connections.current()
    assert settings.pinecone_api_key == "pcsk_test_1234567890"
    assert settings.smtp_port == 465 and settings.email_configured


def test_removing_a_portal_value_falls_back_to_the_server(
    owner: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "anthropic_api_key", "sk-ant-from-dot-env-0000")
    assert field(owner.get("/api/connections").json(), "anthropic_api_key")["source"] == "server"
    owner.patch("/api/connections", json={"values": {"anthropic_api_key": KEY}})
    assert connections.current().anthropic_api_key == KEY

    body = owner.patch("/api/connections", json={"values": {"anthropic_api_key": ""}}).json()

    assert field(body, "anthropic_api_key")["source"] == "server"
    assert connections.current().anthropic_api_key == "sk-ant-from-dot-env-0000"


def test_plain_fields_are_shown_and_defaults_are_marked(owner: TestClient) -> None:
    body = owner.patch("/api/connections", json={"values": {"smtp_host": "smtp.x.com"}}).json()
    host = field(body, "smtp_host")
    assert (host["value"], host["source"], host["hint"]) == ("smtp.x.com", "portal", None)
    assert field(body, "pinecone_index")["source"] == "default"


@pytest.mark.parametrize(
    ("values", "key"),
    [
        ({"database_url": "postgres://x"}, "database_url"),
        ({"secret_key": "x"}, "secret_key"),
        ({"telegram_webhook_secret": "x"}, "telegram_webhook_secret"),
        ({"smtp_port": "smtp"}, "smtp_port"),
        ({"smtp_port": "70000"}, "smtp_port"),
    ],
)
def test_only_connection_fields_can_be_set(
    owner: TestClient, values: dict[str, str], key: str
) -> None:
    response = owner.patch("/api/connections", json={"values": values})
    assert response.status_code == 422
    assert key in response.json()["error"]["fields"]


@pytest.mark.parametrize("role", [Role.REVIEWER, Role.USER])
def test_only_owners_see_or_change_connections(
    client: TestClient, make_user: UserFactory, role: Role
) -> None:
    sign_in(client, make_user(role).email)
    assert client.get("/api/connections").status_code == 403
    assert client.patch("/api/connections", json={"values": {}}).status_code == 403
    assert client.post("/api/connections/anthropic/test").status_code == 403


def test_signed_out_people_get_nothing(client: TestClient) -> None:
    assert client.get("/api/connections").status_code == 401


def test_a_changed_secret_key_means_entering_keys_again(
    owner: TestClient, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.config import get_settings

    owner.patch("/api/connections", json={"values": {"anthropic_api_key": KEY}})
    monkeypatch.setattr(get_settings(), "secret_key", "a-different-secret-key-0123456789")
    connections.invalidate()
    assert connections.current().anthropic_api_key == ""
    assert field(owner.get("/api/connections").json(), "anthropic_api_key")["set"] is False


# --- the Test buttons --------------------------------------------------------------------------


def test_testing_claude(owner: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    assert owner.post("/api/connections/anthropic/test").json() == {
        "ok": False,
        "message": "Enter the API key first.",
    }
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(
        connections, "check_anthropic", lambda key, model: calls.append((key, model))
    )
    owner.patch("/api/connections", json={"values": {"anthropic_api_key": KEY}})

    assert owner.post("/api/connections/anthropic/test").json()["ok"] is True
    assert calls[0][0] == KEY

    def refuse(key: str, model: str) -> None:
        raise RuntimeError("invalid x-api-key")

    monkeypatch.setattr(connections, "check_anthropic", refuse)
    result = owner.post("/api/connections/anthropic/test").json()
    assert result == {"ok": False, "message": "Claude refused the key: invalid x-api-key"}


def test_pinecone_test_creates_the_index_and_keeps_its_host(
    owner: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        connections,
        "setup_pinecone",
        lambda settings: ("Index answer-engine created.", "answer-engine-abc.svc.pinecone.io"),
    )
    owner.patch("/api/connections", json={"values": {"pinecone_api_key": "pcsk_test_1234567890"}})

    result = owner.post("/api/connections/pinecone/test").json()

    assert result["ok"] is True and "Rebuild index" in result["message"]
    assert connections.current().pinecone_host == "answer-engine-abc.svc.pinecone.io"
    assert field(owner.get("/api/connections").json(), "pinecone_host")["value"] == (
        "answer-engine-abc.svc.pinecone.io"
    )


def test_telegram_connect_sets_the_webhook_with_a_new_secret(
    owner: TestClient, monkeypatch: pytest.MonkeyPatch, db: Session
) -> None:
    from app.config import get_settings

    fake = FakeTelegram()
    monkeypatch.setattr("app.reviews.telegram._client", lambda token, url: fake)
    monkeypatch.setattr(get_settings(), "app_url", "https://answers.example.com")
    owner.patch("/api/connections", json={"values": {"telegram_bot_token": "123456:portal"}})

    result = owner.post("/api/connections/telegram/test").json()

    assert result["ok"] is True and "@" in result["message"]
    secret = connections.current().telegram_webhook_secret
    assert len(secret) >= 16
    assert fake.webhook == ("https://answers.example.com/api/telegram/webhook", secret)
    # The webhook now accepts Telegram's requests with that secret.
    ok = owner.post(
        "/api/telegram/webhook",
        json={"update_id": 1},
        headers={"X-Telegram-Bot-Api-Secret-Token": secret},
    )
    assert ok.status_code == 200
    bad = owner.post(
        "/api/telegram/webhook",
        json={"update_id": 2},
        headers={"X-Telegram-Bot-Api-Secret-Token": "wrong-secret-000000"},
    )
    assert bad.status_code in (401, 403)


def test_telegram_needs_an_https_address(
    owner: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.reviews.telegram._client", lambda token, url: FakeTelegram())
    owner.patch("/api/connections", json={"values": {"telegram_bot_token": "123456:portal"}})
    result = owner.post("/api/connections/telegram/test").json()
    assert result["ok"] is False and "https://" in result["message"]


def test_email_test_sends_to_the_owner(owner: TestClient, mailer: FakeMailer) -> None:
    assert owner.post("/api/connections/email/test").json()["ok"] is False
    owner.patch(
        "/api/connections",
        json={"values": {"smtp_host": "smtp.example.com", "smtp_from": "a@example.com"}},
    )
    result = owner.post("/api/connections/email/test").json()
    assert result["ok"] is True
    assert mailer.outbox[-1].subject == "Answer Engine: test email"


# --- first-run setup --------------------------------------------------------------------------


def test_setup_creates_the_first_owner_and_signs_them_in(client: TestClient, db: Session) -> None:
    assert client.get("/api/setup").json() == {"needed": True}
    body = {
        "code": setup_code().lower().replace("-", " "),  # typed casually still works
        "name": "Olivia",
        "email": "Olivia@Example.com",
        "password": PASSWORD,
    }

    response = client.post("/api/setup", json=body)

    assert response.status_code == 201, response.text
    assert response.json()["user"]["role"] == "owner"
    assert client.get("/api/auth/me").status_code == 200
    owner = db.scalars(select(User)).one()
    assert (owner.email, owner.role) == ("olivia@example.com", Role.OWNER)
    assert client.get("/api/setup").json() == {"needed": False}
    again = client.post("/api/setup", json=body | {"email": "x@example.com"})
    assert again.status_code == 409


def test_setup_needs_the_code_and_a_good_password(client: TestClient, db: Session) -> None:
    base = {"name": "Olivia", "email": "o@example.com", "password": PASSWORD}
    wrong = client.post("/api/setup", json=base | {"code": "AAAA-BBBB-CCCC"})
    assert wrong.status_code == 403
    weak = client.post("/api/setup", json=base | {"code": setup_code(), "password": "short"})
    assert weak.status_code == 422
    assert db.scalar(select(User.id)) is None


def test_setup_is_closed_once_anyone_has_an_account(
    client: TestClient, make_user: UserFactory
) -> None:
    make_user(Role.USER)
    assert client.get("/api/setup").json() == {"needed": False}
    response = client.post(
        "/api/setup",
        json={"code": setup_code(), "name": "X", "email": "x@example.com", "password": PASSWORD},
    )
    assert response.status_code == 409


def test_setup_guesses_are_rate_limited(client: TestClient) -> None:
    base = {"name": "X", "email": "x@example.com", "password": PASSWORD, "code": "WRONG"}
    for _ in range(10):
        assert client.post("/api/setup", json=base).status_code == 403
    assert client.post("/api/setup", json=base | {"code": setup_code()}).status_code == 429
