"""The scheduler, budgets, Stop, stale runs, the Runs list and the Overview
(SPEC section 6.3)."""

from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.auth.tokens import now
from app.db.models import Agent, Role, Run, RunStatus, RunTrigger, User
from app.runs import service
from tests.conftest import UserFactory, sign_in
from tests.test_agents import MANIFEST, add_agent, agent_call

DHAKA = ZoneInfo("Asia/Dhaka")


@pytest.fixture
def owner(client: TestClient, make_user: UserFactory) -> User:
    user = make_user(Role.OWNER, name="Olivia")
    sign_in(client, user.email)
    return user


@pytest.fixture
def token(client: TestClient, owner: User) -> str:
    token = add_agent(client)
    agent_call(client, "PUT", "/manifest", token, MANIFEST)
    client.put("/api/agents/gbp-audit/enabled", json={"enabled": True})
    return token


def the_agent(db: Session) -> Agent:
    return db.scalars(select(Agent).where(Agent.key == "gbp-audit")).one()


def local(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=DHAKA)


def add_run(db: Session, agent: Agent, cost: str, **fields: Any) -> Run:
    run = Run(
        agent_id=agent.id,
        trigger=fields.pop("trigger", RunTrigger.MANUAL),
        status=fields.pop("status", RunStatus.SUCCEEDED),
        cost_usd=Decimal(cost),
        queued_at=fields.pop("queued_at", now()),
        **fields,
    )
    db.add(run)
    db.commit()
    return run


# --- the scheduler -------------------------------------------------------------------------


def test_one_scheduled_run_per_window(client: TestClient, token: str, db: Session) -> None:
    assert service.queue_due_runs(db, local("2026-10-27 01:59")) == []

    first = service.queue_due_runs(db, local("2026-10-27 02:00"))
    db.execute(update(Run).values(status=RunStatus.SUCCEEDED))  # it ran and finished
    db.commit()
    again = service.queue_due_runs(db, local("2026-10-27 03:00"))
    tomorrow = service.queue_due_runs(db, local("2026-10-28 02:01"))

    assert len(first) == 1 and first[0].trigger == RunTrigger.SCHEDULE
    assert again == []
    assert len(tomorrow) == 1


def test_off_and_never_connected_agents_are_not_scheduled(
    client: TestClient, owner: User, db: Session
) -> None:
    token = add_agent(client)
    client.put("/api/agents/gbp-audit/enabled", json={"enabled": True})  # no manifest yet
    never = service.queue_due_runs(db, local("2026-10-27 02:00"))
    agent_call(client, "PUT", "/manifest", token, MANIFEST)
    client.put("/api/agents/gbp-audit/enabled", json={"enabled": False})
    off = service.queue_due_runs(db, local("2026-10-27 02:00"))

    assert (never, off) == ([], [])


def test_a_manual_run_delays_the_scheduled_one(client: TestClient, token: str, db: Session) -> None:
    manual = add_run(db, the_agent(db), "0", status=RunStatus.RUNNING)

    assert service.queue_due_runs(db, local("2026-10-27 02:00")) == []
    manual.status = RunStatus.SUCCEEDED
    db.commit()
    assert len(service.queue_due_runs(db, local("2026-10-27 02:30"))) == 1


def test_each_agent_follows_its_own_time_zone(client: TestClient, token: str, db: Session) -> None:
    client.patch(
        "/api/agents/gbp-audit", json={"run_time": "02:00", "time_zone": "America/New_York"}
    )

    # 02:00 in Dhaka is 16:00 the day before in New York: not due.
    assert service.queue_due_runs(db, local("2026-10-27 02:00")) == []
    # 02:00 in New York on 27 October is 12:00 in Dhaka.
    assert len(service.queue_due_runs(db, local("2026-10-27 12:00"))) == 1


# --- stale runs ------------------------------------------------------------------------------


def test_silent_and_never_picked_up_runs_time_out(
    client: TestClient, token: str, db: Session
) -> None:
    agent = the_agent(db)
    silent = add_run(
        db, agent, "0", status=RunStatus.RUNNING, heartbeat_at=now() - timedelta(minutes=11)
    )
    expired = service.expire_stale_runs(db)
    assert [r.id for r in expired] == [silent.id]
    waiting = add_run(db, agent, "0", status=RunStatus.QUEUED, queued_at=now() - timedelta(hours=7))

    expired = service.expire_stale_runs(db)

    assert [r.id for r in expired] == [waiting.id]
    db.refresh(silent)
    db.refresh(waiting)
    assert (silent.status, silent.stop_reason) == (RunStatus.TIMED_OUT, service.NOT_ANSWERING)
    assert (waiting.status, waiting.stop_reason) == (RunStatus.TIMED_OUT, service.NOT_PICKED_UP)


def test_a_reporting_run_is_left_alone(client: TestClient, token: str, db: Session) -> None:
    add_run(db, the_agent(db), "0", status=RunStatus.RUNNING, heartbeat_at=now())

    assert service.expire_stale_runs(db) == []


# --- budgets ---------------------------------------------------------------------------------


def test_a_run_gets_whats_left_today(client: TestClient, token: str, db: Session) -> None:
    add_run(db, the_agent(db), "1.25", done=30, failed=5)
    client.post("/api/agents/gbp-audit/run")

    job = agent_call(client, "GET", "/next-run", token).json()

    assert Decimal(job["budget_left_usd"]) == Decimal("3.75")  # $5 a day minus $1.25
    assert job["items_left"] == 65  # 100 a day minus 35


def test_no_budget_left_ends_the_run_before_it_starts(
    client: TestClient, token: str, db: Session
) -> None:
    add_run(db, the_agent(db), "5.00")
    client.post("/api/agents/gbp-audit/run")

    assert agent_call(client, "GET", "/next-run", token).status_code == 204
    last = db.scalars(select(Run).order_by(Run.queued_at.desc())).first()
    assert last is not None
    assert (last.status, last.stop_reason) == (RunStatus.STOPPED, service.STOPPED_BY_BUDGET)


def test_progress_says_stop_when_the_next_item_would_go_over(
    client: TestClient, token: str
) -> None:
    client.post("/api/agents/gbp-audit/run")
    run_id = agent_call(client, "GET", "/next-run", token).json()["run_id"]

    fine = agent_call(client, "POST", f"/runs/{run_id}/progress", token, {"cost_usd": "4.98"})
    over = agent_call(client, "POST", f"/runs/{run_id}/progress", token, {"cost_usd": "4.995"})

    assert fine.json()["action"] == "continue"  # $0.02 left, an item costs $0.01
    assert over.json() == {"action": "stop", "reason": service.STOPPED_BY_BUDGET}


def test_the_total_budget_covers_every_agent(client: TestClient, token: str, db: Session) -> None:
    other = add_agent(client, "web-audit")
    agent_call(client, "PUT", "/manifest", other, MANIFEST)
    web = db.scalars(select(Agent).where(Agent.key == "web-audit")).one()
    client.put("/api/budget", json={"daily_total_budget_usd": "3.00", "time_zone": "Asia/Dhaka"})
    add_run(db, web, "3.00")
    client.post("/api/agents/gbp-audit/run")

    assert agent_call(client, "GET", "/next-run", token).status_code == 204
    last = db.scalars(
        select(Run).where(Run.agent_id == the_agent(db).id).order_by(Run.queued_at.desc())
    ).first()
    assert last is not None and last.stop_reason == service.STOPPED_BY_TOTAL


def test_yesterdays_spending_doesnt_count(client: TestClient, token: str, db: Session) -> None:
    add_run(db, the_agent(db), "5.00", queued_at=now() - timedelta(days=1, hours=1))
    client.post("/api/agents/gbp-audit/run")

    assert agent_call(client, "GET", "/next-run", token).status_code == 200


# --- Stop ------------------------------------------------------------------------------------


def test_stop_cancels_a_waiting_run(client: TestClient, token: str) -> None:
    client.post("/api/agents/gbp-audit/run")

    stopped = client.post("/api/agents/gbp-audit/stop").json()

    assert (stopped["status"], stopped["stop_reason"]) == (
        "stopped",
        "Stopped by Olivia before it started.",
    )
    assert agent_call(client, "GET", "/next-run", token).status_code == 204


def test_stop_tells_a_running_agent(client: TestClient, token: str) -> None:
    client.post("/api/agents/gbp-audit/run")
    run_id = agent_call(client, "GET", "/next-run", token).json()["run_id"]

    pressed = client.post("/api/agents/gbp-audit/stop").json()
    reply = agent_call(client, "POST", f"/runs/{run_id}/progress", token, {"done": 4}).json()

    assert (pressed["status"], pressed["stop_requested"]) == ("running", True)
    assert reply == {"action": "stop", "reason": "Stopped by Olivia in the Hub."}


def test_stop_with_nothing_running(client: TestClient, token: str) -> None:
    assert client.post("/api/agents/gbp-audit/stop").status_code == 409


def test_viewers_cannot_stop(client: TestClient, token: str, make_user: UserFactory) -> None:
    client.post("/api/agents/gbp-audit/run")
    client.cookies.clear()
    sign_in(client, make_user(Role.VIEWER).email)

    assert client.post("/api/agents/gbp-audit/stop").status_code == 403


# --- the Runs list, the Overview and the total budget -------------------------------------


def test_runs_list_filters_and_pages(client: TestClient, token: str, db: Session) -> None:
    agent = the_agent(db)
    for minutes in range(55):
        add_run(db, agent, "0.01", queued_at=now() - timedelta(minutes=minutes))
    add_run(db, agent, "0", status=RunStatus.FAILED, queued_at=now() - timedelta(hours=2))

    first = client.get("/api/runs").json()
    older = client.get("/api/runs", params={"before": first["runs"][-1]["queued_at"]}).json()
    failed = client.get("/api/runs", params={"status": "failed"}).json()
    other = client.get("/api/runs", params={"agent": "nobody"}).json()

    assert (len(first["runs"]), first["more"]) == (50, True)
    assert (len(older["runs"]), older["more"]) == (6, False)
    assert [r["status"] for r in failed["runs"]] == ["failed"]
    assert failed["runs"][0]["agent_name"] == "GBP audit"
    assert other["runs"] == []


def test_overview_adds_up_todays_and_this_months_costs(
    client: TestClient, token: str, db: Session
) -> None:
    agent = the_agent(db)
    add_run(db, agent, "1.50")
    add_run(db, agent, "0.25")

    body = client.get("/api/overview").json()

    assert (body["spent_today_usd"], body["daily_total_budget_usd"]) == ("1.7500", "20.00")
    assert Decimal(body["spent_this_month_usd"]) >= Decimal("1.75")
    assert body["agents"][0]["spent_today_usd"] == "1.7500"
    assert body["agents"][0]["next_run_at"] is not None
    assert body["can_change"] is True


def test_only_owners_change_the_total_budget(
    client: TestClient, token: str, make_user: UserFactory
) -> None:
    body = {"daily_total_budget_usd": "40.00", "time_zone": "America/New_York"}
    assert client.put("/api/budget", json=body).json()["time_zone"] == "America/New_York"
    bad = client.put("/api/budget", json=body | {"time_zone": "Nowhere/Land"})
    assert bad.status_code == 422
    client.cookies.clear()
    sign_in(client, make_user(Role.ADMIN).email)

    assert client.put("/api/budget", json=body).status_code == 403
    assert client.get("/api/overview").json()["can_change"] is False


def test_an_off_agent_has_no_next_run(client: TestClient, token: str) -> None:
    client.put("/api/agents/gbp-audit/enabled", json={"enabled": False})

    assert client.get("/api/agents").json()[0]["next_run_at"] is None
