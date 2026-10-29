"""Batch names for files (SPEC step 38): each file handed in is for the batch named after its
niche and a number, never given twice; a ready file is added to that batch, which is made
when there is none."""

import pytest
from fastapi.testclient import TestClient

from app.db.models import Role
from tests.conftest import Person
from tests.hub_data import make_benchmark
from tests.test_submissions import BAD, GOOD, hand_in

pytestmark = pytest.mark.usefixtures("files_checked")


@pytest.fixture
def owner(person: Person) -> TestClient:
    client, _ = person(Role.OWNER, "Olivia")
    make_benchmark(client, "Cleaning Benchmark 1", "Cleaning")
    return client


def test_each_file_is_for_the_next_batch_of_its_niche(owner: TestClient, person: Person) -> None:
    cal, _ = person(Role.COLLECTOR, "Cal")
    owner.post("/api/niches", json={"name": "Roofing"})
    first = hand_in(cal, GOOD)
    second = hand_in(cal, GOOD, name="b.xlsx")
    roofing = hand_in(cal, GOOD, niche="Roofing", name="r.xlsx")
    assert (first["batch_label"], second["batch_label"], roofing["batch_label"]) == (
        "Cleaning 01",
        "Cleaning 02",
        "Roofing 01",
    )
    # A number is never given twice, even after its file is deleted.
    assert owner.delete(f"/api/submissions/{second['id']}").status_code == 204
    assert hand_in(cal, GOOD, name="c.xlsx")["batch_label"] == "Cleaning 03"
    # Renaming the niche renames the batch names.
    niche = next(n for n in owner.get("/api/niches/all").json() if n["name"] == "Roofing")
    owner.patch(f"/api/niches/{niche['id']}", json={"name": "Roof Repair"})
    assert owner.get(f"/api/submissions/{roofing['id']}").json()["batch_label"] == "Roof Repair 01"


def test_a_ready_file_goes_to_its_batch_made_when_there_is_none(
    owner: TestClient, person: Person
) -> None:
    cal, _ = person(Role.COLLECTOR)
    ready = hand_in(cal, GOOD)
    assert ready["status"] == "ready"
    added = owner.post(f"/api/submissions/{ready['id']}/add", json={})
    assert added.status_code == 200, added.text
    assert added.json()["status"] == "adding"
    assert added.json()["batch"]["batch_name"] == "Cleaning 01"
    batches = {b["name"]: b for b in owner.get("/api/batches").json()}
    assert batches["Cleaning 01"]["benchmark"]["name"] == "Cleaning Benchmark 1"
    # The next file of the batch name already made goes to that same batch.
    import_id = added.json()["batch"]["import_id"]
    owner.post(f"/api/imports/{import_id}/discard")
    again = owner.post(f"/api/submissions/{ready['id']}/add", json={})
    assert again.json()["batch"]["batch_id"] == batches["Cleaning 01"]["id"]


def test_the_benchmark_is_asked_for_when_the_niche_has_several(
    owner: TestClient, person: Person
) -> None:
    make_benchmark(owner, "Cleaning Benchmark 2", "Cleaning")
    cal, _ = person(Role.COLLECTOR)
    ready = hand_in(cal, GOOD)
    asked = owner.post(f"/api/submissions/{ready['id']}/add", json={})
    assert asked.json()["error"]["code"] == "choose_benchmark"
    choices = asked.json()["error"]["details"]["benchmarks"]
    assert [c["name"] for c in choices] == ["Cleaning Benchmark 1", "Cleaning Benchmark 2"]
    assert owner.get("/api/batches").json() == []  # nothing made yet
    chosen = owner.post(
        f"/api/submissions/{ready['id']}/add", json={"benchmark_id": choices[1]["id"]}
    )
    assert chosen.status_code == 200
    assert owner.get("/api/batches").json()[0]["benchmark"]["name"] == "Cleaning Benchmark 2"


def test_only_a_ready_file_is_added_and_only_by_owners_and_admins(
    owner: TestClient, person: Person
) -> None:
    cal, _ = person(Role.COLLECTOR)
    owner.post("/api/niches", json={"name": "Roofing"})
    waiting = hand_in(cal, GOOD, send=False)  # in its Final check
    assert owner.post(f"/api/submissions/{waiting['id']}/add", json={}).status_code == 409
    bad = hand_in(cal, BAD, name="bad.xlsx")
    assert owner.post(f"/api/submissions/{bad['id']}/add", json={}).status_code == 409
    assert cal.post(f"/api/submissions/{bad['id']}/add", json={}).status_code == 403
    roofing = hand_in(cal, GOOD, niche="Roofing", name="r.xlsx")
    none = owner.post(f"/api/submissions/{roofing['id']}/add", json={})
    assert none.json()["error"]["code"] == "no_benchmark"
