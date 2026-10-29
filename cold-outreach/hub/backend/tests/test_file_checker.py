"""Files checked in the background (SPEC step 33): by the scheduler's file checker, with
their progress saved as it goes, taken over when a checker stopped, and the file's
businesses kept for the Files table."""

from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from app.auth.tokens import now
from app.db.models import Role, Submission
from app.imports import file_checker
from app.imports import submissions as files
from tests.conftest import Person, run_file_checker
from tests.hub_data import batch_id
from tests.test_imports import STANDARD, row, workbook
from tests.test_submissions import BAD, BAD_ROW, GOOD, hand_in

pytestmark = pytest.mark.usefixtures("files_checked")


@pytest.fixture
def cal(person: Person) -> TestClient:
    owner, _ = person(Role.OWNER)
    batch_id(owner, "Batch 01", "Cleaning")
    client, _ = person(Role.COLLECTOR, "Cal")
    return client


def post(client: TestClient, tabs: dict[str, Any]) -> str:
    response = client.post(
        "/api/submissions", files={"file": ("t.xlsx", workbook(tabs))}, data={"niche": "Cleaning"}
    )
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


def test_progress_is_saved_as_it_goes(
    cal: TestClient, clean_engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(file_checker, "SAVE_EVERY", 0.0)
    seen: list[int] = []
    real = files.run

    def watched(content: bytes, niche: str, progress: Any) -> Any:
        def told(percent: int) -> None:
            progress(percent)
            seen.append(cal.get(f"/api/submissions/{file_id}").json()["progress"])

        return real(content, niche, told)

    monkeypatch.setattr(files, "run", watched)
    file_id = post(cal, GOOD)
    waiting = cal.get(f"/api/submissions/{file_id}").json()
    assert (waiting["status"], waiting["progress"]) == ("checking", 0)
    assert run_file_checker() == 1
    assert seen and seen == sorted(seen) and seen[0] >= 0 and seen[-1] < 100
    assert cal.get(f"/api/submissions/{file_id}").json()["progress"] == 100


def test_a_stopped_check_is_taken_over(cal: TestClient, clean_engine: Engine) -> None:
    file_id = post(cal, GOOD)
    with Session(clean_engine) as db:
        assert file_checker.claim(db) is not None  # claimed, then the scheduler stopped
    assert run_file_checker() == 0  # still claimed by the one that stopped
    with Session(clean_engine) as db:
        sub = db.get(Submission, file_id)
        assert sub is not None
        sub.claimed_at = now() - file_checker.STALE - timedelta(seconds=1)
        db.commit()
    assert run_file_checker() == 1
    assert cal.get(f"/api/submissions/{file_id}").json()["status"] == "ready"


def test_a_version_handed_in_during_its_check_is_the_one_kept(
    cal: TestClient, clean_engine: Engine
) -> None:
    file_id = post(cal, BAD)
    with Session(clean_engine) as db:
        claimed = file_checker.claim(db)
    assert claimed is not None
    revised = cal.post(
        f"/api/submissions/{file_id}/version", files={"file": ("v2.xlsx", workbook(GOOD))}
    )
    assert revised.json()["version"] == 2
    file_checker.check_one(clean_engine, *claimed)  # the old version's check ends
    assert cal.get(f"/api/submissions/{file_id}").json()["status"] == "checking"
    assert run_file_checker() == 1
    assert cal.get(f"/api/submissions/{file_id}").json()["status"] == "ready"


def test_the_files_table(cal: TestClient) -> None:
    tabs = {
        "Tulsa": [*BAD["Tulsa"]],
        "Dallas": [
            STANDARD,
            row("Sparkle", "https://share.google/sp", "214 555 0100", city="Dallas"),
        ],
    }
    file_id = hand_in(cal, tabs)["id"]
    table = cal.get(f"/api/submissions/{file_id}/leads").json()
    assert table["total"] == 4 and table["cities"] == ["Dallas", "Tulsa"]
    assert table["counts"] == {"all": 4, "errors": 1, "warnings": 0, "ok": 3}
    first = table["leads"][0]
    assert (first["tab"], first["line"], first["values"]["business_name"]) == (
        "Tulsa",
        2,
        "Multi-Clean",
    )
    bad = cal.get(f"/api/submissions/{file_id}/leads", params={"problems": "errors"}).json()
    assert [r["values"]["business_name"] for r in bad["leads"]] == [BAD_ROW[0]]
    assert {i["field"] for i in bad["leads"][0]["issues"]} == {"phone", "website"}
    found = cal.get(f"/api/submissions/{file_id}/leads", params={"search": "sparkle"}).json()
    assert found["total"] == 1
    dallas = cal.get(f"/api/submissions/{file_id}/leads", params={"city": "dallas"}).json()
    assert dallas["total"] == 1
    by_name = cal.get(f"/api/submissions/{file_id}/leads", params={"sort": "name"}).json()
    assert by_name["leads"][0]["values"]["business_name"] == "Bad Co"


def test_others_cannot_see_the_table(cal: TestClient, person: Person) -> None:
    file_id = hand_in(cal, GOOD)["id"]
    dana, _ = person(Role.COLLECTOR)
    rita, _ = person(Role.REVIEWER)
    assert dana.get(f"/api/submissions/{file_id}/leads").status_code == 404
    assert rita.get(f"/api/submissions/{file_id}/leads").status_code == 404
