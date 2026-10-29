"""Top Review (SPEC step 32): once a file handed in on Files has no error, Reviewers choose
each city's Top businesses, a city at a time; the file is ready and locked when every city
that is on has a Top, and its Tops are Top in the batch it is added to."""

from typing import Any
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from app.db.models import Role
from tests.conftest import Person
from tests.hub_data import batch_id
from tests.test_imports import STANDARD, row
from tests.test_submissions import BAD_ROW, hand_in, revise, use


def tulsa(count: int) -> list[list[Any]]:
    return [
        row(f"Shine {n}", f"https://share.google/s{n}", f"(918) 555-{n:04d}") for n in range(count)
    ]


# Tulsa is on (12 businesses), Dallas is off (2).
FILE = {
    "Tulsa": [STANDARD, *tulsa(12)],
    "Dallas": [
        STANDARD,
        row("Sparkle", "https://share.google/sp", "214 555 0100", city="Dallas"),
        row("Gleam", "https://share.google/gl", "214 555 0101", city="Dallas"),
    ],
}


@pytest.fixture
def owner(person: Person) -> TestClient:
    client, _ = person(Role.OWNER, "Olivia")
    batch_id(client, "Batch 01", "Cleaning")
    return client


def city_url(file_id: str, city: str) -> str:
    return f"/api/review/files/{file_id}/cities/{quote(city)}"


def test_a_reviewer_sees_only_top_review(owner: TestClient, person: Person) -> None:
    rita, _ = person(Role.REVIEWER, "Rita")
    for path in (
        "/api/batches",
        "/api/leads",
        "/api/imports",
        "/api/submissions",
        "/api/submissions/niches",
        "/api/agents",
        "/api/benchmarks",
    ):
        assert rita.get(path).status_code == 403, path
    assert rita.get("/api/review/files").json() == []
    collector, _ = person(Role.COLLECTOR)
    viewer, _ = person(Role.VIEWER)
    assert collector.get("/api/review/files").status_code == 403
    assert viewer.get("/api/review/files").status_code == 403


def test_tops_are_chosen_city_by_city_and_the_file_locks(
    owner: TestClient,
    person: Person,
) -> None:
    cal, _ = person(Role.COLLECTOR, "Cal")
    rita, _ = person(Role.REVIEWER, "Rita")
    bad = hand_in(cal, {"Tulsa": [*FILE["Tulsa"], BAD_ROW], "Dallas": FILE["Dallas"]})
    # A file with errors isn't in Top Review.
    assert rita.get("/api/review/files").json() == []
    assert rita.get(f"/api/review/files/{bad['id']}").status_code == 404
    fixed = revise(cal, bad["id"], FILE).json()
    assert fixed["status"] == "needs_top"
    assert (fixed["cities_on"], fixed["cities_topped"]) == (1, 0)
    # No error: the Collector's work is done, the file can't be changed by them any more.
    assert revise(cal, bad["id"], FILE).json()["error"]["code"] == "no_errors"
    assert cal.delete(f"/api/submissions/{bad['id']}").json()["error"]["code"] == "no_errors"
    assert use(owner, bad["id"]).json()["error"]["code"] == "needs_top"

    listed = rita.get("/api/review/files").json()
    assert [(f["file_name"], f["state"]) for f in listed] == [("tulsa.xlsx", "needs_top")]
    detail = rita.get(f"/api/review/files/{bad['id']}").json()
    assert [(c["name"], c["businesses"], c["state"]) for c in detail["cities"]] == [
        ("Tulsa", 12, "needs_top"),
        ("Dallas", 2, "off"),
    ]
    city = rita.get(city_url(bad["id"], "Tulsa")).json()
    assert len(city["businesses"]) == 12
    assert city["businesses"][0]["values"]["business_name"] == "Shine 0"
    assert city["businesses"][0]["values"]["phone"] == "(918) 555-0000"
    first, second = (b["key"] for b in city["businesses"][:2])
    assert first == "Tulsa row 2"
    # An off city needs no Top; a business of another city can't be chosen.
    off = rita.put(city_url(bad["id"], "Dallas"), json={"tops": []})
    assert off.json()["error"]["code"] == "city_off"
    wrong = rita.put(city_url(bad["id"], "Tulsa"), json={"tops": ["Dallas row 2"]})
    assert wrong.json()["error"]["code"] == "invalid"

    saved = rita.put(city_url(bad["id"], "Tulsa"), json={"tops": [first, second]})
    assert saved.status_code == 200, saved.text
    assert saved.json()["state"] == "done"
    # Locked: the reviewer can't open it or change it any more.
    assert rita.get(f"/api/review/files/{bad['id']}").json()["error"]["code"] == "locked"
    again = rita.put(city_url(bad["id"], "Tulsa"), json={"tops": [first]})
    assert again.json()["error"]["code"] == "locked"
    assert rita.get("/api/review/files").json()[0]["state"] == "done"
    ready = owner.get(f"/api/submissions/{bad['id']}").json()
    assert ready["status"] == "ready" and ready["cities_topped"] == 1

    # An Owner reopens it; the Tops are kept and can be changed.
    assert owner.post(f"/api/submissions/{bad['id']}/reopen").json()["status"] == "needs_top"
    assert rita.get(city_url(bad["id"], "Tulsa")).json()["businesses"][1]["top"] is True
    assert rita.put(city_url(bad["id"], "Tulsa"), json={"tops": [first]}).status_code == 200

    # Added to the batch: the chosen business is Top there, its city Ready.
    import_id = use(owner, bad["id"]).json()["batch"]["import_id"]
    assert owner.get(f"/api/imports/{import_id}").json()["counts"]["top"] == 1
    assert owner.post(f"/api/imports/{import_id}/confirm").status_code == 200
    leads = owner.get("/api/leads", params={"batch_id": batch_id(owner, "Batch 01")}).json()
    tops = [lead["business_name"] for lead in leads["leads"] if lead["level"] == "Top"]
    assert tops == ["Shine 0"]
    cities = owner.get(f"/api/batches/{batch_id(owner, 'Batch 01')}/cities").json()
    assert {c["city"]: c["ready"] for c in cities}["Tulsa"] is True


def test_a_file_whose_cities_are_all_small_is_ready_at_once(
    owner: TestClient,
    person: Person,
) -> None:
    cal, _ = person(Role.COLLECTOR)
    small = hand_in(cal, {"Dallas": FILE["Dallas"]})
    assert small["status"] == "ready" and small["cities_on"] == 0


def test_only_owners_and_admins_reopen(owner: TestClient, person: Person) -> None:
    cal, _ = person(Role.COLLECTOR)
    rita, _ = person(Role.REVIEWER)
    small = hand_in(cal, {"Dallas": FILE["Dallas"]})
    assert cal.post(f"/api/submissions/{small['id']}/reopen").status_code == 403
    assert rita.post(f"/api/submissions/{small['id']}/reopen").status_code == 403
    needs = hand_in(cal, FILE, name="b.xlsx")
    assert owner.post(f"/api/submissions/{needs['id']}/reopen").status_code == 409
