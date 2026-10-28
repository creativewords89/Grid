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


def add_task(
    client: TestClient,
    batch: str,
    job: str,
    needs: list[str] | None = None,
    name: str | None = None,
) -> Any:
    """Add a task of this job to the batch, needing the batch's tasks of these jobs."""
    body: dict[str, Any] = {
        "task_id": task_id_of(client, job),
        "needs": [task_id_of(client, key) for key in needs or []],
    }
    if name is not None:
        body["name"] = name
    return client.post(f"/api/batches/{batch}/tasks", json=body)


def tasks_of(client: TestClient, batch: str) -> list[tuple[int, str, list[str]]]:
    """(step, name, needs) of each task of the batch."""
    steps = client.get(f"/api/batches/{batch}/pipeline").json()["steps"]
    return [
        (s["step"], t["name"], [n["name"] for n in t["needs"]]) for s in steps for t in s["tasks"]
    ]


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


def test_an_agent_names_its_job_and_the_hub_keeps_it(client: TestClient, owner: User) -> None:
    bot(client, "gbp-1", "gbp-audit")
    bot(client, "plain", "")  # no job named: its own key
    token = add_agent(client, "web-1")
    agent_call(
        client,
        "PUT",
        "/manifest",
        token,
        dict(MANIFEST, task="website-audit", task_name="Website Audit"),
    )

    jobs = {t["key"]: t for t in client.get("/api/tasks").json()}

    assert jobs["gbp-audit"]["name"] == "Gbp Audit"  # from the key
    assert jobs["website-audit"]["name"] == "Website Audit"  # from the manifest
    assert [b["key"] for b in jobs["gbp-audit"]["bots"]] == ["gbp-1"]
    assert [b["key"] for b in jobs["plain"]["bots"]] == ["plain"]
    assert client.post("/api/tasks", json={"key": "x-y", "name": "X"}).status_code == 405
    agent = next(a for a in client.get("/api/agents").json() if a["key"] == "web-1")
    assert agent["task"] == {"key": "website-audit", "name": "Website Audit"}


def test_a_batchs_tasks_need_its_own_tasks_without_circles(client: TestClient, owner: User) -> None:
    for key, job in (("gbp-1", "gbp-audit"), ("web-1", "website-audit"), ("opp-1", "opportunity")):
        bot(client, key, job)
    batch = make_batch(client)["id"]
    assert add_task(client, batch, "gbp-audit").status_code == 201

    early = add_task(client, batch, "opportunity", needs=["website-audit"])
    assert (early.status_code, early.json()["error"]["fields"]) == (
        422,
        {"needs": "Not a task of this batch."},
    )
    add_task(client, batch, "website-audit")
    made = add_task(client, batch, "opportunity", ["gbp-audit", "website-audit"], "Find angles")
    assert made.status_code == 201
    assert tasks_of(client, batch) == [
        (1, "Gbp Audit", []),
        (1, "Website Audit", []),
        (2, "Find angles", ["Gbp Audit", "Website Audit"]),
    ]
    assert add_task(client, batch, "gbp-audit").status_code == 409  # a job once per batch

    gbp, opp = task_id_of(client, "gbp-audit"), task_id_of(client, "opportunity")
    circle = client.patch(f"/api/batches/{batch}/tasks/{gbp}", json={"needs": [opp]})
    assert (circle.status_code, circle.json()["error"]["code"]) == (422, "circle")
    itself = client.patch(f"/api/batches/{batch}/tasks/{gbp}", json={"needs": [gbp]})
    assert itself.status_code == 422
    assert client.delete(f"/api/batches/{batch}/tasks/{gbp}").status_code == 409  # needed
    renamed = client.patch(
        f"/api/batches/{batch}/tasks/{opp}", json={"name": "  Angles  ", "needs": [gbp]}
    )
    assert renamed.status_code == 200
    assert tasks_of(client, batch)[-1] == (2, "Angles", ["Gbp Audit"])
    assert client.delete(f"/api/batches/{batch}/tasks/{opp}").status_code == 200


def test_needs_differ_from_batch_to_batch(client: TestClient, owner: User, db: Session) -> None:
    gbp = bot(client, "gbp-1", "gbp-audit")
    bot(client, "web-1", "website-audit")
    opp = bot(client, "opp-1", "opportunity")
    first, second = make_batch(client, "Batch 1")["id"], make_batch(client, "Batch 2")["id"]
    for batch in (first, second):
        add_task(client, batch, "gbp-audit")
        add_task(client, batch, "website-audit")
    add_task(client, first, "opportunity", ["gbp-audit", "website-audit"])
    add_task(client, second, "opportunity", ["gbp-audit"])
    leads(db, first, 1)
    db.add(
        Lead(lead_id="L-000009", batch_id=second, niche="Cleaning", city="Tulsa", business_name="B")
    )
    db.commit()
    for batch in (first, second):
        put_bot(client, batch, "gbp-1", "gbp-audit")
        put_bot(client, batch, "opp-1", "opportunity")
    result(client, gbp, "L-000001")
    result(client, gbp, "L-000009")

    assert ready(client, opp, first) == []  # still waits for its Website Audit
    assert ready(client, opp, second) == ["L-000009"]  # needs only the GBP Audit here


def test_a_new_manifest_task_moves_the_bot(client: TestClient, owner: User) -> None:
    token = bot(client, "gbp-1", "gbp-audit")
    batch = make_batch(client)["id"]
    put_bot(client, batch, "gbp-1", "gbp-audit")

    agent_call(client, "PUT", "/manifest", token, dict(MANIFEST, task="website-audit"))

    steps = client.get(f"/api/batches/{batch}/pipeline").json()["steps"]
    assert steps[0]["tasks"][0]["bots"] == []
    assert client.get("/api/agents").json()[0]["task"]["key"] == "website-audit"


# --- a batch's tasks and bots -----------------------------------------------------------------


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
    batch = make_batch(client)["id"]
    leads(db, batch, 2, top=1)
    put_bot(client, batch, "gbp-1", "gbp-audit")
    put_bot(client, batch, "gbp-2", "gbp-audit")
    add_task(client, batch, "opportunity", ["gbp-audit"])
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
    assert client.get("/api/tasks").is_success
    assert client.get(f"/api/batches/{batch}/results", params={"bot": "gbp-1"}).is_success
    refused = [
        client.patch(f"/api/batches/{batch}/tasks/{gbp}", json={"name": "Y"}),
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

    marked = client.post(
        "/api/leads/top",
        json={
            "batch_id": batch,
            "city": "Tulsa",
            "lead_ids": ["L-000002", "L-000003"],
            "top": True,
        },
    )
    assert marked.json() == {"changed": 2}

    assert ready(client, token, batch) == ["L-000001"]
    shown = client.get(f"/api/batches/{batch}/results", params={"bot": "gbp-1"}).json()
    assert shown["total"] == 0  # Top leads are left out; the saved result stays on the lead
    assert db.get(Lead, "L-000003").results["gbp-1"]["score"] == 50  # type: ignore[union-attr]


def test_the_agents_screen_says_where_an_agent_is_used(client: TestClient, owner: User) -> None:
    bot(client, "gbp-1", "gbp-audit")
    batch = make_batch(client)["id"]
    add_task(client, batch, "gbp-audit", name="Profile check")
    put_bot(client, batch, "gbp-1", "gbp-audit")

    agent = client.get("/api/agents").json()[0]

    assert agent["task"]["name"] == "Gbp Audit"
    assert [(b["name"], b["task_name"], b["status"]) for b in agent["batches"]] == [
        ("Batch 1", "Profile check", "running")
    ]
