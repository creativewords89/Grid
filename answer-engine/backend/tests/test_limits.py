"""Step 14: rate limits, the daily question limit, cost tracking and its alert, the usage and
system pages, and the Answering and Limits settings (SPEC sections 7.8, 9.5 and 11)."""

import json
from collections.abc import Callable
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import settings_store
from app.ai import usage
from app.ai.usage import COST_ALERT, Usage
from app.answering.claude_answer import ClaudeAnswerer, get_answerer
from app.auth.tokens import now
from app.db.models import (
    Job,
    JobState,
    Notification,
    Role,
    UsageDaily,
    UsageKind,
    User,
)
from tests.asking import add_doc, ask, new_chat
from tests.conftest import PASSWORD, UserFactory, sign_in
from tests.fakes import FakeStore

PRICING = "The Pro plan costs $900 per month and includes weekly reports."


# --- sign-in rate limit ----------------------------------------------------------------------


def test_sign_in_is_limited_to_10_a_minute_per_address(
    client: TestClient, make_user: UserFactory
) -> None:
    user = make_user(Role.USER)
    # Different email addresses, so the per-account lockout isn't what stops them.
    for n in range(10):
        wrong = client.post(
            "/api/auth/login", json={"email": f"nobody{n}@example.com", "password": "x" * 12}
        )
        assert wrong.status_code == 401
    blocked = client.post("/api/auth/login", json={"email": user.email, "password": PASSWORD})
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "rate_limited"


def test_old_attempts_dont_count(client: TestClient, make_user: UserFactory, db: Session) -> None:
    from app.db.models import LoginAttempt

    for _ in range(10):
        db.add(
            LoginAttempt(
                email="x@example.com", ip="testclient", ok=False, at=now() - timedelta(minutes=2)
            )
        )
    db.commit()
    user = make_user(Role.USER)
    assert sign_in(client, user.email)["user"]


# --- question limits -------------------------------------------------------------------------


@pytest.fixture
def chat(me: tuple[TestClient, User], db: Session, store: FakeStore) -> tuple[TestClient, str]:
    client, user = me
    add_doc(db, store, user, "Pricing.pdf", [PRICING])
    return client, new_chat(client)


def test_the_daily_question_limit(chat: tuple[TestClient, str], db: Session) -> None:
    client, chat_id = chat
    settings_store.put(db, "questions_per_user_per_day", 2)
    db.commit()
    ask(client, chat_id, "How much is Pro?")
    ask(client, chat_id, "And per year?")

    third = client.post(f"/api/conversations/{chat_id}/ask", json={"question": "And Basic?"})

    assert third.status_code == 429
    error = third.json()["error"]
    assert error["code"] == "daily_limit"
    assert "2 questions today" in error["message"]


def test_the_daily_limit_is_per_person(
    chat: tuple[TestClient, str],
    db: Session,
    ask_client: Callable[[], TestClient],
    make_user: UserFactory,
) -> None:
    client, chat_id = chat
    settings_store.put(db, "questions_per_user_per_day", 1)
    db.commit()
    ask(client, chat_id, "How much is Pro?")
    assert (
        client.post(f"/api/conversations/{chat_id}/ask", json={"question": "Again?"}).status_code
        == 429
    )

    other = ask_client()
    sign_in(other, make_user(Role.USER).email)
    ask(other, new_chat(other), "How much is Pro?")


def test_asking_is_limited_to_20_a_minute(
    chat: tuple[TestClient, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, chat_id = chat
    monkeypatch.setattr("app.limits.QUESTIONS_PER_MINUTE", 2)
    ask(client, chat_id, "One?")
    ask(client, chat_id, "Two?")

    third = client.post(f"/api/conversations/{chat_id}/ask", json={"question": "Three?"})

    assert third.status_code == 429
    assert third.json()["error"]["code"] == "rate_limited"


# --- cost tracking and the monthly alert -----------------------------------------------------


def spend(
    db: Session,
    user: User | None,
    dollars: float,
    days_ago: int = 0,
    kind: UsageKind = UsageKind.ANSWER,
) -> None:
    db.add(
        UsageDaily(
            date=now().date() - timedelta(days=days_ago),
            user_id=user.id if user else None,
            kind=kind,
            requests=1,
            tokens_in=1000,
            tokens_out=100,
            cost_usd=dollars,
        )
    )
    db.commit()


def one_call(model: str = "claude-opus-5-5") -> Usage:
    spent = Usage()
    spent.add(model, 1_000_000, 0)  # $4 with Opus 5.5
    return spent


def test_costs_come_from_the_price_table() -> None:
    spent = Usage()
    spent.add("claude-opus-5-5", 1000, 500)
    spent.add("claude-haiku-5-5", 1000, 500)
    assert spent.requests == 2
    assert spent.cost_usd == pytest.approx((4000 + 10000 + 100 + 250) / 1_000_000)


def test_the_owners_are_told_once_when_the_month_passes_the_alert(
    db: Session, make_user: UserFactory
) -> None:
    owner = make_user(Role.OWNER)
    reviewer = make_user(Role.REVIEWER)
    settings_store.put(db, "monthly_cost_alert_usd", 10)
    spend(db, reviewer, 7.0)

    usage.record(db, reviewer.id, UsageKind.ANSWER, one_call())  # $11: over
    usage.record(db, reviewer.id, UsageKind.ANSWER, one_call())  # still over: no second alert
    db.commit()

    notes = db.scalars(select(Notification).where(Notification.kind == COST_ALERT)).all()
    assert [n.user_id for n in notes] == [owner.id]
    assert notes[0].title == "Claude usage passed $10 this month"
    assert "$11.00 so far" in notes[0].body


def test_no_alert_under_the_amount_or_when_switched_off(
    db: Session, make_user: UserFactory
) -> None:
    make_user(Role.OWNER)
    settings_store.put(db, "monthly_cost_alert_usd", 100)
    spend(db, None, 90.0, days_ago=40)  # last month doesn't count
    usage.record(db, None, UsageKind.OCR, one_call())
    assert db.scalar(select(Notification.id)) is None

    settings_store.put(db, "monthly_cost_alert_usd", 0)  # 0 = no alert
    spend(db, None, 500.0)
    usage.record(db, None, UsageKind.OCR, one_call())
    assert db.scalar(select(Notification.id)) is None


def test_a_new_month_alerts_again(db: Session, make_user: UserFactory) -> None:
    owner = make_user(Role.OWNER)
    db.add(
        Notification(
            user_id=owner.id,
            kind=COST_ALERT,
            ref_kind="cost_month",
            ref_id="2000-01",
            title="old",
        )
    )
    settings_store.put(db, "monthly_cost_alert_usd", 1)
    usage.record(db, None, UsageKind.ANSWER, one_call())
    db.commit()
    assert len(db.scalars(select(Notification).where(Notification.kind == COST_ALERT)).all()) == 2


# --- the usage page --------------------------------------------------------------------------


def test_usage_by_kind_day_and_person(
    client: TestClient, db: Session, make_user: UserFactory
) -> None:
    owner = make_user(Role.OWNER, name="Olivia")
    sara = make_user(Role.USER, name="Sara")
    spend(db, sara, 2.5)
    spend(db, sara, 1.0, kind=UsageKind.DRAFT)
    spend(db, None, 0.5)
    db.add(
        UsageDaily(
            date=now().date(), user_id=owner.id, kind=UsageKind.CHECK, requests=3, cost_usd=0.25
        )
    )
    db.commit()
    sign_in(client, owner.email)

    body = client.get("/api/usage").json()

    assert body["month"] == now().strftime("%Y-%m")
    assert body["total"]["cost_usd"] == 4.25
    assert body["total"]["requests"] == 6
    assert body["alert_usd"] == 100
    assert {r["kind"]: r["cost_usd"] for r in body["by_kind"]} == {
        "answer": 3.0,
        "check": 0.25,
        "draft": 1.0,
    }
    assert [r["cost_usd"] for r in body["by_day"]] == [4.25]
    assert [(r["name"], r["cost_usd"]) for r in body["by_person"]] == [
        ("Sara", 3.5),
        ("System", 0.5),
        ("Olivia", 0.25),
    ]


def test_usage_for_another_month_and_bad_months(
    client: TestClient, db: Session, make_user: UserFactory
) -> None:
    owner = make_user(Role.OWNER)
    spend(db, None, 3.0)
    sign_in(client, owner.email)
    assert client.get("/api/usage?month=2001-02").json()["total"]["cost_usd"] == 0
    for bad in ("2026-13", "26-10", "october"):
        assert client.get(f"/api/usage?month={bad}").status_code == 422


@pytest.mark.parametrize("role", [Role.REVIEWER, Role.USER])
def test_only_owners_see_usage_and_system(
    client: TestClient, make_user: UserFactory, role: Role
) -> None:
    sign_in(client, make_user(role).email)
    assert client.get("/api/usage").status_code == 403
    assert client.get("/api/system").status_code == 403


def test_signed_out_people_see_nothing(client: TestClient) -> None:
    assert client.get("/api/usage").status_code == 401
    assert client.get("/api/system").status_code == 401


# --- the system page -------------------------------------------------------------------------


@pytest.fixture
def backup_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    from app.config import get_settings

    folder = tmp_path / "backups"
    folder.mkdir()
    monkeypatch.setattr(get_settings(), "backup_dir", str(folder))
    return folder


def test_system_shows_failed_jobs_and_the_last_backup(
    client: TestClient, db: Session, make_user: UserFactory, backup_dir: Path
) -> None:
    owner = make_user(Role.OWNER)
    db.add(
        Job(
            kind="ingest_file",
            state=JobState.FAILED,
            attempts=3,
            last_error="Traceback (most recent call last):\n  ...\nValueError: bad PDF",
        )
    )
    db.add(Job(kind="kb_sync", state=JobState.QUEUED))
    db.add(Job(kind="kb_sync", state=JobState.DONE))
    db.commit()
    at = now() - timedelta(hours=3)
    (backup_dir / "last-backup.json").write_text(
        json.dumps({"at": at.isoformat(), "ok": True, "size_bytes": 12345, "off_server": False})
    )
    sign_in(client, owner.email)

    body = client.get("/api/system").json()

    assert body["version"]
    assert body["queued_jobs"] == 1
    assert body["failed_jobs_7d"] == 1
    [failed] = body["failed_jobs"]
    assert (failed["kind"], failed["attempts"], failed["error"]) == (
        "ingest_file",
        3,
        "ValueError: bad PDF",
    )
    backup = body["backup"]
    assert backup["found"] and backup["ok"] and not backup["late"]
    assert backup["size_bytes"] == 12345
    assert backup["off_server"] is False


def test_system_says_when_backups_are_missing_or_late(
    client: TestClient, make_user: UserFactory, backup_dir: Path
) -> None:
    sign_in(client, make_user(Role.OWNER).email)
    assert client.get("/api/system").json()["backup"] == {
        "found": False,
        "ok": None,
        "at": None,
        "size_bytes": None,
        "off_server": None,
        "message": "No backup has run yet.",
        "late": False,
    }

    old = now() - timedelta(days=3)
    (backup_dir / "last-backup.json").write_text(
        json.dumps({"at": old.isoformat(), "ok": False, "message": "pg_dump failed"})
    )
    backup = client.get("/api/system").json()["backup"]
    assert backup["late"] and backup["ok"] is False
    assert backup["message"] == "pg_dump failed"

    (backup_dir / "last-backup.json").write_text("{not json")
    assert client.get("/api/system").json()["backup"]["found"] is False


# --- Answering and Limits settings -----------------------------------------------------------


@pytest.fixture
def owner(client: TestClient, make_user: UserFactory) -> TestClient:
    sign_in(client, make_user(Role.OWNER).email)
    return client


def test_models_effort_and_limits_can_be_changed(owner: TestClient) -> None:
    body = owner.get("/api/settings").json()
    assert body["values"]["answer_model"] is None  # the server's .env choice
    assert body["values"]["questions_per_user_per_day"] == 200
    assert body["models"]["server"]["answer_model"]
    assert "claude-sonnet-5-5" in [c["id"] for c in body["models"]["choices"]]
    assert body["models"]["efforts"] == ["low", "medium", "high", "xhigh", "max"]

    changed = owner.patch(
        "/api/settings",
        json={
            "values": {
                "answer_model": "claude-sonnet-5-5",
                "check_model": "claude-haiku-5-5",
                "answer_effort": "high",
                "questions_per_user_per_day": 50,
                "monthly_cost_alert_usd": 25.5,
                "max_upload_mb": 20,
                "thread_auto_close_days": 7,
                "verified_match": 0.85,
            }
        },
    )

    assert changed.status_code == 200, changed.text
    values = changed.json()["values"]
    assert values["answer_model"] == "claude-sonnet-5-5"
    assert values["answer_effort"] == "high"
    assert values["monthly_cost_alert_usd"] == 25.5
    assert owner.get("/api/files").json()["max_upload_mb"] == 20  # shown on the upload box
    reset = owner.patch("/api/settings", json={"values": {"answer_model": ""}})
    assert reset.json()["values"]["answer_model"] is None


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("answer_model", "gpt-5"),
        ("answer_effort", "extreme"),
        ("questions_per_user_per_day", 0),
        ("questions_per_user_per_day", 2.5),
        ("monthly_cost_alert_usd", -1),
        ("max_upload_mb", 500),
        ("thread_auto_close_days", 0),
        ("verified_match", 1.5),
        ("cost_alert_month", "2026-10"),  # not editable
    ],
)
def test_bad_values_are_refused(owner: TestClient, key: str, value: object) -> None:
    response = owner.patch("/api/settings", json={"values": {key: value}})
    assert response.status_code == 422
    assert key in response.json()["error"]["fields"]


def test_the_chosen_models_are_used(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "anthropic_api_key", "test-key")
    default = get_answerer(db)
    assert isinstance(default, ClaudeAnswerer)
    assert default.answer_model == get_settings().answer_model
    assert default.effort == "medium"

    settings_store.put(db, "answer_model", "claude-sonnet-5-5")
    settings_store.put(db, "answer_effort", "low")
    db.commit()
    chosen = get_answerer(db)
    assert isinstance(chosen, ClaudeAnswerer)
    assert chosen.answer_model == "claude-sonnet-5-5"
    assert chosen.rewrite_model == get_settings().rewrite_model
    assert chosen.effort == "low"


# --- security headers ------------------------------------------------------------------------


def test_api_responses_carry_security_headers(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["cache-control"] == "no-store"
    assert "default-src 'none'" in response.headers["content-security-policy"]
