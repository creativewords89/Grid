"""Alerts by email and Telegram (SPEC section 6.6)."""

from datetime import datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import httpx2
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app import connections, providers
from app.alerts import service as alerts
from app.auth.tokens import now
from app.db.models import Agent, Alert, Role, Run, RunStatus, RunTrigger, User
from app.runs import service as runs
from tests.conftest import FakeMailer, UserFactory, sign_in
from tests.test_agents import MANIFEST, add_agent, agent_call

DHAKA = ZoneInfo("Asia/Dhaka")


@pytest.fixture
def owner(client: TestClient, make_user: UserFactory) -> User:
    user = make_user(Role.OWNER, name="Olivia", email="olivia@example.com")
    sign_in(client, user.email)
    return user


@pytest.fixture
def token(client: TestClient, owner: User) -> str:
    token = add_agent(client)
    agent_call(client, "PUT", "/manifest", token, MANIFEST)
    client.put("/api/agents/gbp-audit/enabled", json={"enabled": True})
    return token


class FakeTelegram:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    def __call__(self, token: str, chat: str, text: str) -> None:
        self.sent.append((chat, text))


def start_run(client: TestClient, token: str) -> str:
    client.post("/api/agents/gbp-audit/run")
    run_id: str = agent_call(client, "GET", "/next-run", token).json()["run_id"]
    return run_id


def finish(client: TestClient, token: str, run_id: str, **body: object) -> None:
    response = agent_call(client, "POST", f"/runs/{run_id}/finish", token, body)
    assert response.status_code == 204, response.text


def titles(db: Session) -> list[str]:
    return list(db.scalars(select(Alert.title).order_by(Alert.created_at)))


def test_a_failed_run_alerts_owners_and_admins_by_email_and_telegram(
    client: TestClient, token: str, db: Session, make_user: UserFactory, mailer: FakeMailer
) -> None:
    make_user(Role.ADMIN, email="adam@example.com")
    make_user(Role.VIEWER, email="vera@example.com")
    quiet = make_user(Role.ADMIN, email="quiet@example.com")
    quiet.alert_email = False
    make_user(Role.ADMIN, email="invited@example.com", password=None)
    db.commit()
    client.patch(
        "/api/connections",
        json={"values": {"telegram_bot_token": "123:bot-token-xyz", "telegram_chat_id": "-100123"}},
    )
    connections.invalidate()
    telegram = FakeTelegram()

    finish(client, token, start_run(client, token), status="failed", stop_reason="DataForSEO down")
    sent = alerts.deliver_pending(db, mailer, telegram)

    assert sent == 1
    assert titles(db) == ["GBP audit failed"]
    assert sorted(m.to for m in mailer.outbox) == ["adam@example.com", "olivia@example.com"]
    assert mailer.outbox[0].subject == "Agent Hub: GBP audit failed"
    assert "DataForSEO down" in mailer.outbox[0].body
    assert telegram.sent[0][0] == "-100123"
    assert telegram.sent[0][1].startswith("⚠️ GBP audit failed")
    assert alerts.deliver_pending(db, mailer, telegram) == 0  # sent once


def test_the_same_alert_is_not_repeated_within_6_hours(
    client: TestClient, token: str, db: Session
) -> None:
    finish(client, token, start_run(client, token), status="failed")
    finish(client, token, start_run(client, token), status="failed")
    assert titles(db) == ["GBP audit failed"]

    db.execute(update(Alert).values(created_at=now() - timedelta(hours=7)))
    db.commit()
    finish(client, token, start_run(client, token), status="failed")
    assert len(titles(db)) == 2


def test_a_budget_stop_alerts(client: TestClient, token: str, db: Session) -> None:
    agent = db.scalars(select(Agent)).one()
    db.add(
        Run(
            agent_id=agent.id,
            trigger=RunTrigger.MANUAL,
            status=RunStatus.SUCCEEDED,
            cost_usd=Decimal("5.00"),
        )
    )
    db.commit()
    client.post("/api/agents/gbp-audit/run")

    assert agent_call(client, "GET", "/next-run", token).status_code == 204
    assert titles(db) == ["GBP audit stopped: budget used up"]


def test_many_failed_items_alert(client: TestClient, token: str, db: Session) -> None:
    finish(client, token, start_run(client, token), status="succeeded", done=7, failed=3)

    assert titles(db) == ["GBP audit: 3 of 10 items failed"]


def test_a_few_failures_dont(client: TestClient, token: str, db: Session) -> None:
    finish(client, token, start_run(client, token), status="succeeded", done=9, failed=1)
    finish(client, token, start_run(client, token), status="succeeded", done=1, failed=2)

    assert titles(db) == []  # 10% failed; 3 items are too few to judge


def test_a_silent_agent_alerts(client: TestClient, token: str, db: Session) -> None:
    run_id = start_run(client, token)
    db.execute(update(Run).values(heartbeat_at=now() - timedelta(minutes=11)))
    db.commit()

    runs.expire_stale_runs(db)

    assert titles(db) == ["GBP audit stopped answering"]
    assert run_id


def test_a_connection_that_stops_working_alerts_owners(
    client: TestClient, owner: User, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    answers = iter([200, 401])

    def dataforseo(_: httpx2.Request) -> httpx2.Response:
        status = next(answers)
        body = (
            {
                "status_code": 20000,
                "tasks": [{"status_code": 20000, "result": [{"money": {"balance": 50}}]}],
            }
            if status == 200
            else {}
        )
        return httpx2.Response(status, json=body)

    monkeypatch.setattr(providers, "transport", httpx2.MockTransport(dataforseo))
    client.patch(
        "/api/connections",
        json={"values": {"dataforseo_login": "a@b.com", "dataforseo_password": "secret-pass-1"}},
    )
    client.post("/api/connections/dataforseo/test")
    client.post("/api/connections/dataforseo/test")

    alert = db.scalars(select(Alert)).one()
    assert (alert.title, alert.audience) == ("DataForSEO connection stopped working", "owners")


def test_low_balance_is_checked_once_a_day(
    client: TestClient, owner: User, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[int] = []

    def dataforseo(_: httpx2.Request) -> httpx2.Response:
        calls.append(1)
        return httpx2.Response(
            200,
            json={
                "status_code": 20000,
                "tasks": [{"status_code": 20000, "result": [{"money": {"balance": 7.5}}]}],
            },
        )

    monkeypatch.setattr(providers, "transport", httpx2.MockTransport(dataforseo))
    client.patch(
        "/api/connections",
        json={"values": {"dataforseo_login": "a@b.com", "dataforseo_password": "secret-pass-1"}},
    )
    connections.invalidate()

    alerts.check_balance(db)
    alerts.check_balance(db)
    db.commit()

    assert len(calls) == 1
    assert titles(db) == ["DataForSEO balance is low: $7.50"]


def test_the_daily_summary_goes_to_telegram_only_once(
    client: TestClient, token: str, db: Session, mailer: FakeMailer
) -> None:
    agent = db.scalars(select(Agent)).one()
    yesterday = datetime(2026, 10, 26, 14, 0, tzinfo=DHAKA)
    db.add(
        Run(
            agent_id=agent.id,
            trigger=RunTrigger.SCHEDULE,
            status=RunStatus.SUCCEEDED,
            done=95,
            failed=5,
            cost_usd=Decimal("0.95"),
            queued_at=yesterday,
        )
    )
    db.commit()
    client.patch(
        "/api/connections",
        json={"values": {"telegram_bot_token": "123:bot-token-xyz", "telegram_chat_id": "-100123"}},
    )
    connections.invalidate()
    telegram = FakeTelegram()

    early = alerts.daily_summary(db, datetime(2026, 10, 27, 7, 59, tzinfo=DHAKA))
    text = alerts.daily_summary(db, datetime(2026, 10, 27, 8, 0, tzinfo=DHAKA))
    again = alerts.daily_summary(db, datetime(2026, 10, 27, 9, 0, tzinfo=DHAKA))
    db.commit()
    alerts.deliver_pending(db, mailer, telegram)

    assert (early, again) == (None, None)
    assert text is not None
    assert "GBP audit (on): 1 runs, 95 done, 5 failed, $0.95" in text
    assert "Total spent: $0.95" in text
    assert [t for _, t in telegram.sent] == [text]
    assert mailer.outbox == []  # the summary is for the group, not email


def test_owners_choose_where_alerts_go(
    client: TestClient, token: str, db: Session, make_user: UserFactory, mailer: FakeMailer
) -> None:
    settings = {
        "alerts_telegram": False,
        "daily_summary": False,
        "daily_summary_time": "07:30",
        "low_balance_usd": "25.00",
    }
    assert client.put("/api/alert-settings", json=settings).json()["daily_summary_time"] == "07:30"
    bad = client.put("/api/alert-settings", json=settings | {"daily_summary_time": "7.30"})
    assert bad.status_code == 422
    client.patch(
        "/api/connections",
        json={"values": {"telegram_bot_token": "123:bot-token-xyz", "telegram_chat_id": "-100123"}},
    )
    connections.invalidate()
    telegram = FakeTelegram()
    finish(client, token, start_run(client, token), status="failed")
    alerts.deliver_pending(db, mailer, telegram)
    assert telegram.sent == []  # switched off

    client.cookies.clear()
    sign_in(client, make_user(Role.ADMIN).email)
    assert client.put("/api/alert-settings", json=settings).status_code == 403
    assert client.get("/api/alert-settings").json()["can_change"] is False


def test_each_person_can_stop_alert_emails(client: TestClient, owner: User) -> None:
    assert client.get("/api/auth/me").json()["user"]["alert_email"] is True

    updated = client.patch("/api/me", json={"alert_email": False}).json()

    assert updated["alert_email"] is False


def test_recent_alerts_are_listed(client: TestClient, token: str, db: Session) -> None:
    finish(client, token, start_run(client, token), status="failed")

    listed = client.get("/api/alerts").json()

    assert [a["title"] for a in listed] == ["GBP audit failed"]
