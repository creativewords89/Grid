"""The Files screen (SPEC step 31): Collectors hand in lead files and fix them until Lead
Check finds no error; Owners and Admins add a ready file to a batch of its niche, once."""

import io
from typing import Any

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook
from openpyxl.comments import Comment

from app.db.models import Role
from app.imports import submissions
from tests.conftest import Person, run_file_checker
from tests.hub_data import batch_id, make_batch
from tests.test_imports import STANDARD, row, workbook

pytestmark = pytest.mark.usefixtures("files_checked")

GOOD = {
    "Tulsa": [
        STANDARD,
        row("Multi-Clean", "https://share.google/mc", "(918) 523-8300", "kevin@mc.com"),
        row("Top Shine", "https://share.google/ts", "(918) 555-0000"),
    ],
    "Dallas": [STANDARD, row("Sparkle", "https://share.google/sp", "214 555 0100", city="Dallas")],
}
BAD_ROW = row("Bad Co", "https://share.google/bc", "call us", website="https://facebook.com/bc")
BAD = {"Tulsa": [*GOOD["Tulsa"], BAD_ROW], "Dallas": GOOD["Dallas"]}


# --- Lead Check on a whole file -----------------------------------------------------------------


def test_every_problem_has_its_tab_row_and_column() -> None:
    found = submissions.run(workbook(BAD), "Cleaning")
    assert found.businesses == 4
    assert found.check["errors"] == 2
    assert found.check["tabs"]["Tulsa"]["errors"] == 2
    assert found.check["tabs"]["Dallas"]["errors"] == 0
    assert {(p["tab"], p["line"], p["field"], p["code"]) for p in found.problems} == {
        ("Tulsa", 4, "phone", "PHONE_HAS_LETTERS"),
        ("Tulsa", 4, "website", "WEBSITE_IS_FACEBOOK"),
    }
    assert found.problems[0]["business"] == "Bad Co"
    assert submissions.run(workbook(GOOD), "Cleaning").check["errors"] == 0


def test_a_business_on_two_rows_is_checked_once() -> None:
    twice = {"Tulsa": [STANDARD, BAD_ROW, BAD_ROW]}
    assert submissions.run(workbook(twice), "Cleaning").check["errors"] == 2


def test_the_same_leads_have_the_same_fingerprint() -> None:
    first = submissions.run(workbook(GOOD), "Cleaning").fingerprint
    resaved = load_workbook(io.BytesIO(workbook(GOOD)))
    resaved["Tulsa"]["Z1"] = None
    out = io.BytesIO()
    resaved.save(out)
    assert submissions.run(out.getvalue(), "Cleaning").fingerprint == first
    assert submissions.run(workbook(BAD), "Cleaning").fingerprint != first


def test_marks_of_an_old_marked_copy_are_taken_out() -> None:
    """Files handed in before step 34 were downloaded with a Lead Check tab and notes."""
    book = load_workbook(io.BytesIO(workbook(BAD)))
    report = book.create_sheet(submissions.REPORT_TAB, 0)
    report.append(["Severity", "Tab", "Row"])
    phone = book["Tulsa"].cell(4, STANDARD.index("Phone") + 1)
    phone.value = "(918) 555-2222"
    phone.fill = submissions.RED
    phone.comment = Comment("Error: Phone holds letters", submissions.AUTHOR)
    book["Tulsa"].cell(4, STANDARD.index("Website") + 1).value = "https://badco.com"
    out = io.BytesIO()
    book.save(out)
    cleaned = load_workbook(io.BytesIO(submissions.clean(out.getvalue())))
    assert cleaned.sheetnames == ["Tulsa", "Dallas"]
    assert cleaned["Tulsa"].cell(4, STANDARD.index("Phone") + 1).comment is None
    assert submissions.run(submissions.clean(out.getvalue()), "Cleaning").check["errors"] == 0


# --- the API ------------------------------------------------------------------------------------


@pytest.fixture
def owner(person: Person) -> TestClient:
    client, _ = person(Role.OWNER, "Olivia")
    make_batch(client, "Batch 01", "Cleaning")
    make_batch(client, "Roofs 01", "Roofing")
    return client


def hand_in(
    client: TestClient, tabs: dict[str, Any], niche: str = "Cleaning", name: str = "tulsa.xlsx"
) -> dict[str, Any]:
    response = client.post(
        "/api/submissions", files={"file": (name, workbook(tabs))}, data={"niche": niche}
    )
    assert response.status_code == 201, response.text
    assert response.json()["status"] == "checking"
    run_file_checker()
    body: dict[str, Any] = client.get(f"/api/submissions/{response.json()['id']}").json()
    return body


def revise(client: TestClient, file_id: str, tabs: dict[str, Any]) -> Any:
    response = client.post(
        f"/api/submissions/{file_id}/version", files={"file": ("tulsa-v2.xlsx", workbook(tabs))}
    )
    if response.status_code != 200:
        return response
    run_file_checker()
    return client.get(f"/api/submissions/{file_id}")


def use(client: TestClient, file_id: str, batch: str = "Batch 01") -> Any:
    return client.post(
        f"/api/submissions/{file_id}/use", json={"batch_id": batch_id(client, batch)}
    )


def test_a_collector_sees_only_the_files_screen(owner: TestClient, person: Person) -> None:
    collector, _ = person(Role.COLLECTOR, "Cal")
    for path in (
        "/api/batches",
        "/api/leads",
        "/api/imports",
        "/api/niches",
        "/api/agents",
        "/api/runs",
        "/api/benchmarks",
        "/api/alerts",
        "/api/users",
    ):
        assert collector.get(path).status_code == 403, path
    assert collector.get("/api/submissions").status_code == 200
    assert collector.get("/api/submissions/niches").json() == ["Cleaning", "Roofing"]
    assert collector.get("/api/auth/me").json()["user"]["role"] == "collector"


def test_a_collector_hands_in_fixes_and_sees_only_their_own_files(
    owner: TestClient, person: Person
) -> None:
    cal, _ = person(Role.COLLECTOR, "Cal")
    dana, _ = person(Role.COLLECTOR, "Dana")
    bad = hand_in(cal, BAD)
    assert bad["status"] == "errors" and bad["errors"] == 2 and bad["version"] == 1
    assert bad["uploaded_by"] == "Cal" and bad["mine"]
    assert len(bad["problems"]) == 2 and bad["tabs"]["Tulsa"]["errors"] == 2
    # Others' files are not there for a Collector; Owners see every file.
    assert dana.get("/api/submissions").json() == []
    assert dana.get(f"/api/submissions/{bad['id']}").status_code == 404
    assert dana.get(f"/api/submissions/{bad['id']}/marked.xlsx").status_code == 404
    assert revise(dana, bad["id"], GOOD).status_code == 404
    assert dana.delete(f"/api/submissions/{bad['id']}").status_code == 404
    assert [f["file_name"] for f in owner.get("/api/submissions").json()] == ["tulsa.xlsx"]
    # The fix file, then a revised version: checked again.
    marked = cal.get(f"/api/submissions/{bad['id']}/marked.xlsx")
    assert marked.status_code == 200
    assert load_workbook(io.BytesIO(marked.content)).sheetnames == ["Problems"]
    fixed = revise(cal, bad["id"], GOOD).json()
    assert fixed["status"] == "ready" and fixed["errors"] == 0 and fixed["version"] == 2
    assert fixed["problems"] == []


def test_handing_in_needs_a_known_niche_and_an_excel_file(
    owner: TestClient, person: Person
) -> None:
    cal, _ = person(Role.COLLECTOR)
    wrong = cal.post(
        "/api/submissions", files={"file": ("a.xlsx", workbook(GOOD))}, data={"niche": "Bakery"}
    )
    assert wrong.status_code == 422 and wrong.json()["error"]["code"] == "unknown_niche"
    junk = cal.post(
        "/api/submissions", files={"file": ("a.xlsx", b"x")}, data={"niche": "cleaning"}
    )
    # Taken at once and checked in the background: it fails there, and says why.
    assert junk.status_code == 201 and junk.json()["status"] == "checking"
    assert run_file_checker() == 1
    failed = cal.get(f"/api/submissions/{junk.json()['id']}").json()
    assert failed["status"] == "failed" and "isn't an Excel file" in failed["error"]
    assert cal.get(f"/api/submissions/{junk.json()['id']}/marked.xlsx").status_code == 409
    assert revise(cal, junk.json()["id"], GOOD).json()["status"] == "ready"
    assert hand_in(cal, GOOD, niche="cleaning")["niche"] == "Cleaning"


def test_viewers_see_every_file_but_cannot_hand_in_or_use(
    owner: TestClient, person: Person
) -> None:
    cal, _ = person(Role.COLLECTOR)
    viewer, _ = person(Role.VIEWER)
    ready = hand_in(cal, GOOD)
    assert [f["id"] for f in viewer.get("/api/submissions").json()] == [ready["id"]]
    refused = viewer.post(
        "/api/submissions", files={"file": ("a.xlsx", workbook(GOOD))}, data={"niche": "Cleaning"}
    )
    assert refused.status_code == 403
    assert viewer.post(f"/api/submissions/{ready['id']}/use", json={}).status_code in (403, 422)
    assert use(viewer, ready["id"]).status_code == 403
    batch = {"batch_id": batch_id(viewer, "Batch 01")}
    assert cal.post(f"/api/submissions/{ready['id']}/use", json=batch).status_code == 403
    assert viewer.delete(f"/api/submissions/{ready['id']}").status_code == 403


def test_a_ready_file_is_added_to_a_batch_of_its_niche_once(
    owner: TestClient, person: Person
) -> None:
    cal, _ = person(Role.COLLECTOR, "Cal")
    bad = hand_in(cal, BAD)
    assert use(owner, bad["id"]).json()["error"]["code"] == "not_ready"
    ready = revise(cal, bad["id"], GOOD).json()
    assert use(owner, ready["id"], "Roofs 01").json()["error"]["code"] == "other_niche"

    adding = use(owner, ready["id"])
    assert adding.status_code == 200, adding.text
    assert adding.json()["status"] == "adding"
    assert adding.json()["batch"]["batch_name"] == "Batch 01"
    import_id = adding.json()["batch"]["import_id"]
    preview = owner.get(f"/api/imports/{import_id}").json()
    assert preview["status"] == "preview" and preview["file_name"] == "tulsa.xlsx"
    # While it waits in the batch, it can't be added again, revised or deleted.
    assert use(owner, ready["id"]).json()["error"]["code"] == "adding"
    assert revise(cal, ready["id"], GOOD).json()["error"]["code"] == "adding"
    assert cal.delete(f"/api/submissions/{ready['id']}").json()["error"]["code"] == "adding"

    # Discarded in the batch: the file is free again.
    owner.post(f"/api/imports/{import_id}/discard")
    assert cal.get(f"/api/submissions/{ready['id']}").json()["status"] == "ready"

    import_id = use(owner, ready["id"]).json()["batch"]["import_id"]
    assert owner.post(f"/api/imports/{import_id}/confirm").status_code == 200
    used = cal.get(f"/api/submissions/{ready['id']}").json()
    assert used["status"] == "used"
    assert used["batch"]["batch_name"] == "Batch 01" and used["batch"]["by"] == "Olivia"
    assert use(owner, ready["id"]).json()["error"]["code"] == "used"
    assert revise(cal, ready["id"], GOOD).json()["error"]["code"] == "used"
    assert cal.delete(f"/api/submissions/{ready['id']}").json()["error"]["code"] == "used"

    # The same leads handed in again: a warning, and they can't be used a second time.
    again = hand_in(cal, GOOD, name="copy.xlsx")
    assert again["same_as"] == 'Same leads as "tulsa.xlsx", used in Batch 01.'
    assert use(owner, again["id"]).json()["error"]["code"] == "same_leads_used"


def test_a_file_is_deleted_only_before_it_is_used(owner: TestClient, person: Person) -> None:
    cal, _ = person(Role.COLLECTOR)
    first = hand_in(cal, BAD)
    assert cal.delete(f"/api/submissions/{first['id']}").status_code == 204
    assert cal.get("/api/submissions").json() == []
    # Owners and Admins can delete anyone's file that isn't used.
    second = hand_in(cal, GOOD)
    assert owner.delete(f"/api/submissions/{second['id']}").status_code == 204


def test_owners_invite_collectors(owner: TestClient) -> None:
    response = owner.post(
        "/api/users/invite", json={"name": "Cal", "email": "cal@example.com", "role": "collector"}
    )
    assert response.status_code == 201, response.text
    assert response.json()["user"]["role"] == "collector"
