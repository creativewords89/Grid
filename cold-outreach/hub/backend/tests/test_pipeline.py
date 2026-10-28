"""Tasks, bots and the batch pipeline (SPEC section 6.7)."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.models import Lead, Role, User
from tests.conftest import UserFactory, sign_in
from tests.hub_data import GBP, WEBSITE, make_batch, put_bot, task_id_of
from tests.test_agents import MANIFEST, add_agent, agent_call


@pytest.fixture
def owner(client: TestClient, make_user: UserFactory) -> User:
    user = make_user(Role.OWNER, name="Olivia")
    sign_in(client, user.email)
    return user


def bot(client: TestClient, key: str, task: str) -> str:
    """An agent whose manifest says it does `task`."""
    token = add_agent(client, key)
    response = agent_call(client, "PUT", "/manifest", token, dict(MANIFEST, task=task))
    assert response.status_code == 200, response.text
    return token


def task(client: TestClient, key: str, name: str, needs: list[str] | None = None) -> Any:
    existing = [t for t in client.get("/api/tasks").json() if t["key"] == key]
    if existing:
        return client.patch(f"/api/tasks/{existing[0]['id']}", json={"needs": needs or []})
    return client.post("/api/tasks", json={"key": key, "name": name, "needs": needs or []})


def leads(db: Session, batch: str, count: int, top: int = 0) -> None:
    db.add_all(
        Lead(
            lead_id=f"L-{n:06d}",
            batch_id=batch,
            niche="Cleaning",
            city="Tulsa",
            business_name=f"Business {n}",
            level="Top" if n > count else "",
        )
        for n in range(1, count + top + 1)
    )
    db.commit()


def ready(client: TestClient, token: str, batch: str) -> list[str]:
    response = agent_call(client, "GET", f"/batches/{batch}/leads", token)
    assert response.status_code == 200, response.text
    return [x["lead_id"] for x in response.json()]


def result(client: TestClient, token: str, lead: str, outcome: str = "done", **extra: Any) -> None:
    body = {"outcome": outcome, "status": "OK", **extra}
    response = agent_call(client, "PUT", f"/leads/{lead}/result", token, body)
    assert response.status_code == 204, response.text


# --- tasks ----------------------------------------------------------------------------------


def test_a_bot_names_its_task_and_the_hub_makes_it(client: TestClient, owner: User) -> None:
    bot(client, "gbp-1", "gbp-audit")
    bot(client, "plain", "")  # no task named: its own key

    tasks = {t["key"]: t for t in client.get("/api/tasks").json()}

    assert tasks["gbp-audit"]["name"] == "Gbp audit"
    assert [b["key"] for b in tasks["gbp-audit"]["bots"]] == ["gbp-1"]
    assert [b["key"] for b in tasks["plain"]["bots"]] == ["plain"]
    agent = next(a for a in client.get("/api/agents").json() if a["key"] == "gbp-1")
    assert agent["task"] == {"key": "gbp-audit", "name": "Gbp audit"}


def test_tasks_need_known_tasks_without_circles(client: TestClient, owner: User) -> None:
    assert task(client, "gbp-audit", "GBP Audit").status_code == 201
    assert task(client, "opportunity", "Opportunity Finder", ["gbp-audit"]).status_code == 201

    assert task(client, "x", "X", ["nothing"]).status_code == 422
    circle = task(client, "gbp-audit", "GBP Audit", ["opportunity"])
    assert (circle.status_code, circle.json()["error"]["code"]) == (422, "circle")
    itself = task(client, "gbp-audit", "GBP Audit", ["gbp-audit"])
    assert itself.status_code == 422
    taken = client.post("/api/tasks", json={"key": "gbp-audit", "name": "Other"})
    assert taken.status_code == 409
    listed = client.get("/api/tasks").json()
    assert [t["key"] for t in listed] == ["gbp-audit", "opportunity"]  # by step
    assert listed[1]["needs"] == [{"key": "gbp-audit", "name": "GBP Audit"}]


def test_a_task_is_deleted_only_when_unused(client: TestClient, owner: User) -> None:
    task(client, "gbp-audit", "GBP Audit")
    task(client, "opportunity", "Opportunity Finder", ["gbp-audit"])
    bot(client, "opp-1", "opportunity")
    gbp, opp = task_id_of(client, "gbp-audit"), task_id_of(client, "opportunity")

    assert client.delete(f"/api/tasks/{gbp}").status_code == 409  # needed by another
    assert client.delete(f"/api/tasks/{opp}").status_code == 409  # a bot does it
    task(client, "spare", "Spare")
    assert client.delete(f"/api/tasks/{task_id_of(client, 'spare')}").status_code == 204


def test_a_new_manifest_task_moves_the_bot(client: TestClient, owner: User) -> None:
    token = bot(client, "gbp-1", "gbp-audit")
    batch = make_batch(client)["id"]
    put_bot(client, batch, "gbp-1", "gbp-audit")

    agent_call(client, "PUT", "/manifest", token, dict(MANIFEST, task="website-audit"))

    steps = client.get(f"/api/batches/{batch}/pipeline").json()["steps"]
    assert steps[0]["tasks"][0]["bots"] == []
    assert client.get("/api/agents").json()[0]["task"]["key"] == "website-audit"


# --- a batch's tasks and bots -----------------------------------------------------------------


def test_tasks_are_added_after_what_they_need(client: TestClient, owner: User) -> None:
    task(client, "gbp-audit", "GBP Audit")
    task(client, "opportunity", "Opportunity Finder", ["gbp-audit"])
    batch = make_batch(client)["id"]
    gbp, opp = task_id_of(client, "gbp-audit"), task_id_of(client, "opportunity")

    early = client.post(f"/api/batches/{batch}/tasks", json={"task_id": opp})
    assert (early.status_code, early.json()["error"]["code"]) == (409, "needs_missing")
    client.post(f"/api/batches/{batch}/tasks", json={"task_id": gbp})
    shown = client.post(f"/api/batches/{batch}/tasks", json={"task_id": opp}).json()

    assert [(s["step"], [t["key"] for t in s["tasks"]]) for s in shown["steps"]] == [
        (1, ["gbp-audit"]),
        (2, ["opportunity"]),
    ]
    assert shown["steps"][0]["tasks"][0]["can_remove"] is False
    assert client.delete(f"/api/batches/{batch}/tasks/{gbp}").status_code == 409
    assert client.delete(f"/api/batches/{batch}/tasks/{opp}").status_code == 200
    # a task in a batch can't get a need the batch lacks
    task(client, "website-audit", "Website Audit")
    again = client.patch(f"/api/tasks/{gbp}", json={"needs": ["website-audit"]})
    assert (again.status_code, again.json()["error"]["code"]) == (409, "missing_in_batch")


def test_only_bots_of_the_task_can_be_added(client: TestClient, owner: User) -> None:
    bot(client, "gbp-1", "gbp-audit")
    bot(client, "web-1", "website-audit")
    batch = make_batch(client)["id"]
    gbp = task_id_of(client, "gbp-audit")
    client.post(f"/api/batches/{batch}/tasks", json={"task_id": gbp})

    wrong = client.post(f"/api/batches/{batch}/tasks/{gbp}/bots", json={"key": "web-1"})
    assert (wrong.status_code, wrong.json()["error"]["code"]) == (409, "wrong_task")
    assert client.post(f"/api/batches/{batch}/tasks/{gbp}/bots", json={"key": "gbp-1"}).is_success
    twice = client.post(f"/api/batches/{batch}/tasks/{gbp}/bots", json={"key": "gbp-1"})
    assert twice.status_code == 409


def test_start_needs_a_task_with_a_bot_and_pause_stops_handing_out(
    client: TestClient, owner: User, db: Session
) -> None:
    token = bot(client, "gbp-1", "gbp-audit")
    batch = make_batch(client)["id"]
    leads(db, batch, 1)
    assert client.post(f"/api/batches/{batch}/start").status_code == 409
    assert client.get(f"/api/batches/{batch}").json()["status"] == "not_started"
    put_bot(client, batch, "gbp-1", "gbp-audit", start=False)
    assert ready(client, token, batch) == []  # not started yet

    client.post(f"/api/batches/{batch}/start")
    assert ready(client, token, batch) == ["L-000001"]
    assert [b["name"] for b in agent_call(client, "GET", "/batches", token).json()] == ["Batch 1"]
    assert client.post(f"/api/batches/{batch}/pause").json()["batch"]["status"] == "paused"
    assert ready(client, token, batch) == []
    assert agent_call(client, "GET", "/batches", token).json() == []
    other = make_batch(client, "Batch 2")["id"]
    assert agent_call(client, "GET", f"/batches/{other}/leads", token).status_code == 404


# --- per business -----------------------------------------------------------------------------


def test_every_bot_checks_every_business_and_the_next_task_waits_per_business(
    client: TestClient, owner: User, db: Session
) -> None:
    gbp1 = bot(client, "gbp-1", "gbp-audit")
    gbp2 = bot(client, "gbp-2", "gbp-audit")
    opp = bot(client, "opp-1", "opportunity")
    task(client, "opportunity", "Opportunity Finder", ["gbp-audit"])
    batch = make_batch(client)["id"]
    leads(db, batch, 2, top=1)
    put_bot(client, batch, "gbp-1", "gbp-audit")
    put_bot(client, batch, "gbp-2", "gbp-audit")
    put_bot(client, batch, "opp-1", "opportunity")

    assert ready(client, gbp1, batch) == ready(client, gbp2, batch) == ["L-000001", "L-000002"]
    assert ready(client, opp, batch) == []
    result(client, gbp1, "L-000001", score=30)
    assert ready(client, opp, batch) == []  # the other GBP bot hasn't finished it
    result(client, gbp2, "L-000001", "skipped")
    result(client, gbp1, "L-000002", "failed")

    handed = agent_call(client, "GET", f"/batches/{batch}/leads", opp).json()
    assert [x["lead_id"] for x in handed] == ["L-000001"]
    assert handed[0]["needed_results"]["gbp-1"]["score"] == 30
    assert ready(client, gbp1, batch) == ["L-000002"]  # failed: tried again

    steps = client.get(f"/api/batches/{batch}/pipeline").json()["steps"]
    counts = {
        b["key"]: (b["done"], b["failed"], b["ready"], b["waiting"])
        for s in steps
        for t in s["tasks"]
        for b in t["bots"]
    }
    assert counts == {
        "gbp-1": (1, 1, 0, 0),
        "gbp-2": (1, 0, 1, 0),
        "opp-1": (0, 0, 1, 1),
    }


def test_split_bots_share_the_businesses(client: TestClient, owner: User, db: Session) -> None:
    friendly = bot(client, "mail-friendly", "outreach")
    report = bot(client, "mail-report", "outreach")
    batch = make_batch(client)["id"]
    leads(db, batch, 4)
    put_bot(client, batch, "mail-friendly", "outreach", share="split")
    put_bot(client, batch, "mail-report", "outreach")

    first = ready(client, friendly, batch)
    second = ready(client, report, batch)
    assert len(first) == len(second) == 2 and not set(first) & set(second)
    assert ready(client, friendly, batch) == first  # kept
    result(client, report, second[0])

    outreach = task_id_of(client, "outreach")
    shown = client.delete(f"/api/batches/{batch}/tasks/{outreach}/bots/mail-report").json()
    assert [b["key"] for b in shown["steps"][0]["tasks"][0]["bots"]] == ["mail-friendly"]
    # the lead it finished stays with it; the one it hadn't goes to the other bot
    assert sorted(ready(client, friendly, batch)) == sorted([*first, second[1]])


def test_a_new_benchmark_version_checks_the_business_again(
    client: TestClient, owner: User, db: Session
) -> None:
    token = bot(client, "gbp-1", "gbp-audit")
    made = make_batch(client)
    batch, benchmark = made["id"], made["benchmark"]
    leads(db, batch, 1)
    put_bot(client, batch, "gbp-1", "gbp-audit")
    result(client, token, "L-000001", benchmark_id=benchmark["id"], benchmark_version=1)
    assert ready(client, token, batch) == []

    changed = client.put(
        f"/api/benchmarks/{benchmark['id']}",
        json={"name": benchmark["name"], "gbp": GBP | {"photos": 5}, "website": WEBSITE},
    )
    assert changed.json()["version"] == 2

    assert ready(client, token, batch) == ["L-000001"]


def test_results_of_one_bot(client: TestClient, owner: User, db: Session) -> None:
    token = bot(client, "gbp-1", "gbp-audit")
    batch = make_batch(client)["id"]
    leads(db, batch, 4)
    put_bot(client, batch, "gbp-1", "gbp-audit")
    result(client, token, "L-000001", score=20, summary="Few photos")
    result(client, token, "L-000002", score=55)
    result(client, token, "L-000003", "failed")
    url = f"/api/batches/{batch}/results"

    shown = client.get(url, params={"bot": "gbp-1"}).json()
    assert shown["outcomes"] == {"done": 2, "skipped": 0, "failed": 1, "not_yet": 1}
    assert shown["bands"] == {"low": 1, "mid": 1, "high": 0}
    assert [r["lead_id"] for r in shown["leads"]] == ["L-000001", "L-000002", "L-000003"]
    assert shown["leads"][0]["summary"] == "Few photos"
    low = client.get(url, params={"bot": "gbp-1", "band": "low"}).json()
    assert [r["lead_id"] for r in low["leads"]] == ["L-000001"]
    waiting = client.get(url, params={"bot": "gbp-1", "outcome": "not_yet"}).json()
    assert [r["lead_id"] for r in waiting["leads"]] == ["L-000004"]
    listed = client.get("/api/batches").json()[0]
    assert (listed["status"], listed["progress_pct"]) == ("running", 50)


# --- rights -----------------------------------------------------------------------------------


def test_viewers_see_pipelines_but_cannot_change_them(
    client: TestClient, owner: User, make_user: UserFactory
) -> None:
    bot(client, "gbp-1", "gbp-audit")
    batch = make_batch(client)["id"]
    gbp = task_id_of(client, "gbp-audit")
    viewer = make_user(Role.VIEWER, name="Vic")
    sign_in(client, viewer.email)

    assert client.get(f"/api/batches/{batch}/pipeline").json()["can_start"] is False
    assert client.get("/api/tasks").json()[0]["can_edit"] is False
    assert client.get(f"/api/batches/{batch}/results", params={"bot": "gbp-1"}).is_success
    refused = [
        client.post("/api/tasks", json={"key": "x-y", "name": "X"}),
        client.patch(f"/api/tasks/{gbp}", json={"name": "Y"}),
        client.delete(f"/api/tasks/{gbp}"),
        client.post(f"/api/batches/{batch}/tasks", json={"task_id": gbp}),
        client.patch(f"/api/batches/{batch}/tasks/{gbp}", json={"share": "split"}),
        client.delete(f"/api/batches/{batch}/tasks/{gbp}"),
        client.post(f"/api/batches/{batch}/tasks/{gbp}/bots", json={"key": "gbp-1"}),
        client.delete(f"/api/batches/{batch}/tasks/{gbp}/bots/gbp-1"),
        client.post(f"/api/batches/{batch}/start"),
        client.post(f"/api/batches/{batch}/pause"),
        client.put("/api/batches/order", json={"ids": [batch]}),
    ]
    assert [r.status_code for r in refused] == [403] * len(refused)


def test_admins_run_batches(client: TestClient, owner: User, make_user: UserFactory) -> None:
    bot(client, "gbp-1", "gbp-audit")
    batch = make_batch(client)["id"]
    admin = make_user(Role.ADMIN, name="Ada")
    sign_in(client, admin.email)

    assert put_bot(client, batch, "gbp-1", "gbp-audit")["batch"]["status"] == "running"
    assert client.post("/api/tasks", json={"key": "extra", "name": "Extra"}).status_code == 201


def test_a_city_switched_off_in_a_batch_is_left_alone_there(
    client: TestClient, owner: User, db: Session
) -> None:
    from app.db.models import LeadList

    token = bot(client, "gbp-1", "gbp-audit")
    batch = make_batch(client)["id"]
    leads(db, batch, 2)
    lead = db.get(Lead, "L-000002")
    assert lead is not None
    lead.city = "Dallas"
    db.add_all(
        [
            LeadList(batch_id=batch, city="Tulsa", niche="Cleaning"),
            LeadList(batch_id=batch, city="dallas", niche="Cleaning", active=False),
        ]
    )
    db.commit()
    put_bot(client, batch, "gbp-1", "gbp-audit")

    assert ready(client, token, batch) == ["L-000001"]


def test_leads_marked_top_in_the_hub_are_not_handed_out(
    client: TestClient, owner: User, db: Session
) -> None:
    token = bot(client, "gbp-1", "gbp-audit")
    batch = make_batch(client)["id"]
    leads(db, batch, 3)
    put_bot(client, batch, "gbp-1", "gbp-audit")
    result(client, token, "L-000003", score=50)

    client.post("/api/leads/top", json={"lead_ids": ["L-000002", "L-000003"], "top": True})

    assert ready(client, token, batch) == ["L-000001"]
    shown = client.get(f"/api/batches/{batch}/results", params={"bot": "gbp-1"}).json()
    assert shown["total"] == 0  # Top leads are left out; the saved result stays on the lead
    assert db.get(Lead, "L-000003").results["gbp-1"]["score"] == 50  # type: ignore[union-attr]
