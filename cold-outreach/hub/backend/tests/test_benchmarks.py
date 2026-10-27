"""Benchmarks, batches and what agents read about them (SPEC sections 6.2, 6.4 and 6.5)."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.models import DoNotContact, Lead, LeadList, Role, User
from tests.conftest import UserFactory, sign_in
from tests.hub_data import GBP, WEBSITE, make_batch, make_benchmark
from tests.test_agents import MANIFEST, add_agent, agent_call


@pytest.fixture
def owner(client: TestClient, make_user: UserFactory) -> User:
    user = make_user(Role.OWNER, name="Olivia")
    sign_in(client, user.email)
    return user


# --- benchmarks -----------------------------------------------------------------------------


def test_a_benchmark_holds_gbp_numbers_and_the_website_standard(
    client: TestClient, owner: User
) -> None:
    made = make_benchmark(client)

    assert (made["name"], made["niche"], made["version"]) == ("Cleaning Benchmark 1", "Cleaning", 1)
    assert made["gbp"]["photos"] == 120
    assert made["website"]["service_page"]["min_words"] == 800
    assert made["website"]["location_page"]["min_words"] == 400  # a default
    assert made["batches"] == [] and made["can_edit"] is True
    assert [b["name"] for b in client.get("/api/benchmarks").json()] == ["Cleaning Benchmark 1"]


def test_several_benchmarks_per_niche_and_names_are_unique(client: TestClient, owner: User) -> None:
    make_benchmark(client, "Cleaning Benchmark 1")
    make_benchmark(client, "Cleaning Benchmark 2", niche="  cleaning ")

    taken = client.post(
        "/api/benchmarks",
        json={"name": "cleaning benchmark 1", "niche": "Cleaning", "website": WEBSITE},
    )

    assert (taken.status_code, taken.json()["error"]["fields"]) == (409, {"name": "Taken."})
    assert [b["niche"] for b in client.get("/api/benchmarks").json()] == ["Cleaning", "Cleaning"]
    assert client.get("/api/niches").json() == ["Cleaning"]


def test_empty_numbers_mean_dont_compare(client: TestClient, owner: User) -> None:
    response = client.post(
        "/api/benchmarks",
        json={"name": "B", "niche": "Roofing", "gbp": {"photos": 40}, "website": WEBSITE},
    )

    assert response.json()["gbp"] == {"photos": 40}


@pytest.mark.parametrize(
    ("change", "field"),
    [
        ({"gbp": GBP | {"rating": 6}}, "gbp.rating"),
        ({"gbp": {"stars": 3}}, "gbp.stars"),
        ({"website": WEBSITE | {"services": [{"name": "A"}, {"name": "a"}]}}, "website"),
        (
            {"website": WEBSITE | {"service_page": {"min_words": -1}}},
            "website.service_page.min_words",
        ),
        ({"website": WEBSITE | {"mobile_lcp_seconds": 0}}, "website.mobile_lcp_seconds"),
        ({"name": "  "}, "name"),
        ({"niche": ""}, "niche"),
    ],
)
def test_bad_benchmarks_are_refused(
    client: TestClient, owner: User, change: dict[str, Any], field: str
) -> None:
    body = {"name": "Cleaning Benchmark 1", "niche": "Cleaning", "gbp": GBP, "website": WEBSITE}

    response = client.post("/api/benchmarks", json=body | change)

    assert response.status_code == 422
    assert field in response.json()["error"]["fields"]


def test_the_website_part_needs_a_must_have_service(client: TestClient, owner: User) -> None:
    response = client.post(
        "/api/benchmarks",
        json={
            "name": "B",
            "niche": "Cleaning",
            "website": {"services": [{"name": "Carpet", "must_have": False}]},
        },
    )

    assert response.status_code == 422
    assert response.json()["error"]["message"] == "Add at least one must-have service."


def test_changing_the_numbers_raises_the_version_but_renaming_does_not(
    client: TestClient, owner: User
) -> None:
    made = make_benchmark(client)
    url = f"/api/benchmarks/{made['id']}"

    renamed = client.put(url, json={"name": "Cleaning A", "gbp": GBP, "website": WEBSITE}).json()
    changed = client.put(
        url, json={"name": "Cleaning A", "gbp": GBP | {"photos": 200}, "website": WEBSITE}
    ).json()
    again = client.put(
        url,
        json={
            "name": "Cleaning A",
            "gbp": GBP | {"photos": 200},
            "website": WEBSITE | {"blog": {}},
        },
    ).json()

    assert (renamed["name"], renamed["version"]) == ("Cleaning A", 1)
    assert (changed["gbp"]["photos"], changed["version"]) == (200, 2)
    assert again["version"] == 3
    history = client.get("/api/history", params={"entity": "benchmark"}).json()["entries"]
    assert [e["action"] for e in history] == ["edit", "edit", "edit", "create"]


def test_a_benchmark_in_use_cannot_be_deleted(client: TestClient, owner: User) -> None:
    used = make_benchmark(client)
    spare = make_benchmark(client, "Cleaning Benchmark 2")
    make_batch(client, benchmark_id=used["id"])

    refused = client.delete(f"/api/benchmarks/{used['id']}")
    deleted = client.delete(f"/api/benchmarks/{spare['id']}")

    assert (refused.status_code, refused.json()["error"]["code"]) == (409, "in_use")
    assert deleted.status_code == 204
    assert client.get(f"/api/benchmarks/{used['id']}").json()["batches"] == ["Batch 1"]


def test_admins_edit_benchmarks_and_viewers_only_look(
    client: TestClient, owner: User, make_user: UserFactory
) -> None:
    made = make_benchmark(client)
    client.cookies.clear()
    sign_in(client, make_user(Role.ADMIN).email)
    assert (
        client.put(
            f"/api/benchmarks/{made['id']}", json={"name": "X", "gbp": GBP, "website": WEBSITE}
        ).status_code
        == 200
    )

    client.cookies.clear()
    sign_in(client, make_user(Role.VIEWER).email)
    assert client.get("/api/benchmarks").json()[0]["can_edit"] is False
    assert (
        client.post("/api/benchmarks", json={"name": "Y", "niche": "Cleaning"}).status_code == 403
    )
    assert client.delete(f"/api/benchmarks/{made['id']}").status_code == 403


# --- batches --------------------------------------------------------------------------------


def test_a_batch_has_a_name_one_niche_and_a_benchmark_of_that_niche(
    client: TestClient, owner: User
) -> None:
    cleaning = make_benchmark(client)
    roofing = make_benchmark(client, "Roofing Benchmark 1", "Roofing")

    def create(**body: Any) -> Any:
        return client.post("/api/batches", json={"name": "Batch 1", "niche": "Cleaning"} | body)

    no_benchmark = create()
    wrong_niche = create(benchmark_id=roofing["id"])
    made = create(name=" Batch   1 ", niche="cleaning", benchmark_id=cleaning["id"])
    taken = create(name="batch 1", benchmark_id=cleaning["id"])

    assert no_benchmark.json()["error"]["fields"] == {"benchmark_id": "Required."}
    assert wrong_niche.json()["error"]["fields"] == {
        "benchmark_id": "This benchmark is for Roofing."
    }
    assert made.status_code == 201
    body = made.json()
    assert (body["name"], body["niche"], body["benchmark"]["name"]) == (
        "Batch 1",
        "Cleaning",
        "Cleaning Benchmark 1",
    )
    assert (body["leads"], body["files"], body["can_rename"], body["can_delete"]) == (
        0,
        0,
        True,
        True,
    )
    assert taken.status_code == 409


def test_a_batch_with_leads_keeps_its_name_but_can_change_benchmark(
    client: TestClient, owner: User, db: Session
) -> None:
    batch = make_batch(client)
    other = make_benchmark(client, "Cleaning Benchmark 2")
    db.add(
        Lead(
            lead_id="L-000001",
            batch_id=batch["id"],
            niche="Cleaning",
            city="Tulsa",
            business_name="A",
        )
    )
    db.commit()
    url = f"/api/batches/{batch['id']}"

    renamed = client.patch(url, json={"name": "New name"})
    switched = client.patch(url, json={"benchmark_id": other["id"]})
    deleted = client.delete(url)

    assert (renamed.status_code, renamed.json()["error"]["code"]) == (409, "has_leads")
    assert switched.json()["benchmark"]["name"] == "Cleaning Benchmark 2"
    assert deleted.status_code == 409


def test_an_empty_batch_can_be_renamed_and_deleted(client: TestClient, owner: User) -> None:
    batch = make_batch(client)
    token = add_agent(client)
    agent_call(client, "PUT", "/manifest", token, MANIFEST)
    client.patch("/api/agents/gbp-audit", json={"batch_ids": [batch["id"]]})
    url = f"/api/batches/{batch['id']}"

    assert client.patch(url, json={"name": "Spring"}).json()["name"] == "Spring"
    assert client.get("/api/batches").json()[0]["agents"] == ["GBP audit"]
    assert client.delete(url).status_code == 204
    assert client.get("/api/batches").json() == []
    assert client.get("/api/agents").json()[0]["batches"] == []


def test_viewers_see_batches_but_cannot_change_them(
    client: TestClient, owner: User, make_user: UserFactory
) -> None:
    batch = make_batch(client)
    client.cookies.clear()
    sign_in(client, make_user(Role.VIEWER).email)

    assert client.get("/api/batches").json()[0]["can_edit"] is False
    assert client.patch(f"/api/batches/{batch['id']}", json={"name": "X"}).status_code == 403
    assert client.post("/api/batches", json={"name": "X", "niche": "Cleaning"}).status_code == 403
    assert client.delete(f"/api/batches/{batch['id']}").status_code == 403


# --- agents and batches ---------------------------------------------------------------------


def test_an_agent_works_through_its_batches_in_order(
    client: TestClient, owner: User, db: Session
) -> None:
    first = make_batch(client, "Batch 1")
    second = make_batch(client, "Batch 2")
    token = add_agent(client)
    agent_call(client, "PUT", "/manifest", token, MANIFEST)
    client.put("/api/agents/gbp-audit/enabled", json={"enabled": True})

    saved = client.patch("/api/agents/gbp-audit", json={"batch_ids": [second["id"], first["id"]]})
    assert [b["name"] for b in saved.json()["batches"]] == ["Batch 2", "Batch 1"]
    db.add_all(
        [
            Lead(
                lead_id="L-000001",
                batch_id=second["id"],
                niche="Cleaning",
                city="Tulsa",
                business_name="A",
            ),
            Lead(
                lead_id="L-000002",
                batch_id=second["id"],
                niche="Cleaning",
                city="Dallas",
                business_name="B",
                level="Top",
            ),
            Lead(
                lead_id="L-000003",
                batch_id=first["id"],
                niche="Cleaning",
                city="Tulsa",
                business_name="C",
            ),
        ]
    )
    db.commit()
    client.post("/api/agents/gbp-audit/run")

    run = agent_call(client, "GET", "/next-run", token).json()
    assert [b["name"] for b in run["batches"]] == ["Batch 2", "Batch 1"]
    assert run["batches"][0]["benchmark_version"] == 1
    leads = agent_call(client, "GET", f"/batches/{second['id']}/leads", token).json()
    assert leads == [
        {"lead_id": "L-000001", "city": "Tulsa", "level": ""},
        {"lead_id": "L-000002", "city": "Dallas", "level": "Top"},
    ]
    benchmark = agent_call(client, "GET", f"/benchmarks/{run['batches'][0]['benchmark_id']}", token)
    assert benchmark.json()["gbp"]["photos"] == 120
    assert benchmark.json()["website"]["services"][0]["name"] == "Deep cleaning"


@pytest.mark.parametrize(
    "batch_ids",
    [["00000000-0000-0000-0000-000000000000"], "dup"],
)
def test_bad_batch_choices_are_refused(client: TestClient, owner: User, batch_ids: Any) -> None:
    batch = make_batch(client)
    add_agent(client)
    if batch_ids == "dup":
        batch_ids = [batch["id"], batch["id"]]

    response = client.patch("/api/agents/gbp-audit", json={"batch_ids": batch_ids})

    assert (response.status_code, list(response.json()["error"]["fields"])) == (422, ["batch_ids"])


def test_batches_without_a_benchmark_are_skipped_by_agents(
    client: TestClient, owner: User, db: Session
) -> None:
    """Only batches moved in from before batches can lack a benchmark."""
    from app.db.models import Batch

    old = Batch(name="Batch 1 · Cleaning", niche="Cleaning")
    db.add(old)
    db.commit()
    token = add_agent(client)
    agent_call(client, "PUT", "/manifest", token, MANIFEST)
    client.patch("/api/agents/gbp-audit", json={"batch_ids": [str(old.id)]})

    assert client.get("/api/agents").json()[0]["batches"][0]["ready"] is False
    assert agent_call(client, "GET", "/batches", token).json() == []


# --- other reference data agents read -------------------------------------------------------


def test_agents_read_lists_and_do_not_contact(client: TestClient, owner: User, db: Session) -> None:
    token = add_agent(client)
    agent_call(client, "PUT", "/manifest", token, MANIFEST)
    db.add_all(
        [
            LeadList(city="Dallas", niche="Cleaning", active=False),
            DoNotContact(kind="email", value="boss@top.com", reason="top", lead_id="L-000001"),
            DoNotContact(kind="phone", value="9185550000", reason="top", lead_id="L-000001"),
        ]
    )
    db.commit()

    assert agent_call(client, "GET", "/lists", token).json() == [
        {"city": "Dallas", "niche": "Cleaning", "active": False, "daily_limit": None}
    ]
    blocked = agent_call(
        client, "GET", "/do-not-contact/check?email=Boss@Top.com&phone=(918) 555-0000", token
    ).json()
    assert blocked["blocked"] is True and len(blocked["matches"]) == 2
    clear = agent_call(client, "GET", "/do-not-contact/check?email=someone@else.com", token)
    assert clear.json() == {"blocked": False, "matches": []}


def test_reference_data_needs_an_agent_token(client: TestClient, owner: User) -> None:
    assert client.get("/api/agent/v1/batches").status_code == 401
