"""Built-in agents that run in the Hub (SPEC step 25): added by choosing a kind, no token,
signed in by the runner with a key worked out from SECRET_KEY."""

import threading
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from app import runner
from app.builtin import KINDS, runner_token
from app.db.models import Role, User
from tests.conftest import UserFactory, sign_in
from tests.hub_data import make_batch, put_bot, task_id_of
from tests.test_agents import add_agent, agent_call
from tests.test_pipeline import leads


@pytest.fixture
def owner(client: TestClient, make_user: UserFactory) -> User:
    user = make_user(Role.OWNER, name="Olivia")
    sign_in(client, user.email)
    return user


class ClientHub:
    """The runner's HubClient, calling the test app instead of http://api:8000."""

    def __init__(self, client: TestClient, token: str) -> None:
        self.client = client
        self.token = token

    def call(self, method: str, path: str, body: Any = None) -> tuple[int, Any]:
        response = agent_call(self.client, method, path, self.token, body)
        return response.status_code, response.json() if response.content else None


def add_demo(client: TestClient, name: str = "Demo GBP", job: str = "gbp-audit") -> Any:
    body = {"kind": "demo", "name": name, "task_id": task_id_of(client, job)}
    response = client.post("/api/agents", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def test_the_kinds_the_hub_can_run(client: TestClient, owner: User) -> None:
    kinds = client.get("/api/agents/kinds").json()

    assert [(k["key"], k["name"], k["job"]) for k in kinds] == [("demo", "Demo agent", None)]


def test_a_built_in_agent_needs_no_token_and_does_its_job_at_once(
    client: TestClient, owner: User
) -> None:
    added = add_demo(client)
    again = add_demo(client)

    assert added["token"] is None
    agent = added["agent"]
    assert (agent["key"], agent["kind"], agent["task"]["name"]) == ("demo-gbp", "demo", "GBP Audit")
    assert again["agent"]["key"] == "demo-gbp-2"
    # It is in the library under its job before it has ever run.
    jobs = {j["key"]: j for j in client.get("/api/tasks").json()}
    assert [b["key"] for b in jobs["gbp-audit"]["bots"]] == ["demo-gbp", "demo-gbp-2"]
    refused = client.post("/api/agents/demo-gbp/token")
    assert refused.status_code == 409


def test_adding_needs_a_kind_and_a_job_and_an_owner(
    client: TestClient, owner: User, make_user: UserFactory
) -> None:
    assert client.post("/api/agents", json={"kind": "nope", "name": "X"}).status_code == 422
    no_job = client.post("/api/agents", json={"kind": "demo", "name": "X"})
    assert no_job.json()["error"]["fields"] == {"task_id": "Choose the job it does."}
    client.cookies.clear()
    sign_in(client, make_user(Role.ADMIN).email)
    body = {"kind": "demo", "name": "X", "task_id": task_id_of(client, "gbp-audit")}
    assert client.post("/api/agents", json=body).status_code == 403


def test_the_runner_key_signs_in_only_a_built_in_agent(client: TestClient, owner: User) -> None:
    add_demo(client)
    add_agent(client, "outside")  # an agent with a token of its own
    hub = ClientHub(client, runner_token("demo-gbp"))

    status, _ = hub.call("PUT", "/manifest", KINDS["demo"].manifest | {"task": "gbp-audit"})

    assert status == 200
    shown = {a["key"]: a for a in client.get("/api/agents").json()}
    assert shown["demo-gbp"]["connected"] is True
    assert shown["demo-gbp"]["task"]["name"] == "GBP Audit"
    forged = runner_token("demo-gbp")[:-4] + "0000"
    assert agent_call(client, "GET", "/next-run", forged).status_code == 401
    assert agent_call(client, "GET", "/next-run", runner_token("outside")).status_code == 401


def test_the_runner_runs_a_built_in_agent_through_a_batch(
    client: TestClient, owner: User, clean_engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    added = add_demo(client)["agent"]
    monkeypatch.setattr(runner, "get_engine", lambda: clean_engine)
    assert runner.wanted() == {"demo-gbp": ("demo", "gbp-audit")}
    batch = make_batch(client)["id"]
    with Session(clean_engine) as db:
        leads(db, batch, 2)
    put_bot(client, batch, added["key"], "gbp-audit")
    hub = ClientHub(client, runner_token("demo-gbp"))
    # Started by the runner: its manifest first, then the switch and a run.
    hub.call("PUT", "/manifest", KINDS["demo"].manifest | {"task": "gbp-audit"})
    client.put("/api/agents/demo-gbp/enabled", json={"enabled": True})
    saved = client.patch("/api/agents/demo-gbp", json={"config": {"seconds_per_item": 0}})
    assert saved.status_code == 200, saved.text
    stop = threading.Event()
    assert client.post("/api/agents/demo-gbp/run").status_code == 201

    def stop_when_idle(method: str, path: str, body: Any = None) -> tuple[int, Any]:
        status, reply = ClientHub.call(hub, method, path, body)
        if path == "/next-run" and status == 204:
            stop.set()
        return status, reply

    hub.call = stop_when_idle  # type: ignore[method-assign]
    runner.run_agent(hub, KINDS["demo"], "gbp-audit", stop, 0)  # type: ignore[arg-type]

    last = client.get("/api/agents").json()[0]["last_run"]
    assert (last["status"], last["done"]) == ("succeeded", 2)
