"""The History screen (SPEC sections 3, 5 and 7): Owners see who did what; never a secret."""

import json
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api import history
from app.auth.tokens import now
from app.db.models import AuditEntry, Role
from tests.conftest import UserFactory, sign_in


def test_owners_see_who_changed_what_without_the_values(
    client: TestClient, make_user: UserFactory
) -> None:
    sign_in(client, make_user(Role.OWNER, name="Olivia").email)
    client.patch("/api/connections", json={"values": {"pagespeed_api_key": "AIzaSecret12345"}})
    client.put("/api/budget", json={"daily_total_budget_usd": "35.00", "time_zone": "Asia/Dhaka"})

    entries = client.get("/api/history").json()["entries"]

    assert [(e["actor"], e["entity"], e["action"]) for e in entries[:2]] == [
        ("Olivia", "budget", "edit"),
        ("Olivia", "connections", "update"),
    ]
    assert entries[1]["changes"] == [
        {"field": "pagespeed_api_key", "from": None, "to": "(changed)"}
    ]
    assert "AIzaSecret12345" not in json.dumps(entries)
    budget = client.get("/api/history?entity=budget").json()["entries"]
    assert [e["entity"] for e in budget] == ["budget"]


@pytest.mark.parametrize("role", [Role.ADMIN, Role.VIEWER])
def test_only_owners_see_the_history(
    client: TestClient, make_user: UserFactory, role: Role
) -> None:
    sign_in(client, make_user(role).email)

    assert client.get("/api/history").status_code == 403


def test_signed_out_people_see_nothing(client: TestClient) -> None:
    assert client.get("/api/history").status_code == 401


def test_pages_of_fifty(
    client: TestClient, make_user: UserFactory, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(history, "PAGE", 3)
    sign_in(client, make_user(Role.OWNER).email)
    start = now()
    db.add_all(
        AuditEntry(action="edit", entity="list", title=f"#{i}", at=start - timedelta(minutes=i))
        for i in range(5)
    )
    db.commit()

    first = client.get("/api/history").json()
    oldest = first["entries"][-1]["at"]
    second = client.get("/api/history", params={"before": oldest}).json()

    assert ([e["title"] for e in first["entries"]], first["more"]) == (["#0", "#1", "#2"], True)
    assert ([e["title"] for e in second["entries"]], second["more"]) == (["#3", "#4"], False)
    assert first["entries"][0]["actor"] is None  # done by the Hub itself
