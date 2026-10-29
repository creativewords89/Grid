"""Fixing a handed-in file (SPEC steps 34 and 35): its fix file has the businesses with a
problem on one sheet by city, each with its File ID, like a batch's; uploaded back, each row is
found by its File ID, its columns change the business, Delete = Yes takes it out, and the file
is made again as a new version (the File IDs kept) and checked again."""

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
    sub = hand_in(cal, FILE)
    file_id, n = sub["id"], sub["number"]
    book = fix_file(cal, file_id)
    assert book.sheetnames == ["Problems"]  # one sheet, the problems only, by city
    sheet = book["Problems"]
    found = rows(sheet)
    assert found[0] == [
        "File ID",
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
    # File IDs in the file's order: Tulsa's three, then Dallas's two.
    assert [(r[0], r[1]) for r in found[1:]] == [
        (f"F{n}-0005", "Gleam"),
        (f"F{n}-0002", "Bad Co"),
        (f"F{n}-0003", "No Map Co"),
    ]
    assert "Phone: Phone holds letters" in found[2][14]
    phone = sheet.cell(3, 7)
    assert phone.value == "call us" and phone.fill.fgColor.rgb == "00F8C9C9"
    assert phone.comment is not None and "Phone holds letters" in phone.comment.text
    gbp = sheet.cell(4, 3)
    assert gbp.fill.fgColor.rgb == "00F8C9C9"  # no GBP link: an error since step 36
    assert sheet.freeze_panes == "C2" and sheet.auto_filter.ref
    # The table shows the same File IDs.
    table = cal.get(f"/api/submissions/{file_id}/leads").json()["leads"]
    assert [r["id"] for r in table] == [f"F{n}-000{i}" for i in range(1, 6)]


def test_each_file_has_its_own_number(cal: TestClient) -> None:
    first = hand_in(cal, FILE)["number"]
    second = hand_in(cal, FILE, name="again.xlsx")["number"]
    assert second == first + 1


def test_fixes_are_shown_then_saved_as_a_new_version(cal: TestClient) -> None:
    sub = hand_in(cal, FILE)
    file_id, n = sub["id"], sub["number"]
    book = fix_file(cal, file_id)
    sheet = book["Problems"]
    sheet.cell(2, 16).value = "Yes"  # Delete Gleam
    sheet.cell(3, 6).value = "https://badco.com"  # Bad Co's Website
    sheet.cell(3, 7).value = "(918) 555-2222"  # and Phone
    sheet.cell(4, 3).value = "https://share.google/nm"  # No Map Co's GBP link
    preview = send(cal, file_id, book).json()
    assert preview["saved"] is False
    assert [(c["file_id"], c["business_name"]) for c in preview["changed"]] == [
        (f"F{n}-0002", "Bad Co"),
        (f"F{n}-0003", "No Map Co"),
    ]
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
    # No error: the file is in its Final check (step 36).
    assert (after["status"], after["businesses"], after["errors"]) == ("final_check", 4, 0)
    table = cal.get(f"/api/submissions/{file_id}/leads", params={"sort": "id"}).json()
    # The businesses keep their File IDs in the new version; Gleam's is gone.
    assert [(r["id"], r["values"]["business_name"]) for r in table["leads"]] == [
        (f"F{n}-0001", "Multi-Clean"),
        (f"F{n}-0002", "Bad Co"),
        (f"F{n}-0003", "No Map Co"),
        (f"F{n}-0004", "Sparkle"),
    ]
    assert table["leads"][1]["values"]["phone"] == "(918) 555-2222"
    assert "File ID" not in table["leads"][0]["extra"]


def test_rows_that_dont_match_are_left_out(cal: TestClient) -> None:
    file_id = hand_in(cal, FILE)["id"]
    book = fix_file(cal, file_id)
    sheet = book["Problems"]
    sheet.append(["F999-0001", "Ghost"])
    sheet.append([sheet.cell(3, 1).value, "Bad Co again"])
    found = send(cal, file_id, book).json()
    assert [s["reason"] for s in found["skipped"]] == [
        "No business of this file has that File ID.",
        "This File ID is on an earlier row too.",
    ]
    assert found["changed"] == []
    junk = cal.post(f"/api/submissions/{file_id}/fixes", files={"file": ("x.xlsx", b"not excel")})
    assert junk.status_code == 422


def test_a_whole_file_replaces_the_file_once_confirmed(cal: TestClient) -> None:
    """One Upload fixes button (step 37): a file without File IDs is a new version."""
    sub = hand_in(cal, FILE)
    whole = Workbook()
    sheet = whole.active
    assert sheet is not None
    sheet.title = "Tulsa"
    for line in FILE["Tulsa"][:2]:
        sheet.append(line)
    asked = send(cal, sub["id"], whole).json()
    assert (asked["whole_file"], asked["saved"], asked["version_after"]) == (True, False, 2)
    assert cal.get(f"/api/submissions/{sub['id']}").json()["version"] == 1  # nothing saved
    replaced = send(cal, sub["id"], whole, confirm=True).json()
    assert (replaced["whole_file"], replaced["saved"], replaced["version_after"]) == (True, True, 2)
    run_file_checker()
    after = cal.get(f"/api/submissions/{sub['id']}").json()
    assert (after["version"], after["businesses"]) == (2, 1)


def test_only_who_may_change_the_file_uploads_fixes(cal: TestClient, person: Person) -> None:
    file_id = hand_in(cal, FILE)["id"]
    book = fix_file(cal, file_id)
    dana, _ = person(Role.COLLECTOR)
    viewer, _ = person(Role.VIEWER)
    assert send(dana, file_id, book).status_code == 404
    assert send(viewer, file_id, book).status_code == 403
    clean_id = hand_in(cal, {"Dallas": [STANDARD, FILE["Dallas"][1]]}, name="d.xlsx")["id"]
    done = send(cal, clean_id, fix_file(cal, clean_id))
    assert done.json()["error"]["code"] == "sent_on"


def test_every_business_can_not_be_taken_out(cal: TestClient) -> None:
    file_id = hand_in(cal, {"Tulsa": [STANDARD, BAD_ROW]})["id"]
    book = fix_file(cal, file_id)
    book["Problems"].cell(2, 16).value = "yes"
    assert send(cal, file_id, book, confirm=True).json()["error"]["code"] == "empty"


def test_the_file_made_again_keeps_its_other_columns(cal: TestClient) -> None:
    tabs = {"Tulsa": [[*STANDARD, "Owner"], [*BAD_ROW, "Kevin"]]}
    file_id = hand_in(cal, tabs)["id"]
    book = fix_file(cal, file_id)
    book["Problems"].cell(2, 7).value = "(918) 555-2222"
    send(cal, file_id, book, confirm=True)
    run_file_checker()
    lead = cal.get(f"/api/submissions/{file_id}/leads").json()["leads"][0]
    assert lead["values"]["phone"] == "(918) 555-2222"
    assert lead["extra"] == {"Owner": "Kevin"}
    assert lead["values"]["website"] == "https://facebook.com/bc"  # left as it was


def test_duplicates_are_not_in_the_fix_file_nor_fixed_through_it(cal: TestClient) -> None:
    """Step 40: duplicates are removed on the Hub only. The fix file leaves them out, and a
    file saved with other fixes keeps each duplicate's rows."""
    twice = row("Sparkle", "https://share.google/sp", "214 555 0100", city="Dallas")
    tabs = {"Dallas": [STANDARD, twice, twice], "Tulsa": [STANDARD, BAD_ROW]}
    sub = hand_in(cal, tabs)
    assert {p["code"] for p in sub["problems"]} >= {"SAME_IN_FILE", "PHONE_HAS_LETTERS"}
    sheet = fix_file(cal, sub["id"])["Problems"]
    assert [r[1] for r in rows(sheet)[1:]] == ["Bad Co"]  # Sparkle isn't there
    sheet.cell(2, 6).value = "https://badco.com"
    sheet.cell(2, 7).value = "(918) 555-2222"
    book = sheet.parent
    assert send(cal, sub["id"], book, confirm=True).json()["saved"] is True
    run_file_checker()
    after = cal.get(f"/api/submissions/{sub['id']}").json()
    assert [p["code"] for p in after["problems"]] == ["SAME_IN_FILE"]
    assert after["duplicates"] == {"rows": 1, "elsewhere": 0}


def test_only_duplicates_left_the_fix_file_says_to_remove_them_on_the_hub(cal: TestClient) -> None:
    twice = row("Sparkle", "https://share.google/sp", "214 555 0100", city="Dallas")
    sub = hand_in(cal, {"Dallas": [STANDARD, twice, twice]})
    sheet = fix_file(cal, sub["id"])["Problems"]
    assert rows(sheet)[1][1] == (
        "Nothing to fix here: remove the duplicates on the Hub (Remove duplicates)."
    )
