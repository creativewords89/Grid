"""Fixing a handed-in file (SPEC step 34): its fix file has a tab per city with the
businesses with a problem, like a batch's; uploaded back, each row is found by its Row, its
columns change the business, Delete = Yes takes it out, and the file is made again as a new
version and checked again."""

import io
from typing import Any

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook, load_workbook

from app.db.models import Role
from tests.conftest import Person, run_file_checker
from tests.hub_data import batch_id
from tests.test_imports import STANDARD, row
from tests.test_submissions import BAD_ROW, hand_in

pytestmark = pytest.mark.usefixtures("files_checked")

WARNED = row("No Map Co", "", "(918) 555-7777")
FILE = {
    "Tulsa": [
        STANDARD,
        row("Multi-Clean", "https://share.google/mc", "(918) 523-8300", "kevin@mc.com"),
        BAD_ROW,
        WARNED,
    ],
    "Dallas": [
        STANDARD,
        row("Sparkle", "https://share.google/sp", "214 555 0100", city="Dallas"),
        row("Gleam", "https://share.google/gl", "call 214", city="Dallas"),
    ],
}


@pytest.fixture
def cal(person: Person) -> TestClient:
    owner, _ = person(Role.OWNER)
    batch_id(owner, "Batch 01", "Cleaning")
    client, _ = person(Role.COLLECTOR, "Cal")
    return client


def fix_file(client: TestClient, file_id: str) -> Any:
    response = client.get(f"/api/submissions/{file_id}/marked.xlsx")
    assert response.status_code == 200, response.text
    return load_workbook(io.BytesIO(response.content))


def send(client: TestClient, file_id: str, book: Any, confirm: bool = False) -> Any:
    out = io.BytesIO()
    book.save(out)
    return client.post(
        f"/api/submissions/{file_id}/fixes",
        files={"file": ("fix.xlsx", out.getvalue())},
        data={"confirm": "true" if confirm else "false"},
    )


def rows(sheet: Any) -> list[list[Any]]:
    return [[c.value for c in line] for line in sheet.iter_rows()]


def test_the_fix_file_is_like_a_batchs(cal: TestClient) -> None:
    file_id = hand_in(cal, FILE)["id"]
    book = fix_file(cal, file_id)
    assert book.sheetnames == ["Dallas", "Tulsa"]  # a tab per city, the problems only
    tulsa = rows(book["Tulsa"])
    assert tulsa[0] == [
        "Row",
        "Business name",
        "GBP link",
        "Address",
        "City",
        "Website",
        "Phone",
        "WhatsApp",
        "Email",
        "Facebook",
        "Instagram",
        "Reviews",
        "Rating",
        "Notes",
        "Problems",
        "Delete",
    ]
    assert [r[0] for r in tulsa[1:]] == ["Tulsa · 3", "Tulsa · 4"]
    assert tulsa[1][1] == "Bad Co" and "Phone: Phone holds letters" in tulsa[1][14]
    sheet = book["Tulsa"]
    phone = sheet.cell(2, 7)
    assert phone.value == "call us" and phone.fill.fgColor.rgb == "00F8C9C9"
    assert phone.comment is not None and "Phone holds letters" in phone.comment.text
    gbp = sheet.cell(3, 3)
    assert gbp.fill.fgColor.rgb == "00FFF1B8"  # a warning: no GBP link
    assert sheet.freeze_panes == "C2" and sheet.auto_filter.ref


def test_fixes_are_shown_then_saved_as_a_new_version(cal: TestClient) -> None:
    file_id = hand_in(cal, FILE)["id"]
    book = fix_file(cal, file_id)
    tulsa, dallas = book["Tulsa"], book["Dallas"]
    tulsa.cell(2, 6).value = "https://badco.com"  # Website
    tulsa.cell(2, 7).value = "(918) 555-2222"  # Phone
    dallas.cell(2, 16).value = "Yes"  # Delete Gleam
    preview = send(cal, file_id, book).json()
    assert preview["saved"] is False
    assert [(c["row"], c["business_name"]) for c in preview["changed"]] == [("Tulsa · 3", "Bad Co")]
    assert {(c["field"], c["from"], c["to"]) for c in preview["changed"][0]["changes"]} == {
        ("Website", "https://facebook.com/bc", "https://badco.com"),
        ("Phone", "call us", "(918) 555-2222"),
    }
    assert [r["business_name"] for r in preview["removed"]] == ["Gleam"]
    assert preview["businesses_after"] == 4
    assert cal.get(f"/api/submissions/{file_id}").json()["version"] == 1  # nothing saved

    saved = send(cal, file_id, book, confirm=True).json()
    assert saved["saved"] is True
    waiting = cal.get(f"/api/submissions/{file_id}").json()
    assert (waiting["status"], waiting["version"]) == ("checking", 2)
    assert run_file_checker() == 1
    after = cal.get(f"/api/submissions/{file_id}").json()
    # Cities under 10 businesses need no Top: with no error the file is ready.
    assert (after["status"], after["businesses"], after["errors"]) == ("ready", 4, 0)
    names = [
        r["values"]["business_name"]
        for r in cal.get(f"/api/submissions/{file_id}/leads").json()["leads"]
    ]
    assert sorted(names) == ["Bad Co", "Multi-Clean", "No Map Co", "Sparkle"]


def test_rows_that_dont_match_are_left_out(cal: TestClient) -> None:
    file_id = hand_in(cal, FILE)["id"]
    book = fix_file(cal, file_id)
    sheet = book["Tulsa"]
    sheet.append(["Tulsa · 99", "Ghost"])
    sheet.append(["Tulsa · 3", "Bad Co again"])
    found = send(cal, file_id, book).json()
    assert [s["reason"] for s in found["skipped"]] == [
        "No business of this file is on that Row.",
        "This Row is on an earlier row too.",
    ]
    assert found["changed"] == []
    other = Workbook()
    other.active.append(["Business name", "Phone"])  # type: ignore[union-attr]
    refused = send(cal, file_id, other)
    assert refused.status_code == 422 and "No Row column" in refused.json()["error"]["message"]


def test_only_who_may_change_the_file_uploads_fixes(cal: TestClient, person: Person) -> None:
    file_id = hand_in(cal, FILE)["id"]
    book = fix_file(cal, file_id)
    dana, _ = person(Role.COLLECTOR)
    viewer, _ = person(Role.VIEWER)
    assert send(dana, file_id, book).status_code == 404
    assert send(viewer, file_id, book).status_code == 403
    clean_id = hand_in(cal, {"Dallas": [STANDARD, FILE["Dallas"][1]]}, name="d.xlsx")["id"]
    done = send(cal, clean_id, fix_file(cal, clean_id))
    assert done.json()["error"]["code"] == "no_errors"


def test_every_business_can_not_be_taken_out(cal: TestClient) -> None:
    file_id = hand_in(cal, {"Tulsa": [STANDARD, BAD_ROW]})["id"]
    book = fix_file(cal, file_id)
    book["Tulsa"].cell(2, 16).value = "yes"
    assert send(cal, file_id, book, confirm=True).json()["error"]["code"] == "empty"


def test_the_file_made_again_keeps_its_other_columns(cal: TestClient) -> None:
    tabs = {"Tulsa": [[*STANDARD, "Owner"], [*BAD_ROW, "Kevin"]]}
    file_id = hand_in(cal, tabs)["id"]
    book = fix_file(cal, file_id)
    book["Tulsa"].cell(2, 7).value = "(918) 555-2222"
    send(cal, file_id, book, confirm=True)
    run_file_checker()
    lead = cal.get(f"/api/submissions/{file_id}/leads").json()["leads"][0]
    assert lead["values"]["phone"] == "(918) 555-2222"
    assert lead["extra"] == {"Owner": "Kevin"}
    assert lead["values"]["website"] == "https://facebook.com/bc"  # left as it was
