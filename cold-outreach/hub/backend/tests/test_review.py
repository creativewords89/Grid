"""Top Review (SPEC steps 32 and 39): once a file handed in on Files is past its Final check
without errors, Reviewers choose each city's Top businesses, a city at a time. A city with a
Top is ready and goes on to its niche's batch an hour later, or when someone sends it now;
only its businesses are saved there, its Top as Top."""

from datetime import timedelta
from typing import Any
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.auth.tokens import now
from app.db.models import FileCity, Role
from app.imports import file_checker
from tests.conftest import Person
from tests.hub_data import make_benchmark
from tests.test_imports import STANDARD, row
from tests.test_submissions import BAD_ROW, hand_in, revise

pytestmark = pytest.mark.usefixtures("files_checked")


def tulsa(count: int, first: int = 0) -> list[list[Any]]:
    return [
        row(f"Shine {n}", f"https://share.google/s{n}", f"(918) 555-{n:04d}")
        for n in range(first, first + count)
    ]


# Tulsa needs a Top (12 businesses), Dallas is under 10 (2).
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
    make_benchmark(client, "Cleaning Benchmark 1", "Cleaning")
    return client


def city_url(file_id: str, city: str) -> str:
    return f"/api/review/files/{file_id}/cities/{quote(city)}"


def listed(client: TestClient, show: str = "needs_top") -> list[tuple[str, str, int]]:
    body = client.get("/api/review/cities", params={"show": show}).json()
    return [(c["file_name"], c["name"], c["tops"]) for c in body["cities"]]


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
    empty = rita.get("/api/review/cities").json()
    assert empty == {"counts": {"needs_top": 0, "ready": 0, "small": 0}, "cities": []}
    collector, _ = person(Role.COLLECTOR)
    viewer, _ = person(Role.VIEWER)
    assert collector.get("/api/review/cities").status_code == 403
    assert viewer.get("/api/review/cities").status_code == 403


def test_tops_are_chosen_city_by_city(owner: TestClient, person: Person) -> None:
    cal, _ = person(Role.COLLECTOR, "Cal")
    rita, _ = person(Role.REVIEWER, "Rita")
    bad = hand_in(cal, {"Tulsa": [*FILE["Tulsa"], BAD_ROW], "Dallas": FILE["Dallas"]})
    # A file with errors isn't in Top Review, nor one in its Final check.
    assert listed(rita) == []
    assert rita.get(city_url(bad["id"], "Tulsa")).status_code == 404
    waiting = revise(cal, bad["id"], FILE, send=False).json()
    assert waiting["status"] == "final_check" and listed(rita) == []
    cal.post(f"/api/submissions/{bad['id']}/send")
    sent = cal.get(f"/api/submissions/{bad['id']}").json()
    assert sent["status"] == "top_review"
    assert (sent["cities_going"], sent["cities_ready"], sent["cities_in_batch"]) == (1, 0, 0)

    # Three lists: not ready, ready and the cities under 10.
    counts = rita.get("/api/review/cities").json()["counts"]
    assert counts == {"needs_top": 1, "ready": 0, "small": 1}
    assert listed(rita) == [("tulsa.xlsx", "Tulsa", 0)]
    assert listed(rita, "small") == [("tulsa.xlsx", "Dallas", 0)]
    city = rita.get(city_url(bad["id"], "Tulsa")).json()
    assert len(city["businesses"]) == 12 and city["state"] == "needs_top"
    assert city["businesses"][0]["values"]["business_name"] == "Shine 0"
    first, second = (b["key"] for b in city["businesses"][:2])
    assert first == "Tulsa row 2"
    wrong = rita.put(city_url(bad["id"], "Tulsa"), json={"tops": ["Dallas row 2"]})
    assert wrong.json()["error"]["code"] == "invalid"

    saved = rita.put(city_url(bad["id"], "Tulsa"), json={"tops": [first, second]})
    assert saved.status_code == 200, saved.text
    assert saved.json()["state"] == "ready" and saved.json()["moves_at"] is not None
    assert 3500 <= saved.json()["moves_in"] <= 3600  # by the server's clock
    assert listed(rita, "ready") == [("tulsa.xlsx", "Tulsa", 2)]
    assert rita.get(city_url(bad["id"], "Tulsa")).json()["businesses"][1]["top"] is True
    # Without a Top it isn't ready any more; a city under 10 with a Top is.
    cleared = rita.put(city_url(bad["id"], "Tulsa"), json={"tops": []}).json()
    assert cleared["state"] == "needs_top" and cleared["moves_at"] is None
    dallas = rita.get(city_url(bad["id"], "Dallas")).json()
    small = rita.put(city_url(bad["id"], "Dallas"), json={"tops": [dallas["businesses"][0]["key"]]})
    assert small.json()["state"] == "ready"
    assert listed(rita, "small") == []
    detail = owner.get(f"/api/submissions/{bad['id']}").json()
    assert (detail["cities_going"], detail["cities_ready"]) == (2, 1)


def _age(engine: Engine, file_id: str, hours: float) -> None:
    """Make the file's ready cities ready since `hours` ago."""
    with Session(engine) as db:
        for city in db.scalars(select(FileCity).where(FileCity.submission_id == file_id)):
            if city.topped_at is not None:
                city.topped_at = now() - timedelta(hours=hours)
        db.commit()


def test_a_ready_city_goes_on_to_its_niche_batch_after_an_hour(
    owner: TestClient, person: Person, clean_engine: Engine
) -> None:
    cal, _ = person(Role.COLLECTOR, "Cal")
    rita, _ = person(Role.REVIEWER, "Rita")
    sub = hand_in(cal, FILE)
    first = rita.get(city_url(sub["id"], "Tulsa")).json()["businesses"][0]["key"]
    rita.put(city_url(sub["id"], "Tulsa"), json={"tops": [first]})
    with Session(clean_engine) as db:
        file_checker.send_due(db)
        db.commit()
    assert owner.get("/api/batches").json() == []  # not an hour yet
    _age(clean_engine, sub["id"], 1.01)
    with Session(clean_engine) as db:
        file_checker.send_due(db)
        db.commit()

    # The niche's batch is made, named after it, with its only benchmark.
    [batch] = owner.get("/api/batches").json()
    assert (batch["name"], batch["niche"], batch["leads"], batch["top"]) == (
        "Cleaning",
        "Cleaning",
        12,
        1,
    )
    assert batch["benchmark"]["name"] == "Cleaning Benchmark 1"
    cities = owner.get(f"/api/batches/{batch['id']}/cities").json()
    assert [(c["city"], c["leads"]) for c in cities] == [("Tulsa", 12)]
    leads = owner.get("/api/leads", params={"batch_id": batch["id"]}).json()["leads"]
    assert [x["business_name"] for x in leads if x["level"] == "Top"] == ["Shine 0"]
    [imported] = owner.get("/api/imports", params={"batch_id": batch["id"]}).json()
    assert imported["file_name"] == "tulsa.xlsx · Tulsa" and imported["uploaded_by"] == "Cal"

    # In the batch: out of Top Review, its Top no longer changed here.
    assert listed(rita, "ready") == []
    again = rita.put(city_url(sub["id"], "Tulsa"), json={"tops": []})
    assert again.json()["error"]["code"] == "in_batch"
    done = owner.get(f"/api/submissions/{sub['id']}").json()
    assert done["status"] == "in_batch" and done["cities_in_batch"] == 1
    assert owner.delete(f"/api/submissions/{sub['id']}").json()["error"]["code"] == "in_batch"

    # Another file's Austin goes to the same batch; Tulsa there is muted.
    more = {
        "Austin": [
            STANDARD,
            *(
                row(f"Bloom {n}", f"https://share.google/b{n}", f"(512) 555-{n:04d}", city="Austin")
                for n in range(10)
            ),
        ],
        "Tulsa": [STANDARD, *tulsa(10, first=20)],
    }
    second = hand_in(cal, more, name="more.xlsx")
    tulsa_city = next(c for c in second["cities"] if c["name"] == "Tulsa")
    assert tulsa_city["state"] == "muted" and "in the batch" in tulsa_city["muted"]
    austin = rita.get(city_url(second["id"], "Austin")).json()["businesses"][0]["key"]
    rita.put(city_url(second["id"], "Austin"), json={"tops": [austin]})
    sent = rita.post(f"/api/submissions/{second['id']}/to-batch", json={"city": "austin"})
    assert sent.status_code == 200, sent.text
    [batch] = owner.get("/api/batches").json()
    assert batch["leads"] == 22
    cities = owner.get(f"/api/batches/{batch['id']}/cities").json()
    assert sorted(c["city"] for c in cities) == ["Austin", "Tulsa"]


def test_who_sends_ready_cities_now(owner: TestClient, person: Person) -> None:
    cal, _ = person(Role.COLLECTOR, "Cal")
    dana, _ = person(Role.COLLECTOR, "Dana")
    viewer, _ = person(Role.VIEWER)
    rita, _ = person(Role.REVIEWER)
    sub = hand_in(cal, FILE)
    url = f"/api/submissions/{sub['id']}/to-batch"
    # Nothing is ready yet.
    assert cal.post(url, json={}).json()["error"]["code"] == "not_ready"
    for city in ("Tulsa", "Dallas"):
        key = rita.get(city_url(sub["id"], city)).json()["businesses"][0]["key"]
        rita.put(city_url(sub["id"], city), json={"tops": [key]})
    assert owner.get(f"/api/submissions/{sub['id']}").json()["can_send_cities"] is True
    assert viewer.get(f"/api/submissions/{sub['id']}").json()["can_send_cities"] is False
    assert viewer.post(url, json={}).status_code == 403
    assert dana.post(url, json={}).status_code == 404
    one = cal.post(url, json={"city": "Dallas"})
    assert one.status_code == 200, one.text
    states = {c["name"]: c["state"] for c in one.json()["cities"]}
    assert states == {"Dallas": "in_batch", "Tulsa": "ready"}
    rest = owner.post(url, json={})
    assert rest.status_code == 200 and rest.json()["status"] == "in_batch"


def test_a_niche_without_one_benchmark_gets_a_batch_without_one(
    owner: TestClient, person: Person
) -> None:
    make_benchmark(owner, "Cleaning Benchmark 2", "Cleaning")
    cal, _ = person(Role.COLLECTOR)
    rita, _ = person(Role.REVIEWER)
    sub = hand_in(cal, FILE)
    key = rita.get(city_url(sub["id"], "Tulsa")).json()["businesses"][0]["key"]
    rita.put(city_url(sub["id"], "Tulsa"), json={"tops": [key]})
    assert rita.post(f"/api/submissions/{sub['id']}/to-batch", json={}).status_code == 200
    [batch] = owner.get("/api/batches").json()
    assert batch["name"] == "Cleaning" and batch["benchmark"] is None
