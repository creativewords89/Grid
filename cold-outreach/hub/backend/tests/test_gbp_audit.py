"""The GBP audit agent, step 48 (`agents/gbp-audit/SPEC.md`): a lead's GBP link becomes the
profile's ID, DataForSEO's Standard queue gives the profile, posts and latest reviews, and
what was collected is saved as the lead's result and a gbp.json file. Nothing is scored."""

import base64
import json
import threading
from datetime import UTC, datetime
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from app import runner
from app.builtin import KINDS, runner_token
from app.builtin.gbp import agent, collect, compare, dataforseo, links
from app.db.models import Lead, Role, User
from tests.conftest import UserFactory, sign_in
from tests.hub_data import make_batch, put_bot, task_id_of
from tests.test_builtin import ClientHub

TODAY = datetime(2026, 10, 30, tzinfo=UTC)

INFO: dict[str, Any] = {
    "type": "google_business_info",
    "title": "Shine Cleaning",
    "description": "Shine has cleaned homes in Tulsa since 2010.",
    "category": "House cleaning service",
    "additional_categories": ["Commercial cleaning service", "Carpet cleaning service"],
    "cid": "1234567890123",
    "place_id": "ChIJabcdefghijk",
    "address": "12 Main St, Tulsa, OK 74103",
    "phone": "+19185550100",
    "url": "https://shine.example",
    "latitude": 36.15,
    "longitude": -95.99,
    "is_claimed": True,
    "total_photos": 48,
    "logo": "https://img.example/logo.jpg",
    "main_image": "https://img.example/cover.jpg",
    "rating": {"value": 4.7, "votes_count": 126},
    "rating_distribution": {"1": 3, "2": 3, "3": 5, "4": 15, "5": 100},
    "attributes": {"available_attributes": {"payments": ["pay_credit_card"]}},
    "local_business_links": [{"type": "reservation", "url": "https://book.example"}],
    "people_also_search": [{"title": "Gleam Maids"}],
    "last_updated_time": "2026-09-12 10:00:00 +00:00",
    "check_url": "https://www.google.com/maps?cid=1234567890123",
    "work_time": {
        "work_hours": {
            "timetable": {
                "monday": [{"open": {"hour": 8, "minute": 0}, "close": {"hour": 18, "minute": 0}}]
            },
            "current_status": "open",
        }
    },
}
POSTS = [
    {
        "items": [
            {
                "type": "google_business_post",
                "post_text": "Fall deep clean special",
                "url": "https://posts.example/1",
                "images_url": "https://img.example/p1.jpg",
                "timestamp": "2026-10-01 08:00:00 +00:00",
                "links": [{"type": "button", "title": "Book"}],
            },
            {
                "type": "google_business_post",
                "post_text": "Summer",
                "timestamp": "2026-06-01 08:00:00 +00:00",
            },
        ]
    }
]
REVIEWS = [
    {
        "items": [
            {
                "rating": {"value": 5},
                "review_text": "Great",
                "timestamp": "2026-10-20 08:00:00 +00:00",
                "owner_answer": "Thanks!",
            },
            {"rating": {"value": 1}, "review_text": "Late", "timestamp": "2026-09-01 08:00:00"},
        ]
    }
]


# --- the link to the profile's ID -----------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "keyword"),
    [
        ("https://maps.google.com/?cid=1234567890123", "cid:1234567890123"),
        ("https://www.google.com/search?q=x&ludocid=987654321", "cid:987654321"),
        (
            "https://www.google.com/maps/place/Shine/@36.1,-95.9,17z/data=!4m6!3m5!1s"
            "0x87b6eb0c2d2c7b4f:0x1a2b3c4d5e6f7a8b!8m2",
            f"cid:{int('1a2b3c4d5e6f7a8b', 16)}",
        ),
        ("https://www.google.com/maps/search/?api=1&query_place_id=ChIJabcdefghijk", None),
    ],
)
def test_a_full_maps_link_names_its_profile(url: str, keyword: str | None) -> None:
    found = links.read(url)
    assert found is not None
    assert found.keyword == (keyword or "place_id:ChIJabcdefghijk")


def test_a_short_link_is_followed_to_its_profile(monkeypatch: pytest.MonkeyPatch) -> None:
    hops = {
        "https://share.google/abc": "https://maps.app.goo.gl/xyz",
        "https://maps.app.goo.gl/xyz": "https://www.google.com/maps?cid=555666777888",
    }

    def answer(request: httpx2.Request) -> httpx2.Response:
        target = hops.get(str(request.url))
        if target:
            return httpx2.Response(302, headers={"location": target})
        return httpx2.Response(200, text="a page")

    monkeypatch.setattr(links, "transport", httpx2.MockTransport(answer))
    found = links.resolve("share.google/abc")
    assert found is not None and found.keyword == "cid:555666777888"
    assert links.resolve("https://example.com/shine") is None  # not Google: no profile in it
    assert links.resolve("https://share.google/gone") is None  # a page without an ID


# --- what is collected ------------------------------------------------------------------------


def test_the_profile_posts_and_reviews_are_collected_without_a_score() -> None:
    data = collect.collect(INFO, POSTS, REVIEWS, TODAY)

    basics = data["basics"]
    assert (basics["name"], basics["claimed"], basics["phone"], basics["website"]) == (
        "Shine Cleaning",
        True,
        "+19185550100",
        "https://shine.example",
    )
    assert basics["address"] == "12 Main St, Tulsa, OK 74103"
    assert basics["hours"]["monday"] == "08:00–18:00" and basics["hours"]["sunday"] == "closed"
    assert (basics["status"], basics["booking_link"]) == ("open", "https://book.example")
    assert basics["payments"] == ["pay_credit_card"]
    assert basics["people_also_search"] == ["Gleam Maids"]
    assert data["categories"] == {
        "primary": "House cleaning service",
        "additional": ["Commercial cleaning service", "Carpet cleaning service"],
        "services": None,  # DataForSEO gives none: unable to verify
    }
    assert data["description"]["length"] == len(INFO["description"])
    assert data["photos"] == {
        "total": 48,
        "logo": "https://img.example/logo.jpg",
        "cover": "https://img.example/cover.jpg",
    }
    posts = data["posts"]
    assert (posts["count"], posts["last"], posts["last_30_days"], posts["last_90_days"]) == (
        2,
        "2026-10-01",
        1,
        1,
    )
    assert posts["items"][0] == {
        "date": "2026-10-01",
        "text": "Fall deep clean special",
        "url": "https://posts.example/1",
        "image": True,
        "button": "Book",
    }
    reviews = data["reviews"]
    assert (reviews["count"], reviews["rating"], reviews["last"]) == (126, 4.7, "2026-10-20")
    assert (reviews["reply_pct"], reviews["unanswered_low"]) == (50, 1)
    assert "categories.services" in data["unknown"]
    assert collect.summary(data) == (
        "Collected: claimed · category House cleaning service · 48 photos · "
        "last post 2026-10-01 (1 in 90 days) · 126 reviews, 4.7★."
    )


def test_what_is_missing_is_unknown_not_a_problem() -> None:
    data = collect.collect({"title": "Bare"}, None, None, TODAY)
    assert data["basics"]["claimed"] is None and data["posts"] is None
    assert {"basics.claimed", "basics.phone", "photos.total"} <= set(data["unknown"])
    assert collect.summary(data).startswith("Collected: claimed: unknown · no category")


# --- a run ------------------------------------------------------------------------------------


class FakeDataForSeo:
    """DataForSEO's Standard queue: each task is ready on its second fetch."""

    def __init__(self, infos: dict[str, list[dict[str, Any]]]) -> None:
        self.infos = infos  # the keyword asked -> its items
        self.tasks: dict[str, dict[str, Any]] = {}
        self.fetched: dict[str, int] = {}
        self.posted: list[tuple[str, dict[str, Any]]] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        path = request.url.path.removeprefix("/v3/")
        if (
            request.headers.get("authorization")
            != "Basic " + base64.b64encode(b"me@x.com:pw").decode()
        ):
            return httpx2.Response(401, json={"status_code": 40100})
        if path.endswith("/task_post"):
            endpoint = path.removesuffix("/task_post")
            answered = []
            for task in json.loads(request.content):
                task_id = f"t{len(self.tasks)}"
                self.tasks[task_id] = {"endpoint": endpoint, **task}
                self.posted.append((endpoint, task))
                answered.append({"id": task_id, "status_code": 20100, "cost": 0.002})
            return httpx2.Response(200, json={"status_code": 20000, "tasks": answered})
        endpoint, _, task_id = path.rpartition("/task_get/")
        task = self.tasks[task_id]
        self.fetched[task_id] = self.fetched.get(task_id, 0) + 1
        if self.fetched[task_id] == 1:
            return httpx2.Response(
                200, json={"status_code": 20000, "tasks": [{"status_code": 40602}]}
            )
        if endpoint == dataforseo.INFO:
            items = self.infos.get(task["keyword"])
            if items is None:
                answer: dict[str, Any] = {"status_code": 40102}
            else:
                answer = {"status_code": 20000, "result": [{"items": items}]}
        else:
            answer = {
                "status_code": 20000,
                "result": POSTS if endpoint == dataforseo.POSTS else REVIEWS,
            }
        return httpx2.Response(200, json={"status_code": 20000, "tasks": [answer]})


@pytest.fixture
def owner(client: TestClient, make_user: UserFactory) -> User:
    user = make_user(Role.OWNER, name="Olivia")
    sign_in(client, user.email)
    return user


def _lead(n: int, batch: str, link: str, **data: str) -> Lead:
    return Lead(
        lead_id=f"L-{n:06d}",
        batch_id=batch,
        niche="Cleaning",
        city="Tulsa",
        business_name=data.pop("name", f"Business {n}"),
        gbp_link=link,
        data=data,
    )


def _run(
    client: TestClient,
    clean_engine: Engine,
    monkeypatch: pytest.MonkeyPatch,
    fake: FakeDataForSeo,
    connected: bool = True,
) -> list[dict[str, Any]]:
    monkeypatch.setattr(dataforseo, "transport", httpx2.MockTransport(fake))
    monkeypatch.setattr(links, "transport", httpx2.MockTransport(lambda r: httpx2.Response(404)))
    monkeypatch.setattr(agent, "POLL_SECONDS", 0)
    monkeypatch.setattr(runner, "get_engine", lambda: clean_engine)
    if connected:
        values = {"dataforseo_login": "me@x.com", "dataforseo_password": "pw"}
        assert client.patch("/api/connections", json={"values": values}).status_code == 200
    body = {"kind": "gbp-audit", "name": "GBP", "task_id": task_id_of(client, "gbp-audit")}
    added = client.post("/api/agents", json=body)
    assert added.status_code == 201, added.text
    key = added.json()["agent"]["key"]
    batch = make_batch(client)["id"]
    with Session(clean_engine) as db:
        db.add_all(
            [
                _lead(1, batch, "https://maps.google.com/?cid=1234567890123", phone="9185550100"),
                _lead(2, batch, ""),
                _lead(3, batch, "https://example.com/x", name="Gleam Maids", address="1 Elm"),
                _lead(4, batch, "https://example.com/y", name="Other Co", address="2 Oak"),
                _lead(5, batch, "https://maps.google.com/?cid=999"),
                # Tulsa's Top: the city is ready, so its leads are handed out.
                Lead(
                    lead_id="L-00000T",
                    batch_id=batch,
                    niche="Cleaning",
                    city="Tulsa",
                    business_name="Top business",
                    level="Top",
                ),
            ]
        )
        db.commit()
    put_bot(client, batch, key, "gbp-audit")
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
    hub.call("PUT", "/manifest", KINDS["gbp-audit"].manifest | {"task": "gbp-audit"})
    client.put(f"/api/agents/{key}/enabled", json={"enabled": True})
    assert client.post(f"/api/agents/{key}/run").status_code == 201
    stop = threading.Event()

    def stop_when_idle(method: str, path: str, body: Any = None) -> tuple[int, Any]:
        status, reply = ClientHub.call(hub, method, path, body)
        if path == "/next-run" and status == 204:
            stop.set()
        return status, reply

    hub.call = stop_when_idle  # type: ignore[method-assign]
    runner.run_agent(hub, KINDS["gbp-audit"], "gbp-audit", stop, 0)  # type: ignore[arg-type]
    agents = client.get("/api/agents").json()
    return [a for a in agents if a["key"] == key]


def test_a_run_collects_each_lead_and_saves_its_file(
    client: TestClient, owner: User, clean_engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    closed = {
        **INFO,
        "title": "Gleam Maids",
        "cid": "42",
        "work_time": {"work_hours": {"current_status": "closed_forever"}},
    }
    fake = FakeDataForSeo(
        {
            "cid:1234567890123": [INFO],
            "Gleam Maids, 1 Elm": [closed],  # found by name and address: the same name
            "Other Co, 2 Oak": [INFO],  # found by name, but another business
        }
    )
    [found] = _run(client, clean_engine, monkeypatch, fake)

    last = found["last_run"]
    assert (last["status"], last["done"], last["skipped"], last["failed"]) == ("succeeded", 4, 1, 0)
    with Session(clean_engine) as db:
        results = {
            lead.lead_id: lead.results[found["key"]]
            for lead in db.query(Lead).all()
            if lead.results
        }
    assert {k: r["status"] for k, r in results.items()} == {
        "L-000001": "AUDITED",
        "L-000002": "NO_GBP_LINK",
        "L-000003": "CLOSED",
        "L-000004": "NOT_FOUND",
        "L-000005": "NOT_FOUND",
    }
    one = results["L-000001"]
    assert isinstance(one["score"], float) and one["summary"].startswith("Score ")
    # Compared with the batch's benchmark, so it is checked again when that changes.
    benchmark = client.get("/api/benchmarks").json()[0]
    assert (one["benchmark_id"], one["benchmark_version"]) == (benchmark["id"], 1)
    assert one["details"]["benchmark"]["name"] == benchmark["name"]
    data = one["details"]["data"]
    assert data["basics"]["website"] == "https://shine.example"
    assert "latest" not in data["reviews"]  # the full reviews are in gbp.json
    assert all(task["priority"] == 1 for _, task in fake.posted)  # the Standard queue
    # Posts and reviews are asked by the profile's CID, never for a closed one.
    asked = [(e, t["keyword"]) for e, t in fake.posted if e != dataforseo.INFO]
    assert sorted(asked) == [
        (dataforseo.POSTS, "cid:1234567890123"),
        (dataforseo.REVIEWS, "cid:1234567890123"),
    ]
    files = client.get("/api/leads/L-000001").json()["files"]
    assert [f["name"] for f in files] == ["gbp.json"]
    saved = client.get(f"/api/leads/L-000001/files/{files[0]['id']}").json()
    assert saved["data"]["reviews"]["latest"][0]["text"] == "Great"
    assert saved["findings"] and saved["score"] == one["score"]


def test_a_run_without_the_dataforseo_key_fails_at_once(
    client: TestClient, owner: User, clean_engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeDataForSeo({})
    [found] = _run(client, clean_engine, monkeypatch, fake, connected=False)
    assert found["last_run"]["status"] in ("failed", "stopped")
    assert fake.posted == []


BENCHMARK = {
    "photos": 100,
    "posts_90_days": 12,
    "additional_categories": 4,
    "description_length": 600,
    "primary_categories": ["House cleaning service"],
    "reviews": 200,
}


def test_the_profile_is_compared_with_the_benchmark_into_findings_and_a_score() -> None:
    """Step 51: the lead ÷ the benchmark (red under 25%, orange to 60%), what the profile
    misses, and a score over what could be checked; reviews shown, never scored."""
    data = collect.collect(INFO, POSTS, REVIEWS, TODAY)
    found = compare.compare(data, BENCHMARK)

    bad = [(f["severity"], f["code"], f["value"], f["benchmark"]) for f in found["findings"]]
    assert bad[:4] == [
        ("red", "GBP_SHORT_DESCRIPTION", len(INFO["description"]), 600.0),
        ("red", "GBP_FEW_RECENT_POSTS", 1, 12.0),
        ("orange", "GBP_FEW_CATEGORIES", 2, 4.0),
        ("orange", "GBP_FEW_PHOTOS", 48, 100.0),
    ]
    reviews = next(f for f in found["findings"] if f["code"] == "GBP_FEW_REVIEWS")
    assert (reviews["severity"], reviews["scored"]) == ("ok", False)  # 126 of 200: shown only
    assert found["score"] == 70
    assert found["summary"].startswith("Score 70 · 2 red · 2 orange: Description length")


def test_a_wrong_primary_category_and_what_the_profile_misses_are_red() -> None:
    bare = {**INFO, "category": "Painter", "is_claimed": False, "phone": None, "logo": None}
    data = collect.collect(bare, [{"items": []}], None, TODAY)
    found = compare.compare(data, BENCHMARK)
    red = {f["code"] for f in found["findings"] if f["severity"] == "red"}
    assert {"GBP_WRONG_PRIMARY", "GBP_NOT_CLAIMED", "GBP_NO_PHONE", "GBP_NO_LOGO"} <= red
    assert "GBP_NO_POSTS" in red  # posts were collected, and there are none


def test_what_dataforseo_didnt_give_is_left_out_of_the_score() -> None:
    data = collect.collect(
        {"title": "Bare", "phone": "1", "url": "x", "address": "a"}, None, None, TODAY
    )
    found = compare.compare(data, {"photos": 10, "services": 5})
    assert {"GBP_FEW_PHOTOS", "GBP_FEW_SERVICES", "GBP_NO_POSTS", "GBP_NOT_CLAIMED"} <= set(
        found["unverified"]
    )
    assert all(f["code"] not in found["unverified"] for f in found["findings"])
    # Without a benchmark only what the profile misses counts.
    assert compare.compare(collect.collect(INFO, POSTS, None, TODAY), None)["score"] == 100
