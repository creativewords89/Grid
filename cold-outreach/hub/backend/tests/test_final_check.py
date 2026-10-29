"""The Final check (SPEC step 36): a file without errors waits an hour, or until its sender
sends it on, before Top Review; Lead Check has no warnings any more."""

from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from app.auth.tokens import now
from app.db.models import Role, Submission
from app.imports import file_checker
from tests.conftest import Person
from tests.hub_data import batch_id
from tests.test_imports import STANDARD, row
from tests.test_submissions import BAD, GOOD, hand_in, revise

pytestmark = pytest.mark.usefixtures("files_checked")

BIG = {
    "Tulsa": [
        STANDARD,
        *(row(f"Shine {n}", f"https://share.google/s{n}", f"(918) 555-{n:04d}") for n in range(12)),
    ]
}


@pytest.fixture
def owner(person: Person) -> TestClient:
    client, _ = person(Role.OWNER, "Olivia")
    batch_id(client, "Batch 01", "Cleaning")
    return client


def status(client: TestClient, file_id: str) -> Any:
    return client.get(f"/api/submissions/{file_id}").json()


def test_a_file_without_errors_waits_in_its_final_check(owner: TestClient, person: Person) -> None:
    cal, _ = person(Role.COLLECTOR, "Cal")
    rita, _ = person(Role.REVIEWER)
    sub = hand_in(cal, BIG, send=False)
    assert sub["status"] == "final_check"
    # It goes on by itself an hour after it had no error.
    assert sub["sends_at"] is not None
    assert rita.get("/api/review/files").json() == []
    assert rita.get(f"/api/review/files/{sub['id']}").status_code == 404
    # Its sender can still change it.
    assert revise(cal, sub["id"], BIG, send=False).json()["status"] == "final_check"

    sent = cal.post(f"/api/submissions/{sub['id']}/send")
    assert sent.status_code == 200 and sent.json()["status"] == "needs_top"
    assert [f["file_name"] for f in rita.get("/api/review/files").json()] == ["tulsa.xlsx"]
    # Sent on: done for the Collector.
    assert revise(cal, sub["id"], BIG).json()["error"]["code"] == "no_errors"
    again = cal.post(f"/api/submissions/{sub['id']}/send")
    assert again.json()["error"]["code"] == "not_final_check"


def test_the_scheduler_sends_it_on_after_an_hour(
    owner: TestClient, person: Person, clean_engine: Engine
) -> None:
    cal, _ = person(Role.COLLECTOR)
    waiting = hand_in(cal, BIG, send=False)
    small = hand_in(cal, GOOD, name="small.xlsx", send=False)
    with Session(clean_engine) as db:
        assert file_checker.send_due(db) == 0  # not an hour yet
        for file_id in (waiting["id"], small["id"]):
            sub = db.get(Submission, file_id)
            assert sub is not None
            sub.clean_since = now() - timedelta(hours=1, seconds=1)
        db.commit()
        assert file_checker.send_due(db) == 2
        db.commit()
    assert status(cal, waiting["id"])["status"] == "needs_top"
    # Its cities are all under 10 businesses: no Top to choose, ready at once.
    assert status(cal, small["id"])["status"] == "ready"


def test_errors_again_start_the_hour_again(owner: TestClient, person: Person) -> None:
    cal, _ = person(Role.COLLECTOR)
    sub = hand_in(cal, GOOD, send=False)
    assert revise(cal, sub["id"], BAD, send=False).json()["status"] == "errors"
    assert status(cal, sub["id"])["sends_at"] is None
    fixed = revise(cal, sub["id"], GOOD, send=False).json()
    assert fixed["status"] == "final_check" and fixed["sends_at"] > sub["sends_at"]


def test_who_sends_a_file_on(owner: TestClient, person: Person) -> None:
    cal, _ = person(Role.COLLECTOR)
    dana, _ = person(Role.COLLECTOR)
    viewer, _ = person(Role.VIEWER)
    rita, _ = person(Role.REVIEWER)
    sub = hand_in(cal, GOOD, send=False)
    assert dana.post(f"/api/submissions/{sub['id']}/send").status_code == 404
    assert rita.post(f"/api/submissions/{sub['id']}/send").status_code == 404
    assert viewer.post(f"/api/submissions/{sub['id']}/send").status_code == 403
    assert owner.post(f"/api/submissions/{sub['id']}/send").status_code == 200
    bad = hand_in(cal, BAD, name="bad.xlsx", send=False)
    refused = cal.post(f"/api/submissions/{bad['id']}/send")
    assert refused.json()["error"]["code"] == "not_final_check"
