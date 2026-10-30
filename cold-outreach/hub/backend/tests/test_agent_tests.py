"""Test runs (SPEC step 50): an agent tried now on a few leads, from a batch or pasted GBP
links; its report stays in the run and never reaches the leads."""

import json
import threading
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app import runner
from app.agents import trials
from app.builtin import KINDS, runner_token
from app.builtin.gbp import agent as gbp_agent
from app.builtin.gbp import dataforseo, links
from app.db.models import Lead, Role, User
from tests.conftest import UserFactory, sign_in
from tests.hub_data import make_batch, task_id_of
from tests.test_builtin import ClientHub, add_demo
from tests.test_gbp_audit import INFO, FakeDataForSeo
from tests.test_pipeline import leads


@pytest.fixture
def owner(client: TestClient, make_user: UserFactory) -> User:
    user = make_user(Role.OWNER, name="Olivia")
    sign_in(client, user.email)
    return user


def _hub(client: TestClient, key: str, kind: str) -> ClientHub:
    hub = ClientHub(client, runner_token(key))

    def upload(path: str, name: str, content: bytes, content_type: str) -> int:
        response = client.post(
            f"/api/agent/v1{path}",
            data={"name": name},
            files={"file": (name, content, content_type)},
            headers={"Authorization": f"Bearer {hub.token}"},
        )
        return response.status_code

    hub.upload = upload  # type: ignore[attr-defined]
    hub.call("PUT", "/manifest", KINDS[kind].manifest | {"task": "gbp-audit"})
    client.put(f"/api/agents/{key}/enabled", json={"enabled": True})
    return hub


def _work(hub: ClientHub, kind: str) -> None:
    """The runner's thread for the agent, until it has nothing left to do."""
    stop = threading.Event()

    def stop_when_idle(method: str, path: str, body: Any = None) -> tuple[int, Any]:
        status, reply = ClientHub.call(hub, method, path, body)
        if path == "/next-run" and status == 204:
            stop.set()
        return status, reply

    hub.call = stop_when_idle  # type: ignore[method-assign]
    runner.run_agent(hub, KINDS[kind], "gbp-audit", stop, 0)  # type: ignore[arg-type]


def test_a_test_on_a_batchs_leads_keeps_its_report_and_leaves_the_leads(
    client: TestClient, owner: User, clean_engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = add_demo(client)["agent"]["key"]
    hub = _hub(client, key, "demo")
    client.patch(f"/api/agents/{key}", json={"config": {"seconds_per_item": 0}})
    batch = make_batch(client)["id"]
    with Session(clean_engine) as db:
        leads(db, batch, 3)

    started = client.post(f"/api/agents/{key}/tests", json={"batch_id": batch, "count": 2})
    assert started.status_code == 201, started.text
    test = started.json()
    assert (test["trigger"], test["status"], test["what"]) == (
        "test",
        "queued",
        "2 leads from Batch 1",
    )
    # The batch isn't running and the agent isn't on its task: a test needs neither.
    _work(hub, "demo")

    [listed] = client.get(f"/api/agents/{key}/tests").json()
    assert (listed["status"], listed["done"], listed["statuses"]) == ("succeeded", 2, {"OK": 2})
    report = client.get(f"/api/agents/{key}/tests/{test['id']}").json()
    assert [(x["key"], x["lead_id"], x["result"]["status"]) for x in report["leads"]] == [
        ("T-1", "L-000001", "OK"),
        ("T-2", "L-000002", "OK"),
    ]
    with Session(clean_engine) as db:
        assert all(not lead.results for lead in db.scalars(select(Lead)))


def test_a_test_on_pasted_gbp_links_keeps_the_agents_file(
    client: TestClient, owner: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeDataForSeo({"cid:1234567890123": [INFO]})
    monkeypatch.setattr(dataforseo, "transport", httpx2.MockTransport(fake))
    monkeypatch.setattr(links, "transport", httpx2.MockTransport(lambda r: httpx2.Response(404)))
    monkeypatch.setattr(gbp_agent, "POLL_SECONDS", 0)
    values = {"dataforseo_login": "me@x.com", "dataforseo_password": "pw"}
    client.patch("/api/connections", json={"values": values})
    body = {"kind": "gbp-audit", "name": "GBP", "task_id": task_id_of(client, "gbp-audit")}
    key = client.post("/api/agents", json=body).json()["agent"]["key"]
    hub = _hub(client, key, "gbp-audit")

    links_in = ["https://maps.google.com/?cid=1234567890123", "https://example.com/nothing"]
    test = client.post(f"/api/agents/{key}/tests", json={"links": links_in}).json()
    assert test["what"] == "2 pasted GBP links"
    _work(hub, "gbp-audit")

    report = client.get(f"/api/agents/{key}/tests/{test['id']}").json()
    first, second = report["leads"]
    assert (first["lead_id"], first["gbp_link"], first["result"]["status"]) == (
        "",
        links_in[0],
        "AUDITED",
    )
    assert first["result"]["details"]["data"]["basics"]["name"] == "Shine Cleaning"
    assert first["files"] == ["gbp.json"]
    assert second["result"]["status"] == "NOT_FOUND"
    saved = client.get(f"/api/agents/{key}/tests/{test['id']}/files/T-1/gbp.json")
    assert saved.status_code == 200
    assert json.loads(saved.content)["data"]["reviews"]["latest"][0]["text"] == "Great"
    gone = client.get(f"/api/agents/{key}/tests/{test['id']}/files/T-2/gbp.json")
    assert gone.status_code == 404


def test_who_tests_and_what_a_test_refuses(
    client: TestClient, owner: User, clean_engine: Engine, make_user: UserFactory
) -> None:
    key = add_demo(client)["agent"]["key"]
    url = f"/api/agents/{key}/tests"
    # Off: like Run now, it can't be tested yet.
    assert client.post(url, json={"links": ["x"]}).json()["error"]["code"] == "agent_off"
    _hub(client, key, "demo")
    assert client.post(url, json={}).json()["error"]["fields"] == {"batch_id": "Required."}
    unknown = client.post(url, json={"lead_ids": ["L-999999"]})
    assert unknown.json()["error"]["code"] == "unknown_leads"
    assert client.post(url, json={"links": ["x"] * 11}).status_code == 422
    test = client.post(url, json={"links": ["x"]}).json()
    busy = client.post(url, json={"links": ["x"]})
    assert busy.json()["error"]["code"] == "busy"

    client.cookies.clear()
    sign_in(client, make_user(Role.VIEWER).email)
    assert client.post(url, json={"links": ["x"]}).status_code == 403
    assert client.get(f"{url}/{test['id']}").status_code == 200  # reading is for everyone
    client.cookies.clear()
    sign_in(client, make_user(Role.COLLECTOR).email)
    assert client.get(url).status_code == 403


def test_a_test_lead_is_only_the_running_tests(
    client: TestClient, owner: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    key = add_demo(client)["agent"]["key"]
    hub = _hub(client, key, "demo")
    body = {"outcome": "done", "status": "OK"}
    # No test is running: a test lead is unknown, like any lead that doesn't exist.
    status, _ = hub.call("PUT", "/leads/T-1/result", body)
    assert status == 404
    client.post(f"/api/agents/{key}/tests", json={"links": ["x"]})
    status, job = hub.call("GET", "/next-run")
    assert (status, job["test"], job["batches"]) == (200, True, [])
    assert [x["lead_id"] for x in job["test_leads"]] == ["T-1"]
    assert "source_lead_id" not in job["test_leads"][0]
    assert hub.call("PUT", "/leads/T-2/result", body)[0] == 404
    assert hub.call("PUT", "/leads/T-1/result", body)[0] == 204


def test_only_the_last_tests_keep_their_report(
    client: TestClient, owner: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(trials, "KEEP", 1)
    key = add_demo(client)["agent"]["key"]
    hub = _hub(client, key, "demo")
    client.patch(f"/api/agents/{key}", json={"config": {"seconds_per_item": 0}})
    first = client.post(f"/api/agents/{key}/tests", json={"links": ["x"]}).json()
    _work(hub, "demo")
    client.post(f"/api/agents/{key}/tests", json={"links": ["y"]})
    assert len(client.get(f"/api/agents/{key}/tests").json()) == 1
    assert client.get(f"/api/agents/{key}/tests/{first['id']}").status_code == 404
