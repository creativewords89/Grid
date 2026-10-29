"""Niches (SPEC step 33): anyone who hands in files adds one, a spelling close to a known
niche is asked about first; Owners and Admins rename (everything follows) and delete the
unused ones."""

import pytest
from fastapi.testclient import TestClient

from app.db.models import Role
from tests.conftest import Person
from tests.hub_data import batch_id
from tests.test_submissions import GOOD, hand_in

pytestmark = pytest.mark.usefixtures("files_checked")


@pytest.fixture
def owner(person: Person) -> TestClient:
    client, _ = person(Role.OWNER, "Olivia")
    batch_id(client, "Batch 01", "Cleaning")
    return client


def test_collectors_add_niches_once_and_are_asked_about_close_spellings(
    owner: TestClient, person: Person
) -> None:
    cal, _ = person(Role.COLLECTOR)
    added = cal.post("/api/niches", json={"name": "Roofing"})
    assert added.json() == {"name": "Roofing", "created": True}
    assert cal.post("/api/niches", json={"name": " roofing "}).json() == {
        "name": "Roofing",
        "created": False,
    }
    close = cal.post("/api/niches", json={"name": "Cleanning"})
    assert close.status_code == 409 and close.json()["error"]["message"] == "Did you mean Cleaning?"
    assert close.json()["error"]["details"] == {"similar": "Cleaning"}
    sure = cal.post("/api/niches", json={"name": "Cleanning", "confirm": True})
    assert sure.json()["created"] is True
    assert cal.get("/api/submissions/niches").json() == ["Cleaning", "Cleanning", "Roofing"]
    assert owner.get("/api/niches").json() == ["Cleaning", "Cleanning", "Roofing"]
    assert hand_in(cal, GOOD, niche="Roofing")["niche"] == "Roofing"


def test_who_adds_and_manages_niches(owner: TestClient, person: Person) -> None:
    viewer, _ = person(Role.VIEWER)
    rita, _ = person(Role.REVIEWER)
    cal, _ = person(Role.COLLECTOR)
    for client in (viewer, rita):
        assert client.post("/api/niches", json={"name": "HVAC"}).status_code == 403
    for client in (viewer, rita, cal):
        assert client.get("/api/niches/all").status_code == 403
    niche = owner.get("/api/niches/all").json()[0]
    assert cal.patch(f"/api/niches/{niche['id']}", json={"name": "Xyz"}).status_code == 403
    assert cal.delete(f"/api/niches/{niche['id']}").status_code == 403


def test_renaming_carries_everything_and_only_unused_niches_go(
    owner: TestClient, person: Person
) -> None:
    cal, _ = person(Role.COLLECTOR)
    file = hand_in(cal, GOOD)
    owner.post("/api/niches", json={"name": "Plumbing"})
    listed = {n["name"]: n for n in owner.get("/api/niches/all").json()}
    assert listed["Cleaning"]["uses"] >= 3  # the batch, its benchmark and the file
    assert listed["Plumbing"]["uses"] == 0

    taken = owner.patch(f"/api/niches/{listed['Cleaning']['id']}", json={"name": "plumbing"})
    assert taken.json()["error"]["code"] == "taken"
    renamed = owner.patch(
        f"/api/niches/{listed['Cleaning']['id']}", json={"name": "House Cleaning"}
    )
    assert renamed.status_code == 200, renamed.text
    assert owner.get(f"/api/submissions/{file['id']}").json()["niche"] == "House Cleaning"
    assert {b["name"]: b["niche"] for b in owner.get("/api/batches").json()} == {
        "Batch 01": "House Cleaning"
    }
    assert "Cleaning" not in owner.get("/api/niches").json()

    in_use = owner.delete(f"/api/niches/{listed['Cleaning']['id']}")
    assert in_use.json()["error"]["code"] == "in_use"
    assert owner.delete(f"/api/niches/{listed['Plumbing']['id']}").status_code == 204
    assert "Plumbing" not in owner.get("/api/niches").json()
