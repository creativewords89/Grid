"""GBP benchmarks, Website Standards and the agents' reference data (SPEC sections 6.2 and
6.5)."""

from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.benchmarks import gbp
from app.db.models import DoNotContact, GbpBenchmark, LeadList, Role, User
from app.imports.reader import ReadError
from tests.conftest import UserFactory, sign_in
from tests.test_agents import MANIFEST, add_agent, agent_call
from tests.test_imports import workbook

HEADER = [
    "City",
    "Niche",
    "Additional categories",
    "Services",
    "Photos",
    "Posts (90 days)",
    "Description length",
    "Reviews",
    "Rating",
    "Review reply %",
    "Reference businesses",
]


def bench(
    city: str, niche: str = "Cleaning", values: dict[str, Any] | None = None, **more: Any
) -> list[Any]:
    row = {
        "City": city,
        "Niche": niche,
        "Additional categories": 4,
        "Services": 12,
        "Photos": 120,
        "Posts (90 days)": 9,
        "Description length": 690,
        "Reviews": 150,
        "Rating": 4.8,
        "Review reply %": "85%",
        "Reference businesses": "Smile Co, AquaPro",
    }
    row.update(values or {})
    row.update(more)
    return [row[h] for h in HEADER]


# --- reading the file -------------------------------------------------------------------


def test_reads_numbers_percentages_and_empty_cells() -> None:
    content = workbook(
        {
            "Benchmarks": [
                HEADER,
                bench("Dallas"),
                bench("Tulsa", values={"Review reply %": 0.6, "Photos": ""}),
            ]
        }
    )

    report = gbp.read(content)

    dallas, tulsa = report.rows
    assert dallas["review_reply_pct"] == Decimal("85.00")
    assert tulsa["review_reply_pct"] == Decimal("60.00")  # 0.6 as a fraction
    assert tulsa["photos"] is None  # empty: don't compare
    assert dallas["reference_businesses"] == "Smile Co, AquaPro"
    assert report.errors == []


def test_problems_are_listed_per_row() -> None:
    content = workbook(
        {
            "Benchmarks": [
                [*HEADER, "Owner notes"],
                bench("Dallas", Rating=6),
                bench("", "Cleaning"),
                bench("Tulsa", Photos="lots"),
                bench("Austin"),
                bench("austin", "cleaning"),
            ]
        }
    )

    report = gbp.read(content)

    assert [r["city"] for r in report.rows] == ["Austin"]
    assert report.errors == [
        "Benchmarks row 2: rating must be between 0 and 5.",
        "Benchmarks row 3: City and Niche are both needed.",
        "Benchmarks row 4: photos isn't a number.",
        "Benchmarks row 6: austin · cleaning is also in Benchmarks row 5.",
    ]
    assert report.ignored_columns == ["Owner notes"]


def test_a_file_without_city_and_niche_columns() -> None:
    with pytest.raises(ReadError, match="City and Niche"):
        gbp.read(workbook({"Sheet": [["Name", "Reviews"], ["A", 3]]}))


# --- the API ----------------------------------------------------------------------------


@pytest.fixture
def owner(client: TestClient, make_user: UserFactory) -> User:
    user = make_user(Role.OWNER, name="Olivia")
    sign_in(client, user.email)
    return user


def send(client: TestClient, content: bytes, apply: bool) -> Any:
    return client.post(
        "/api/benchmarks/upload",
        files={"file": ("benchmarks.xlsx", content)},
        data={"apply": "true" if apply else "false"},
    )


def test_check_first_then_apply(client: TestClient, owner: User, db: Session) -> None:
    content = workbook({"B": [HEADER, bench("Dallas"), bench("Tulsa")]})

    checked = send(client, content, apply=False).json()
    assert (checked["applied"], len(checked["rows"]), checked["replaces"]) == (False, 2, 0)
    assert db.scalar(select(GbpBenchmark.id)) is None

    applied = send(client, content, apply=True).json()
    assert applied["applied"] is True
    listed = client.get("/api/benchmarks").json()
    assert [(b["city"], b["reviews"]) for b in listed] == [
        ("Dallas", "150.00"),
        ("Tulsa", "150.00"),
    ]


def test_a_row_replaces_its_city_and_niche(client: TestClient, owner: User) -> None:
    send(client, workbook({"B": [HEADER, bench("Dallas")]}), apply=True)

    again = send(client, workbook({"B": [HEADER, bench("DALLAS", "cleaning", Reviews=200)]}), True)

    assert again.json()["replaces"] == 1
    [row] = client.get("/api/benchmarks").json()
    assert (row["city"], row["reviews"]) == ("DALLAS", "200.00")


def test_a_file_with_problems_is_not_applied(client: TestClient, owner: User, db: Session) -> None:
    content = workbook({"B": [HEADER, bench("Dallas"), bench("Tulsa", Rating=9)]})

    response = send(client, content, apply=True)

    assert (response.status_code, response.json()["error"]["code"]) == (422, "has_errors")
    assert db.scalar(select(GbpBenchmark.id)) is None


def test_viewers_see_but_cannot_change(
    client: TestClient, owner: User, make_user: UserFactory
) -> None:
    send(client, workbook({"B": [HEADER, bench("Dallas")]}), apply=True)
    benchmark_id = client.get("/api/benchmarks").json()[0]["id"]
    client.cookies.clear()
    sign_in(client, make_user(Role.VIEWER).email)

    assert client.get("/api/benchmarks").status_code == 200
    assert send(client, workbook({"B": [HEADER, bench("X")]}), apply=False).status_code == 403
    assert client.delete(f"/api/benchmarks/{benchmark_id}").status_code == 403


def test_delete_a_benchmark(client: TestClient, owner: User) -> None:
    send(client, workbook({"B": [HEADER, bench("Dallas")]}), apply=True)
    benchmark_id = client.get("/api/benchmarks").json()[0]["id"]

    assert client.delete(f"/api/benchmarks/{benchmark_id}").status_code == 204
    assert client.get("/api/benchmarks").json() == []


# --- Website Standards ------------------------------------------------------------------

STANDARD: dict[str, Any] = {
    "services": [
        {"name": "Deep cleaning", "synonyms": ["deep clean"], "must_have": True},
        {"name": "Move-out cleaning", "synonyms": ["end of lease", "move out"]},
        {"name": "Carpet cleaning", "must_have": False},
    ],
    "service_page": {"min_words": 800},
    "blog": {"posts_per_month": 2, "topics": ["Cost guide", "Move-out checklist"]},
}


def test_draft_then_lock_into_versions(
    client: TestClient, owner: User, make_user: UserFactory
) -> None:
    saved = client.put("/api/website-standards/Cleaning/draft", json=STANDARD).json()
    assert saved["draft"]["standard"]["service_page"]["min_words"] == 800
    assert saved["draft"]["standard"]["location_page"]["min_words"] == 400  # a default
    assert saved["locked"] is None

    first = client.post("/api/website-standards/Cleaning/lock").json()
    assert (first["locked"]["version"], first["locked"]["label"]) == (1, "cleaning-v1")
    assert first["draft"] is None

    client.put("/api/website-standards/cleaning/draft", json=STANDARD | {"mobile_lcp_seconds": 3})
    second = client.post("/api/website-standards/Cleaning/lock").json()
    assert (second["locked"]["label"], second["versions"]) == ("cleaning-v2", [2, 1])
    old = client.get("/api/website-standards/Cleaning/versions/1").json()
    assert old["standard"]["mobile_lcp_seconds"] == 2.5


def test_admins_edit_drafts_but_only_owners_lock(
    client: TestClient, owner: User, make_user: UserFactory
) -> None:
    client.cookies.clear()
    sign_in(client, make_user(Role.ADMIN).email)

    saved = client.put("/api/website-standards/Cleaning/draft", json=STANDARD)
    locked = client.post("/api/website-standards/Cleaning/lock")

    assert saved.status_code == 200
    assert (saved.json()["can_edit"], saved.json()["can_lock"]) == (True, False)
    assert locked.status_code == 403


@pytest.mark.parametrize(
    ("change", "field"),
    [
        ({"services": [{"name": "A"}, {"name": "a"}]}, "standard"),
        ({"surprise": 1}, "surprise"),
        ({"service_page": {"min_words": -1}}, "service_page.min_words"),
        ({"mobile_lcp_seconds": 0}, "mobile_lcp_seconds"),
    ],
)
def test_bad_standards_are_refused(
    client: TestClient, owner: User, change: dict[str, Any], field: str
) -> None:
    response = client.put("/api/website-standards/Cleaning/draft", json=STANDARD | change)

    assert response.status_code == 422
    assert field in response.json()["error"]["fields"]


def test_a_standard_needs_a_must_have_service_to_lock(client: TestClient, owner: User) -> None:
    client.put(
        "/api/website-standards/Cleaning/draft",
        json={"services": [{"name": "Carpet", "must_have": False}]},
    )

    response = client.post("/api/website-standards/Cleaning/lock")

    assert (response.status_code, response.json()["error"]["message"]) == (
        422,
        "Add at least one must-have service.",
    )


# --- what agents read -------------------------------------------------------------------


def test_agents_read_benchmarks_standards_lists_and_do_not_contact(
    client: TestClient, owner: User, db: Session
) -> None:
    token = add_agent(client)
    agent_call(client, "PUT", "/manifest", token, MANIFEST)
    send(client, workbook({"B": [HEADER, bench("Dallas"), bench("Tulsa", "Roofing")]}), True)
    client.put("/api/website-standards/Cleaning/draft", json=STANDARD)
    db.add_all(
        [
            LeadList(city="Dallas", niche="Cleaning", active=False),
            DoNotContact(kind="email", value="boss@top.com", reason="top", lead_id="L-000001"),
            DoNotContact(kind="phone", value="9185550000", reason="top", lead_id="L-000001"),
        ]
    )
    db.commit()

    cleaning = agent_call(client, "GET", "/benchmarks?niche=cleaning", token).json()
    assert [(b["city"], b["reviews"], b["review_reply_pct"]) for b in cleaning] == [
        ("Dallas", 150.0, 85.0)
    ]
    # Only locked versions: a draft is invisible to agents.
    assert agent_call(client, "GET", "/website-standards/Cleaning", token).status_code == 404
    client.post("/api/website-standards/Cleaning/lock")
    standard = agent_call(client, "GET", "/website-standards/cleaning", token).json()
    assert standard["label"] == "cleaning-v1"
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
    assert client.get("/api/agent/v1/benchmarks").status_code == 401
