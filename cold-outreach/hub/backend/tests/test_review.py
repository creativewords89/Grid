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
from app.db.models import FileCity, Role, Submission
from app.imports import file_checker, file_cities
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
    # The niche's batch is there since the file was handed in, still without leads.
    [waiting] = owner.get("/api/batches").json()
    assert (waiting["name"], waiting["leads"], waiting["files"]) == ("Cleaning", 0, 1)
    _age(clean_engine, sub["id"], 1.01)
    with Session(clean_engine) as db:
        file_checker.send_due(db)
        db.commit()

    # The niche's batch, named after it, with its only benchmark, gets the city.
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


def test_top_review_never_reads_the_file_again(
    owner: TestClient, person: Person, clean_engine: Engine
) -> None:
    """A big file is checked once: Top Review lists and opens its cities from what the check
    saved, without its content (megabytes for hundreds of cities)."""
    cal, _ = person(Role.COLLECTOR)
    rita, _ = person(Role.REVIEWER)
    sub = hand_in(cal, FILE)
    with Session(clean_engine) as db:
        found = db.get(Submission, sub["id"])
        assert found is not None
        found.content = b"not read again"
        found.leads = []  # its cities were made ready when it was sent on (step 41)
        db.commit()
    assert [c["name"] for c in rita.get("/api/review/cities").json()["cities"]] == ["Tulsa"]
    city = rita.get(city_url(sub["id"], "Tulsa")).json()
    assert len(city["businesses"]) == 12
    saved = rita.put(city_url(sub["id"], "Tulsa"), json={"tops": [city["businesses"][0]["key"]]})
    assert saved.json()["state"] == "ready"


def test_a_city_shows_most_reviews_first(owner: TestClient, person: Person) -> None:
    """Step 41: businesses come most reviews first. (Step 53: reviews aren't a benchmark, so
    no business is marked a likely Top.)"""
    cal, _ = person(Role.COLLECTOR)
    rita, _ = person(Role.REVIEWER)
    many = [
        row(f"Shine {n}", f"https://share.google/s{n}", f"(918) 555-{n:04d}", reviews=str(10 * n))
        for n in range(12)
    ]
    many[3] = row(
        "Star Co", "https://share.google/star", "(918) 555-9999", reviews="900", rating="4.9"
    )
    sub = hand_in(cal, {"Tulsa": [STANDARD, *many]})
    city = rita.get(city_url(sub["id"], "Tulsa")).json()
    assert city["businesses"][0]["values"]["business_name"] == "Star Co"
    assert "likely" not in city["businesses"][0] and "benchmark" not in city


def test_cities_under_10_are_ticked_on_one_page_and_saved_at_once(
    owner: TestClient, person: Person
) -> None:
    cal, _ = person(Role.COLLECTOR)
    rita, _ = person(Role.REVIEWER)
    viewer, _ = person(Role.VIEWER)
    sub = hand_in(cal, FILE)  # Dallas has 2 businesses
    small = {
        "Waco": [STANDARD, row("Wave", "https://share.google/wv", "254 555 0100", city="Waco")]
    }
    other = hand_in(cal, small, name="waco.xlsx")
    assert viewer.get("/api/review/small").status_code == 403
    page = rita.get("/api/review/small").json()
    assert page["total"] == 2
    assert [(c["name"], len(c["businesses_list"])) for c in page["cities"]] == [
        ("Dallas", 2),
        ("Waco", 1),
    ]
    picks = [
        {
            "file_id": sub["id"],
            "city": "Dallas",
            "tops": [page["cities"][0]["businesses_list"][0]["key"]],
        },
        {
            "file_id": other["id"],
            "city": "Waco",
            "tops": [page["cities"][1]["businesses_list"][0]["key"]],
        },
    ]
    saved = rita.put("/api/review/tops", json={"cities": picks})
    assert saved.json() == {"saved": 2}
    assert rita.get("/api/review/small").json()["total"] == 0
    ready = rita.get("/api/review/cities", params={"show": "ready"}).json()["cities"]
    assert sorted(c["name"] for c in ready) == ["Dallas", "Waco"]
    wrong = [{"file_id": sub["id"], "city": "Dallas", "tops": ["Nowhere row 9"]}]
    assert rita.put("/api/review/tops", json={"cities": wrong}).status_code == 422


def test_a_city_in_its_batch_is_sent_back_to_top_review(
    owner: TestClient, person: Person, clean_engine: Engine
) -> None:
    """Step 43: an Owner or Admin sends a city in its batch back to Top Review: its leads in
    the batch go with their results, and it comes back without a Top (it goes on only once
    a Top is chosen again)."""
    cal, _ = person(Role.COLLECTOR)
    rita, _ = person(Role.REVIEWER)
    sub = hand_in(cal, FILE)
    key = rita.get(city_url(sub["id"], "Tulsa")).json()["businesses"][0]["key"]
    rita.put(city_url(sub["id"], "Tulsa"), json={"tops": [key]})
    rita.post(f"/api/submissions/{sub['id']}/to-batch", json={"city": "tulsa"})
    [batch] = owner.get("/api/batches").json()
    assert batch["leads"] == 12
    url = f"/api/submissions/{sub['id']}/cities/tulsa/send-back"
    assert cal.post(url).status_code == 403
    assert rita.post(url).status_code == 403

    back = owner.post(url)
    assert back.status_code == 200, back.text
    assert back.json()["cities_in_batch"] == 0
    assert owner.get("/api/batches").json()[0]["leads"] == 0
    assert owner.get(f"/api/batches/{batch['id']}/cities").json() == []
    listed = rita.get("/api/review/cities").json()["cities"]
    assert [(c["name"], c["tops"]) for c in listed] == [("Tulsa", 0)]
    # Not moved again by itself: it waits for a Top.
    with Session(clean_engine) as db:
        assert file_cities.move_due(db) == 0
    assert owner.post(url).json()["error"]["code"] == "not_in_batch"


def test_a_city_taken_out_on_batches_loses_its_top(owner: TestClient, person: Person) -> None:
    """Deleting a city's file on Batches mutes the city and takes its Top: unmuted, it
    doesn't go straight back to the batch."""
    cal, _ = person(Role.COLLECTOR)
    rita, _ = person(Role.REVIEWER)
    sub = hand_in(cal, FILE)
    key = rita.get(city_url(sub["id"], "Tulsa")).json()["businesses"][0]["key"]
    rita.put(city_url(sub["id"], "Tulsa"), json={"tops": [key]})
    rita.post(f"/api/submissions/{sub['id']}/to-batch", json={"city": "tulsa"})
    [batch] = owner.get("/api/batches").json()
    [imp] = owner.get("/api/imports", params={"batch_id": batch["id"]}).json()
    assert owner.delete(f"/api/imports/{imp['id']}").status_code == 204
    tulsa = next(
        c
        for c in owner.get(f"/api/submissions/{sub['id']}").json()["cities"]
        if c["key"] == "tulsa"
    )
    assert (tulsa["state"], tulsa["tops"]) == ("muted", 0)
    assert owner.post(f"/api/submissions/{sub['id']}/cities/tulsa/unmute").status_code == 200
    again = next(c for c in rita.get("/api/review/cities").json()["cities"] if c["key"] == "tulsa")
    assert again["state"] == "needs_top"


def test_a_city_is_sent_back_from_its_batchs_files(owner: TestClient, person: Person) -> None:
    cal, _ = person(Role.COLLECTOR)
    rita, _ = person(Role.REVIEWER)
    sub = hand_in(cal, FILE)
    key = rita.get(city_url(sub["id"], "Tulsa")).json()["businesses"][0]["key"]
    rita.put(city_url(sub["id"], "Tulsa"), json={"tops": [key]})
    rita.post(f"/api/submissions/{sub['id']}/to-batch", json={"city": "tulsa"})
    [batch] = owner.get("/api/batches").json()
    [imp] = owner.get("/api/imports", params={"batch_id": batch["id"]}).json()
    assert imp["from_top_review"] is True
    viewer, _ = person(Role.VIEWER)
    assert viewer.post(f"/api/imports/{imp['id']}/send-back").status_code == 403
    assert owner.post(f"/api/imports/{imp['id']}/send-back").status_code == 204
    assert [c["name"] for c in rita.get("/api/review/cities").json()["cities"]] == ["Tulsa"]


def test_files_in_top_review_by_niche_and_one_files_cities(
    owner: TestClient, person: Person
) -> None:
    """Step 45: Top Review lists its files (by niche, with their cities' counts); a file's
    cities open on their own, in the three lists."""
    make_benchmark(owner, "Roofing Benchmark 1", "Roofing")
    cal, _ = person(Role.COLLECTOR, "Cal")
    rita, _ = person(Role.REVIEWER)
    viewer, _ = person(Role.VIEWER)
    first = hand_in(cal, FILE)
    waco = [
        row(f"Wave {n}", f"https://share.google/wv{n}", f"(254) 555-{n:04d}", city="Waco")
        for n in range(10)
    ]
    second = hand_in(cal, {"Waco": [STANDARD, *waco]}, niche="Roofing", name="waco.xlsx")
    assert viewer.get("/api/review/files").status_code == 403
    files = rita.get("/api/review/files").json()
    assert [(f["niche"], f["file_name"], f["uploaded_by"], f["counts"]) for f in files] == [
        ("Cleaning", "tulsa.xlsx", "Cal", {"needs_top": 1, "ready": 0, "small": 1}),
        ("Roofing", "waco.xlsx", "Cal", {"needs_top": 1, "ready": 0, "small": 0}),
    ]
    one = rita.get("/api/review/cities", params={"file_id": first["id"]}).json()
    assert one["counts"] == {"needs_top": 1, "ready": 0, "small": 1}
    assert [c["name"] for c in one["cities"]] == ["Tulsa"]
    other = rita.get("/api/review/cities", params={"file_id": second["id"]}).json()
    assert [c["name"] for c in other["cities"]] == ["Waco"]
    small = rita.get("/api/review/small", params={"file_id": second["id"]}).json()
    assert small["total"] == 0
    assert rita.get("/api/review/small", params={"file_id": first["id"]}).json()["total"] == 1


def test_a_batch_shows_its_files_and_a_files_cities(owner: TestClient, person: Person) -> None:
    """Step 46: a niche's batch lists the files its cities came from; a file opens to its
    cities in the batch."""
    cal, _ = person(Role.COLLECTOR, "Cal")
    rita, _ = person(Role.REVIEWER)
    viewer, _ = person(Role.VIEWER)
    sub = hand_in(cal, FILE)
    key = rita.get(city_url(sub["id"], "Tulsa")).json()["businesses"][0]["key"]
    rita.put(city_url(sub["id"], "Tulsa"), json={"tops": [key]})
    rita.post(f"/api/submissions/{sub['id']}/to-batch", json={"city": "tulsa"})
    [batch] = owner.get("/api/batches").json()
    assert cal.get(f"/api/batches/{batch['id']}/files").status_code == 403
    [found] = viewer.get(f"/api/batches/{batch['id']}/files").json()
    assert {k: found[k] for k in ("file_name", "uploaded_by", "cities", "leads", "top")} == {
        "file_name": "tulsa.xlsx",
        "uploaded_by": "Cal",
        "cities": 1,
        "leads": 12,
        "top": 1,
    }
    assert found["done_pct"] is None  # no agent on the batch yet
    [city] = viewer.get(f"/api/batches/{batch['id']}/files/{sub['id']}/cities").json()
    assert (city["name"], city["leads"], city["top"], city["active"]) == ("Tulsa", 12, 1, True)
    assert city["list_id"] is not None and city["problems"] == 0
    other = owner.get(f"/api/batches/{batch['id']}/files/{batch['id']}/cities")
    assert other.status_code == 404


def test_a_niches_batch_comes_with_its_first_file_and_goes_with_its_last(
    owner: TestClient, person: Person
) -> None:
    """Step 47: Files, Top Review and Batches show the same niches. A niche's batch is made
    when its first file is handed in and shows the file at once; one left without files,
    leads or a start goes."""
    cal, _ = person(Role.COLLECTOR, "Cal")
    viewer, _ = person(Role.VIEWER)
    sub = hand_in(cal, FILE)
    [batch] = viewer.get("/api/batches").json()
    assert (batch["name"], batch["niche"], batch["leads"], batch["files"]) == (
        "Cleaning",
        "Cleaning",
        0,
        1,
    )
    assert batch["benchmark"]["name"] == "Cleaning Benchmark 1"
    assert batch["can_delete"] is False  # its niche has a file
    [found] = viewer.get(f"/api/batches/{batch['id']}/files").json()
    assert (found["file_name"], found["cities"], found["leads"]) == ("tulsa.xlsx", 0, 0)
    assert found["cities_in_review"] == 1 and found["in_files"] is False
    cities = viewer.get(f"/api/batches/{batch['id']}/files/{sub['id']}/cities")
    assert cities.status_code == 404  # none of its cities is in the batch yet

    # A second file of the niche goes to the same batch.
    hand_in(
        cal,
        {"Waco": [STANDARD, row("Glow", "https://share.google/gw", "254 555 0100", city="Waco")]},
        name="waco.xlsx",
    )
    [batch] = viewer.get("/api/batches").json()
    assert batch["files"] == 2

    # Its niche changed: the new niche gets its batch, the old one keeps the other file.
    owner.post("/api/niches", json={"name": "Construction"})
    moved = owner.patch(f"/api/submissions/{sub['id']}/niche", json={"niche": "Construction"})
    assert moved.status_code == 200, moved.text
    shown = {b["name"]: b["files"] for b in viewer.get("/api/batches").json()}
    assert shown == {"Cleaning": 1, "Construction": 1}

    # The niche's last file deleted: its unused batch goes.
    waco = next(f for f in owner.get("/api/submissions").json() if f["file_name"] == "waco.xlsx")
    assert owner.delete(f"/api/submissions/{waco['id']}").status_code == 204
    assert [b["name"] for b in viewer.get("/api/batches").json()] == ["Construction"]


def test_a_batch_with_leads_stays_when_its_niche_has_no_file(
    owner: TestClient, person: Person
) -> None:
    cal, _ = person(Role.COLLECTOR)
    rita, _ = person(Role.REVIEWER)
    sub = hand_in(cal, FILE)
    key = rita.get(city_url(sub["id"], "Tulsa")).json()["businesses"][0]["key"]
    rita.put(city_url(sub["id"], "Tulsa"), json={"tops": [key]})
    rita.post(f"/api/submissions/{sub['id']}/to-batch", json={"city": "tulsa"})
    owner.post("/api/niches", json={"name": "Construction"})
    moved = owner.patch(f"/api/submissions/{sub['id']}/niche", json={"niche": "Construction"})
    assert moved.status_code == 200, moved.text
    shown = {b["name"]: (b["leads"], b["files"]) for b in owner.get("/api/batches").json()}
    # Tulsa stays in Cleaning with its leads; the file now shows in both.
    assert shown == {"Cleaning": (12, 1), "Construction": (0, 1)}
