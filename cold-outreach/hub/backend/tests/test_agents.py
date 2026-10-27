"""Agents (SPEC section 6.2): the Agents screen's API and the API agents call."""

from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app import connections
from app.auth.tokens import now
from app.db.models import Agent, AuditEntry, Role, Run, User
from tests.conftest import UserFactory, sign_in

MANIFEST: dict[str, Any] = {
    "name": "GBP audit",
    "version": "1.0.0",
    "description": "Audits Google Business Profiles.",
    "settings": [
        {
            "key": "batch_size",
            "type": "int",
            "label": "Batch size",
            "default": 20,
            "min": 1,
            "max": 100,
        },
        {"key": "reaudit_days", "type": "int", "label": "Re-audit after (days)", "default": 30},
        {
            "key": "queue",
            "type": "choice",
            "label": "Queue",
            "default": "standard",
            "choices": ["standard", "priority"],
        },
        {"key": "dry_run", "type": "bool", "label": "Dry run", "default": False},
    ],
    "connections": ["dataforseo", "google"],
    "sheet_columns": ["GBP Status", "GBP Score"],
    "cost_per_item_usd": 0.01,
}


@pytest.fixture
def owner(client: TestClient, make_user: UserFactory) -> User:
    user = make_user(Role.OWNER, name="Olivia")
    sign_in(client, user.email)
    return user


def add_agent(client: TestClient, key: str = "gbp-audit") -> str:
    response = client.post("/api/agents", json={"key": key, "name": "GBP audit"})
    assert response.status_code == 201, response.text
    token: str = response.json()["token"]
    return token


def agent_call(client: TestClient, method: str, path: str, token: str, json: Any = None) -> Any:
    return client.request(
        method, f"/api/agent/v1{path}", json=json, headers={"Authorization": f"Bearer {token}"}
    )


@pytest.fixture
def agent_token(client: TestClient, owner: User) -> str:
    token = add_agent(client)
    assert agent_call(client, "PUT", "/manifest", token, MANIFEST).status_code == 200
    assert client.put("/api/agents/gbp-audit/enabled", json={"enabled": True}).status_code == 200
    return token


def the_agent(client: TestClient) -> dict[str, Any]:
    agents: list[dict[str, Any]] = client.get("/api/agents").json()
    return agents[0]


# --- who may do what ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("role", "view", "operate", "configure", "tokens"),
    [
        (Role.OWNER, 200, 201, 200, 200),
        (Role.ADMIN, 200, 201, 200, 403),
        (Role.VIEWER, 200, 403, 403, 403),
    ],
)
def test_each_role(
    client: TestClient,
    make_user: UserFactory,
    agent_token: str,
    role: Role,
    view: int,
    operate: int,
    configure: int,
    tokens: int,
) -> None:
    client.cookies.clear()
    sign_in(client, make_user(role).email)

    assert client.get("/api/agents").status_code == view
    assert client.post("/api/agents/gbp-audit/run").status_code == operate
    switched = client.put("/api/agents/gbp-audit/enabled", json={"enabled": True}).status_code
    assert switched == (200 if operate == 201 else 403)
    assert client.patch("/api/agents/gbp-audit", json={"daily_limit": 50}).status_code == configure
    assert client.post("/api/agents/gbp-audit/token").status_code == tokens
    added = client.post("/api/agents", json={"key": "web-audit", "name": "Website"}).status_code
    assert added == (201 if tokens == 200 else 403)


# --- adding agents and tokens ---------------------------------------------------------------


def test_the_token_is_shown_once_and_stored_hashed(
    client: TestClient, owner: User, db: Session
) -> None:
    token = add_agent(client)

    assert token.startswith("hub_agent_") and len(token) > 40
    assert token not in client.get("/api/agents").text
    stored = db.scalar(select(Agent.token_hash))
    assert stored is not None and token not in stored


@pytest.mark.parametrize("key", ["GBP Audit", "x", "gbp_audit", "-gbp"])
def test_agent_keys_are_simple(client: TestClient, owner: User, key: str) -> None:
    response = client.post("/api/agents", json={"key": key, "name": "X"})

    assert response.status_code == 422
    assert "key" in response.json()["error"]["fields"]


def test_agent_keys_are_unique(client: TestClient, owner: User) -> None:
    add_agent(client)

    response = client.post("/api/agents", json={"key": "gbp-audit", "name": "Again"})

    assert response.status_code == 409


def test_a_new_token_stops_the_old_one(client: TestClient, agent_token: str) -> None:
    new = client.post("/api/agents/gbp-audit/token").json()["token"]

    assert agent_call(client, "GET", "/next-run", agent_token).status_code == 401
    assert agent_call(client, "GET", "/next-run", new).status_code == 204


@pytest.mark.parametrize("header", ["", "Bearer nope", "Bearer hub_agent_wrong", "Basic abc"])
def test_agent_api_needs_a_valid_token(client: TestClient, agent_token: str, header: str) -> None:
    response = client.get("/api/agent/v1/next-run", headers={"Authorization": header})

    assert response.status_code == 401


def test_a_session_cookie_is_not_an_agent_token(client: TestClient, agent_token: str) -> None:
    assert client.get("/api/agent/v1/next-run").status_code == 401


# --- manifests --------------------------------------------------------------------------------


def test_the_manifest_builds_the_settings_with_defaults(
    client: TestClient, agent_token: str
) -> None:
    agent = the_agent(client)

    assert agent["manifest"]["name"] == "GBP audit"
    assert agent["config"] == {
        "batch_size": 20,
        "reaudit_days": 30,
        "queue": "standard",
        "dry_run": False,
    }
    assert agent["connected"] is True
    assert agent["missing_connections"] == ["dataforseo", "google"]


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"connections": ["dataforseo", "facebook"]}, "unknown connections: facebook"),
        ({"settings": [{"key": "Bad Key", "type": "int", "label": "x"}]}, "settings.0.key"),
        ({"settings": [{"key": "q", "type": "choice", "label": "Q"}]}, "needs choices"),
        (
            {"settings": [{"key": "n", "type": "int", "label": "N", "default": 5, "max": 3}]},
            "at most 3",
        ),
        ({"surprise": True}, "surprise"),
    ],
)
def test_bad_manifests_are_refused(
    client: TestClient, owner: User, change: dict[str, Any], message: str
) -> None:
    token = add_agent(client)

    response = agent_call(client, "PUT", "/manifest", token, MANIFEST | change)

    assert response.status_code == 422
    assert message in response.json()["error"]["message"]


def test_next_run_needs_the_manifest_first(client: TestClient, owner: User) -> None:
    token = add_agent(client)

    assert agent_call(client, "GET", "/next-run", token).status_code == 409


# --- settings ---------------------------------------------------------------------------------


def test_settings_are_saved_and_checked_against_the_manifest(
    client: TestClient, agent_token: str, db: Session
) -> None:
    response = client.patch(
        "/api/agents/gbp-audit",
        json={
            "config": {"batch_size": 50, "queue": "priority", "dry_run": True},
            "daily_limit": 250,
            "run_time": "01:30",
            "time_zone": "America/Chicago",
            "daily_budget_usd": "7.50",
        },
    )

    assert response.status_code == 200, response.text
    agent = response.json()
    assert agent["config"] == {
        "batch_size": 50,
        "reaudit_days": 30,
        "queue": "priority",
        "dry_run": True,
    }
    assert (agent["daily_limit"], agent["run_time"], agent["time_zone"]) == (
        250,
        "01:30",
        "America/Chicago",
    )
    assert agent["daily_budget_usd"] == "7.50"
    entry = db.scalars(select(AuditEntry).where(AuditEntry.action == "edit")).one()
    assert {c["field"] for c in entry.changes} == {
        "config",
        "daily_limit",
        "run_time",
        "time_zone",
        "daily_budget_usd",
    }


@pytest.mark.parametrize(
    ("body", "field", "message"),
    [
        ({"config": {"batch_size": 500}}, "config.batch_size", "at most 100"),
        ({"config": {"batch_size": 2.5}}, "config.batch_size", "whole number"),
        ({"config": {"queue": "fast"}}, "config.queue", "one of: standard, priority"),
        ({"config": {"dry_run": "yes"}}, "config.dry_run", "on or off"),
        ({"config": {"nope": 1}}, "config.nope", "no such setting"),
        ({"run_time": "25:00"}, "run_time", "24-hour"),
        ({"time_zone": "Mars/Base"}, "time_zone", "time zone"),
    ],
)
def test_bad_settings_are_refused(
    client: TestClient, agent_token: str, body: dict[str, Any], field: str, message: str
) -> None:
    response = client.patch("/api/agents/gbp-audit", json=body)

    assert response.status_code == 422
    assert message in response.json()["error"]["fields"][field]


def test_a_setting_can_go_back_to_its_default(client: TestClient, agent_token: str) -> None:
    client.patch("/api/agents/gbp-audit", json={"config": {"batch_size": 50}})

    agent = client.patch("/api/agents/gbp-audit", json={"config": {"batch_size": None}}).json()

    assert agent["config"]["batch_size"] == 20


# --- runs -------------------------------------------------------------------------------------


def test_nothing_to_do_is_204(client: TestClient, agent_token: str) -> None:
    assert agent_call(client, "GET", "/next-run", agent_token).status_code == 204


def test_run_now_is_refused_while_off_or_never_connected(client: TestClient, owner: User) -> None:
    token = add_agent(client)
    client.put("/api/agents/gbp-audit/enabled", json={"enabled": True})
    never = client.post("/api/agents/gbp-audit/run")
    agent_call(client, "PUT", "/manifest", token, MANIFEST)
    client.put("/api/agents/gbp-audit/enabled", json={"enabled": False})
    off = client.post("/api/agents/gbp-audit/run")

    assert (never.status_code, never.json()["error"]["code"]) == (409, "never_connected")
    assert (off.status_code, off.json()["error"]["code"]) == (409, "agent_off")


def test_one_run_at_a_time(client: TestClient, agent_token: str, db: Session) -> None:
    first = client.post("/api/agents/gbp-audit/run")
    second = client.post("/api/agents/gbp-audit/run")

    assert first.status_code == 201
    assert (second.status_code, second.json()["error"]["code"]) == (409, "busy")
    assert len(db.scalars(select(Run)).all()) == 1


def test_a_whole_run(client: TestClient, agent_token: str, owner: User) -> None:
    client.patch(
        "/api/connections",
        json={
            "values": {
                "dataforseo_login": "me@gridrankers.com",
                "dataforseo_password": "dfs-password-1234",
                "smtp_host": "smtp.example.com",
                "smtp_port": "587",
                "smtp_from": "hub@example.com",
            }
        },
    )
    connections.invalidate()
    queued = client.post("/api/agents/gbp-audit/run").json()
    assert (queued["status"], queued["trigger"], queued["requested_by"]) == (
        "queued",
        "manual",
        "Olivia",
    )

    started = agent_call(client, "GET", "/next-run", agent_token)
    assert started.status_code == 200
    job = started.json()
    assert job["run_id"] == queued["id"]
    assert job["config"]["batch_size"] == 20
    assert job["daily_limit"] == 100
    # Only what the manifest declared: DataForSEO and Google, never the email password.
    assert job["connections"] == {
        "dataforseo": {
            "dataforseo_login": "me@gridrankers.com",
            "dataforseo_password": "dfs-password-1234",
        },
        "google": {},
    }
    assert agent_call(client, "GET", "/next-run", agent_token).status_code == 204

    progress = agent_call(
        client,
        "POST",
        f"/runs/{job['run_id']}/progress",
        agent_token,
        {"done": 10, "failed": 1, "skipped": 2, "cost_usd": "0.11"},
    )
    assert progress.json() == {"action": "continue", "reason": None}
    assert the_agent(client)["last_run"]["status"] == "running"

    finished = agent_call(
        client,
        "POST",
        f"/runs/{job['run_id']}/finish",
        agent_token,
        {
            "status": "succeeded",
            "done": 20,
            "failed": 1,
            "skipped": 2,
            "cost_usd": "0.2100",
            "summary": {"note": "fine"},
        },
    )
    assert finished.status_code == 204
    last = the_agent(client)["last_run"]
    assert (last["status"], last["done"], last["failed"], last["cost_usd"]) == (
        "succeeded",
        20,
        1,
        "0.2100",
    )
    again = agent_call(client, "POST", f"/runs/{job['run_id']}/progress", agent_token, {})
    assert again.status_code == 409
    assert client.post("/api/agents/gbp-audit/run").status_code == 201


def test_switching_off_tells_a_running_agent_to_stop(client: TestClient, agent_token: str) -> None:
    client.post("/api/agents/gbp-audit/run")
    run_id = agent_call(client, "GET", "/next-run", agent_token).json()["run_id"]

    client.put("/api/agents/gbp-audit/enabled", json={"enabled": False})
    reply = agent_call(client, "POST", f"/runs/{run_id}/progress", agent_token, {"done": 3})

    assert reply.json() == {"action": "stop", "reason": "The agent was switched off in the Hub."}


def test_a_switched_off_agent_gets_no_queued_run(client: TestClient, agent_token: str) -> None:
    client.post("/api/agents/gbp-audit/run")
    client.put("/api/agents/gbp-audit/enabled", json={"enabled": False})

    assert agent_call(client, "GET", "/next-run", agent_token).status_code == 204


def test_an_agent_cannot_touch_another_agents_run(client: TestClient, agent_token: str) -> None:
    other = add_agent(client, "web-audit")
    agent_call(client, "PUT", "/manifest", other, MANIFEST | {"connections": []})
    client.post("/api/agents/gbp-audit/run")
    run_id = agent_call(client, "GET", "/next-run", agent_token).json()["run_id"]

    response = agent_call(client, "POST", f"/runs/{run_id}/progress", other, {"done": 1})

    assert response.status_code == 404


def test_not_seen_for_two_minutes_means_not_connected(
    client: TestClient, agent_token: str, db: Session
) -> None:
    db.execute(update(Agent).values(last_seen_at=now() - timedelta(minutes=3)))
    db.commit()

    assert the_agent(client)["connected"] is False


@pytest.mark.parametrize("run_id", ["not-a-uuid", "0199a000-0000-7000-8000-000000000000"])
def test_unknown_run_ids_are_404(client: TestClient, agent_token: str, run_id: str) -> None:
    response = agent_call(client, "POST", f"/runs/{run_id}/progress", agent_token, {})

    assert response.status_code == 404
