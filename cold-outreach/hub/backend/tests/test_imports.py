"""Importing lead files (SPEC section 6.4), from fixtures built like the team's real files."""

import io
import json
from collections.abc import Iterator
from typing import Any

import httpx2
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import connections, providers
from app.db.models import DoNotContact, Import, Lead, LeadList, Role, User
from app.imports import reader
from app.imports.sheet import column_letter
from tests.conftest import UserFactory, sign_in
from tests.fake_google import FakeSheets
from tests.hub_data import batch_id

STANDARD = [
    "Business name",
    "MAP",
    "Address",
    "City",
    "Website",
    "Phone",
    "WA",
    "Facebook",
    "Instagram",
    "Email",
    "Reviews",
    "Average",
]


def workbook(tabs: dict[str, list[list[Any]]]) -> bytes:
    book = Workbook()
    book.remove(book.active)  # type: ignore[arg-type]
    for title, rows in tabs.items():
        sheet = book.create_sheet(title)
        for line in rows:
            sheet.append(line)
        for cells in sheet.iter_rows():
            for cell in cells:
                if isinstance(cell.value, str) and cell.value.startswith("="):
                    cell.data_type = "s"  # text that looks like a formula, as people type it
    out = io.BytesIO()
    book.save(out)
    return out.getvalue()


def row(
    name: str, link: str, phone: str, email: str = "", city: str = "Tulsa", **extra: Any
) -> list[Any]:
    values = {
        "Business name": name,
        "MAP": link,
        "Address": f"1 {name} St, {city}",
        "City": city,
        "Website": extra.get("website", f"https://{name.lower().replace(' ', '')}.com/"),
        "Phone": phone,
        "WA": "",
        "Facebook": "",
        "Instagram": "",
        "Email": email,
        "Reviews": 12,
        "Average": 4.5,
    }
    return [values[h] for h in STANDARD]


# --- reading -----------------------------------------------------------------------------------


def test_variant_headers_and_a_missing_city_column() -> None:
    content = workbook(
        {
            "Dallas": [
                [
                    "Business Name ",
                    "Map URl",
                    "Address ",
                    "Website ",
                    "Phone ",
                    "Whatsapp",
                    "Facebook",
                    "instagram",
                    "Gmail",
                    "Number of Reviews",
                    "Average Ratings",
                    "Comment",
                    "Operation Hour",
                ],
                [
                    "Sparkle Co\n",
                    "https://share.google/abc",
                    " 1 Main St ",
                    "https://sparkle.com/?utm_source=gmb&utm_medium=x&page=2",
                    "(214) 555-0100",
                    "Yes",
                    "",
                    "",
                    "INFO@Sparkle.com\n",
                    33,
                    4.9,
                    "call after 5",
                    "9-5",
                ],
            ]
        }
    )

    report = reader.read(content, "Cleaning")

    [lead] = report.leads
    assert lead.values["city"] == "Dallas"  # from the tab name
    assert lead.values["business_name"] == "Sparkle Co"
    assert lead.values["website"] == "https://sparkle.com/?page=2"
    assert lead.values["whatsapp"] == "Yes"
    assert (lead.values["reviews"], lead.values["rating"]) == ("33", "4.9")
    assert lead.values["notes"] == "call after 5"
    assert lead.emails == ["info@sparkle.com"]
    assert report.unknown_columns == {"Operation Hour": ["Dallas"]}


def test_same_phone_and_two_emails_become_one_lead() -> None:
    content = workbook(
        {
            "Aurora": [
                STANDARD,
                row("Four Star Drywall", "", "(303) 238-5594", "contactus@fourstar.com"),
                row("Four Star Drywall", "", "(303) 238-5594", "Tony.jr@fourstar.com"),
            ]
        }
    )

    report = reader.read(content, "Construction")

    [lead] = report.leads
    assert lead.emails == ["contactus@fourstar.com", "tony.jr@fourstar.com"]
    assert report.merged_rows == [["Aurora row 2", "Aurora row 3"]]


def test_one_phone_but_a_profile_per_city_stays_separate() -> None:
    content = workbook(
        {
            "Knoxville": [STANDARD, row("MaidPro", "https://share.google/knox", "(865) 555-0100")],
            "Chattanooga": [
                STANDARD,
                row("MaidPro", "https://share.google/chatt", "(865) 555-0100", city="Chattanooga"),
            ],
        }
    )

    assert len(reader.read(content, "Cleaning").leads) == 2


def test_city_filled_down_an_empty_tab_is_not_a_business() -> None:
    content = workbook(
        {
            "Jackson": [STANDARD, *([["", "", "", "Jackson"]] * 50)],
            "Tulsa": [STANDARD, row("Level Up", "https://share.google/lvl", "918 555 0101")],
        }
    )

    report = reader.read(content, "Cleaning")

    assert len(report.leads) == 1
    assert report.empty_tabs == ["Jackson"]
    assert report.skipped_rows == []


def test_a_row_with_only_a_name_matches_by_name_and_city() -> None:
    content = workbook(
        {
            "San Jose": [
                ["Business name", "City", "Email"],
                ["MOLLY MAID of S. Silicon Valley", "San Jose", "a@mm.com"],
                ["Molly Maid of S Silicon Valley", "San Jose", "b@mm.com"],
                ["Molly Maid of S Silicon Valley", "Fremont", ""],
            ]
        }
    )

    report = reader.read(content, "Cleaning")

    assert [lead.emails for lead in report.leads] == [["a@mm.com", "b@mm.com"], []]


def test_bad_emails_are_listed_and_encoded_spaces_cleaned() -> None:
    content = workbook(
        {"Tulsa": [STANDARD, row("A", "https://share.google/a", "1", "support@a.com%20, http:")]}
    )

    report = reader.read(content, "Cleaning")

    assert report.leads[0].emails == ["support@a.com"]
    assert report.invalid_emails == ["Tulsa row 2: http:"]


def test_not_an_excel_file() -> None:
    with pytest.raises(reader.ReadError, match="isn't an Excel file"):
        reader.read(b"name,phone\nA,1\n", "Cleaning")


# --- the API -----------------------------------------------------------------------------------


@pytest.fixture
def owner(client: TestClient, make_user: UserFactory) -> User:
    user = make_user(Role.OWNER, name="Olivia")
    sign_in(client, user.email)
    return user


@pytest.fixture
def google(
    client: TestClient, owner: User, monkeypatch: pytest.MonkeyPatch
) -> Iterator[FakeSheets]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    account = {
        "type": "service_account",
        "client_email": "hub@p.iam.gserviceaccount.com",
        "private_key": pem,
        "token_uri": "https://oauth2.googleapis.com/token",
    }
    client.patch(
        "/api/connections",
        json={
            "values": {
                "google_service_account": json.dumps(account),
                "google_sheet_url": "https://docs.google.com/spreadsheets/d/1SheetIdAbCdEfGhIjKlMn/",
                "google_drive_folder_url": "https://drive.google.com/drive/folders/1FolderIdAbCd",
            }
        },
    )
    connections.invalidate()
    fake = FakeSheets()
    monkeypatch.setattr(providers, "transport", httpx2.MockTransport(fake.handle))
    yield fake


def upload(client: TestClient, content: bytes, batch: str = "Batch 1") -> dict[str, Any]:
    response = client.post(
        "/api/imports",
        files={"file": ("leads.xlsx", content)},
        data={"batch_id": batch_id(client, batch)},
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


FILE = {
    "Tulsa": [
        [*STANDARD, "Level"],
        [*row("Multi-Clean", "https://share.google/mc", "(918) 523-8300", "kevin@mc.com"), ""],
        [*row("Top Shine", "https://share.google/ts", "(918) 555-0000", "boss@ts.com"), "Top"],
        [*row("No Map Co", "", "(918) 555-1111", '=HYPERLINK("x")'), ""],
    ],
    "Dallas": [STANDARD, row("Sparkle", "https://share.google/sp", "214 555 0100", city="Dallas")],
}


def test_preview_writes_nothing_but_the_import(
    client: TestClient, google: FakeSheets, db: Session
) -> None:
    body = upload(client, workbook(FILE))

    assert body["status"] == "preview"
    counts = body["counts"]
    assert (counts["leads"], counts["new"], counts["top"], counts["no_gbp_link"]) == (4, 4, 1, 1)
    assert counts["invalid_emails"] == 1
    assert sorted(body["preview"]["new_lists"]) == ["Dallas", "Tulsa"]
    assert body["preview"]["top"] == ["Top Shine (Tulsa row 3)"]
    assert google.writes == 0
    assert db.scalar(select(Lead.lead_id)) is None


def test_confirm_gives_ids_writes_the_sheet_and_protects_top_leads(
    client: TestClient, google: FakeSheets, db: Session
) -> None:
    preview = upload(client, workbook(FILE))

    done = client.post(f"/api/imports/{preview['id']}/confirm")

    assert done.status_code == 200, done.text
    assert done.json()["counts"]["sheet_added"] == 4
    table = google.table()
    assert [r["Lead ID"] for r in table] == ["L-000001", "L-000002", "L-000003", "L-000004"]
    first = table[0]
    assert (first["City"], first["Niche"], first["Batch"], first["Business Name"]) == (
        "Tulsa",
        "Cleaning",
        "Batch 1",
        "Multi-Clean",
    )
    assert first["Email"] == "kevin@mc.com"
    assert db.get(Lead, "L-000001").batch_id is not None  # type: ignore[union-attr]
    assert table[1]["Level"] == "Top"
    blocked = {(d.kind, d.value) for d in db.scalars(select(DoNotContact))}
    assert blocked == {
        ("gbp", "https://share.google/ts"),
        ("phone", "9185550000"),
        ("email", "boss@ts.com"),
    }
    lists = {(x.city, x.niche) for x in db.scalars(select(LeadList))}
    assert lists == {("Tulsa", "Cleaning"), ("Dallas", "Cleaning")}
    assert db.get(Import, preview["id"]).rows == []  # type: ignore[union-attr]


def test_a_formula_in_a_cell_stays_text(client: TestClient, google: FakeSheets) -> None:
    content = workbook(
        {"Tulsa": [STANDARD, row("=1+1", "https://share.google/f", "1", city="Tulsa")]}
    )
    preview = upload(client, content)
    client.post(f"/api/imports/{preview['id']}/confirm")

    # The fake checks every write uses valueInputOption=RAW, so this stays text in Google.
    assert google.table()[0]["Business Name"] == "=1+1"


def test_a_second_import_updates_instead_of_adding(
    client: TestClient, google: FakeSheets, db: Session
) -> None:
    first = upload(client, workbook(FILE))
    client.post(f"/api/imports/{first['id']}/confirm")
    # Someone sorts the tab and an agent fills its column; neither may be disturbed.
    google.tabs["Leads"][0].append("GBP Score")
    for line in google.tabs["Leads"][1:]:
        line.extend([""] * (17 - len(line)) + ["77"])
    google.tabs["Leads"][1:] = list(reversed(google.tabs["Leads"][1:]))
    again = workbook(
        {
            "Tulsa": [
                STANDARD,
                row(
                    "Multi-Clean",
                    "https://share.google/mc",
                    "(918) 523-8300",
                    "new@mc.com",
                    website="",
                ),
                row("Brand New", "https://share.google/bn", "(918) 555-2222"),
            ]
        }
    )

    preview = upload(client, again)
    assert (preview["counts"]["new"], preview["counts"]["updated"]) == (1, 1)
    client.post(f"/api/imports/{preview['id']}/confirm")

    table = {r["Lead ID"]: r for r in google.table()}
    assert len(table) == 5
    multi = table["L-000001"]
    assert multi["Email"] == "kevin@mc.com, new@mc.com"
    assert multi["Website"] == "https://multi-clean.com/"  # an empty cell never blanks it
    assert multi["GBP Score"] == "77"  # the agent's column is untouched
    assert table["L-000002"]["Level"] == "Top"  # this file had no Level column
    assert table["L-000005"]["Business Name"] == "Brand New"
    assert db.get(Lead, "L-000001").emails == ["kevin@mc.com", "new@mc.com"]  # type: ignore[union-attr]


def test_a_new_sheet_gets_its_leads_tab(client: TestClient, google: FakeSheets) -> None:
    assert "Leads" not in google.tabs
    preview = upload(client, workbook(FILE))
    client.post(f"/api/imports/{preview['id']}/confirm")

    header = google.tabs["Leads"][0]
    assert header[:5] == ["Lead ID", "City", "Niche", "Batch", "Level"]
    assert len(header) == 17 and column_letter(len(header) - 1) == "Q"


def test_a_failed_sheet_write_saves_nothing_and_can_be_retried(
    client: TestClient, google: FakeSheets, db: Session
) -> None:
    google.tabs["Leads"] = [["Lead ID"]]
    preview = upload(client, workbook(FILE))
    google.fail_writes = True

    failed = client.post(f"/api/imports/{preview['id']}/confirm")

    assert failed.status_code == 502
    assert "Nothing was saved" in failed.json()["error"]["message"]
    assert db.scalar(select(Lead.lead_id)) is None
    google.fail_writes = False
    assert client.post(f"/api/imports/{preview['id']}/confirm").status_code == 200
    assert google.table()[0]["Lead ID"] == "L-000001"


def test_confirm_needs_google(client: TestClient, owner: User) -> None:
    preview = upload(client, workbook(FILE))

    response = client.post(f"/api/imports/{preview['id']}/confirm")

    assert (response.status_code, response.json()["error"]["code"]) == (409, "no_google")


def test_discard_and_confirm_only_once(client: TestClient, google: FakeSheets) -> None:
    preview = upload(client, workbook(FILE))

    assert client.post(f"/api/imports/{preview['id']}/discard").json()["status"] == "discarded"
    assert client.post(f"/api/imports/{preview['id']}/confirm").status_code == 409


def test_bad_uploads(client: TestClient, owner: User) -> None:
    batch = batch_id(client)
    not_excel = client.post(
        "/api/imports", files={"file": ("a.csv", b"a,b\n1,2")}, data={"batch_id": batch}
    )
    no_batch = client.post("/api/imports", files={"file": ("a.xlsx", workbook(FILE))})
    unknown = client.post(
        "/api/imports",
        files={"file": ("a.xlsx", workbook(FILE))},
        data={"batch_id": "00000000-0000-0000-0000-000000000000"},
    )

    assert (not_excel.status_code, not_excel.json()["error"]["code"]) == (422, "unreadable")
    assert no_batch.status_code == 422
    assert unknown.status_code == 404


def test_a_business_stays_in_the_batch_it_came_in(
    client: TestClient, google: FakeSheets, db: Session
) -> None:
    first = upload(client, workbook(FILE))
    client.post(f"/api/imports/{first['id']}/confirm")
    again = workbook(
        {
            "Tulsa": [
                STANDARD,
                row("Multi-Clean", "https://share.google/mc", "(918) 523-8300", "new@mc.com"),
                row("Brand New", "https://share.google/bn", "(918) 555-2222"),
            ]
        }
    )

    preview = upload(client, again, batch="Batch 2")
    counts = preview["counts"]
    assert (counts["new"], counts["updated"], counts["other_batch"]) == (1, 0, 1)
    assert preview["preview"]["other_batch"] == ["Multi-Clean (L-000001, in Batch 1)"]
    client.post(f"/api/imports/{preview['id']}/confirm")

    table = {r["Lead ID"]: r for r in google.table()}
    assert table["L-000001"]["Batch"] == "Batch 1"
    assert table["L-000001"]["Email"] == "kevin@mc.com, new@mc.com"  # still updated
    assert table["L-000005"]["Batch"] == "Batch 2"
    batches = {b["name"]: b for b in client.get("/api/batches").json()}
    assert (batches["Batch 1"]["leads"], batches["Batch 2"]["leads"]) == (4, 1)
    assert batches["Batch 2"]["files"] == 1
    mine = client.get("/api/imports", params={"batch_id": batches["Batch 2"]["id"]}).json()
    assert [(i["file_name"], i["batch_name"]) for i in mine] == [("leads.xlsx", "Batch 2")]


@pytest.mark.parametrize("role", [Role.VIEWER])
def test_viewers_see_but_cannot_import(
    client: TestClient, google: FakeSheets, make_user: UserFactory, role: Role
) -> None:
    preview = upload(client, workbook(FILE))
    client.cookies.clear()
    sign_in(client, make_user(role).email)

    assert client.get("/api/imports").status_code == 200
    assert client.get(f"/api/imports/{preview['id']}").status_code == 200
    assert client.post(f"/api/imports/{preview['id']}/confirm").status_code == 403
    denied = client.post(
        "/api/imports",
        files={"file": ("a.xlsx", workbook(FILE))},
        data={"batch_id": preview["batch_id"]},
    )
    assert denied.status_code == 403


def test_lists_count_leads_and_can_be_switched_off(client: TestClient, google: FakeSheets) -> None:
    preview = upload(client, workbook(FILE))
    client.post(f"/api/imports/{preview['id']}/confirm")

    lists = {x["city"]: x for x in client.get("/api/lists").json()}
    tulsa = lists["Tulsa"]
    changed = client.patch(f"/api/lists/{tulsa['id']}", json={"active": False, "daily_limit": 20})

    assert (tulsa["leads"], tulsa["top"]) == (3, 1)
    assert changed.json() | {"active": False, "daily_limit": 20} == changed.json()
