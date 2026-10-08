"""Reading Excel and CSV files (SPEC sections 6.1 and 6.3)."""

from datetime import date, datetime, time
from pathlib import Path

import pytest
from openpyxl import Workbook

from app.chunking import MAX, chunk_sheet, count_tokens, row_text
from app.files import sniff
from app.files.extract_sheet import (
    DAMAGED_XLSX,
    UNCALCULATED,
    build_sheet,
    cell_text,
    extract_csv,
    extract_xlsx,
)
from app.files.sheets import Sheet
from app.jobs.queue import PermanentError

FIXTURES = Path(__file__).parent / "files" / "fixtures"


# --- a real workbook calculated by a spreadsheet program ---------------------------------


def test_reads_every_sheet_with_saved_formula_results() -> None:
    book = extract_xlsx(FIXTURES / "fees-calculated.xlsx")

    assert book.warning is None
    assert [s.name for s in book.sheets] == ["Fees 2026", "Contacts"]  # hidden kept, empty gone
    fees = book.sheets[0]
    assert fees.notes == ["Client fees 2026", "Updated monthly by Sara"]
    assert fees.headers == [
        "Client",
        "Plan",
        "Monthly fee",
        "Discount",
        "Start date",
        "Locations",
        "Total",
        "Notes",  # the empty column H is skipped
    ]
    assert fees.rows == [
        (
            5,
            [
                "Acme Plumbing",
                "Pro",
                "$900",
                "10%",
                "2026-01-15",
                "3",
                "$810.00",
                "Annual contract",
            ],
        ),
        (6, ["Café Rio", "Basic", "$500", "0%", "2026-03-01", "1", "$500.00", ""]),
        (
            7,
            [
                "Bright Dental",
                "Agency",
                "$2,000",
                "15%",
                "2025-11-20",
                "10",
                "$1,700.00",
                "Pays quarterly",
            ],
        ),
        (
            9,
            ["North Gym", "Pro", "$900", "5%", "2026-06-01", "2", "$855.00", ""],
        ),  # blank row 8 skipped
    ]


def test_a_workbook_whose_formulas_were_never_calculated_gets_a_warning(tmp_path: Path) -> None:
    wb = Workbook()
    ws = wb.active
    assert ws is not None
    ws.append(["Item", "Price", "With tax"])
    ws.append(["Audit", 100, "=B2*1.2"])
    wb.save(tmp_path / "script.xlsx")

    book = extract_xlsx(tmp_path / "script.xlsx")

    assert book.warning == UNCALCULATED
    assert book.sheets[0].rows == [(2, ["Audit", "100", ""])]


def test_a_damaged_workbook_fails_for_good(tmp_path: Path) -> None:
    path = tmp_path / "broken.xlsx"
    path.write_bytes(b"PK\x03\x04 nope")

    with pytest.raises(PermanentError) as refused:
        extract_xlsx(path)
    assert str(refused.value) == DAMAGED_XLSX


def test_a_password_protected_workbook_is_refused_at_upload(tmp_path: Path) -> None:
    with pytest.raises(sniff.SniffError) as refused:
        sniff.detect(FIXTURES / "locked.xlsx", "locked.xlsx")

    assert str(refused.value) == sniff.PROTECTED


# --- cell values ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "number_format", "shown"),
    [
        (None, "General", ""),
        (True, "General", "TRUE"),
        (3, "General", "3"),
        (0.1 + 0.2, "General", "0.3"),
        (1234567.891, "General", "1234567.891"),
        (2000, '"$"#,##0', "$2,000"),
        (1700, '"$"#,##0.00', "$1,700.00"),
        (-50, "$#,##0;($#,##0)", "-$50"),
        (0.15, "0%", "15%"),
        (0.125, "0.0%", "12.5%"),
        (1234.5, '#,##0.00 "€"', "€1,234.50"),
        (datetime(2026, 1, 15), "yyyy-mm-dd", "2026-01-15"),
        (datetime(2026, 1, 15, 9, 30), "General", "2026-01-15 09:30"),
        (date(2026, 1, 15), "General", "2026-01-15"),
        (time(14, 5), "General", "14:05"),
        ("  two\nlines  ", "General", "two lines"),
    ],
)
def test_cell_text(value: object, number_format: str, shown: str) -> None:
    assert cell_text(value, number_format) == shown


# --- finding the header row ---------------------------------------------------------------


def rows(*lines: list[str]) -> list[tuple[int, list[str]]]:
    return list(enumerate(lines, start=1))


def test_the_first_row_is_the_header_when_it_looks_like_one() -> None:
    sheet = build_sheet("S", rows(["Client", "Fee"], ["Acme", "500"]))

    assert sheet is not None
    assert (sheet.headers, sheet.rows, sheet.notes) == (
        ["Client", "Fee"],
        [(2, ["Acme", "500"])],
        [],
    )


def test_title_lines_above_the_header_become_notes() -> None:
    sheet = build_sheet(
        "S", rows(["Leads – October"], [], ["Name", "Source", "Value"], ["Ann", "Reddit", "200"])
    )

    assert sheet is not None
    assert sheet.notes == ["Leads – October"]
    assert sheet.headers == ["Name", "Source", "Value"]
    assert sheet.rows == [(4, ["Ann", "Reddit", "200"])]


def test_without_a_header_like_row_the_first_row_is_used() -> None:
    sheet = build_sheet("S", rows(["1", "2"], ["3", "4"]))

    assert sheet is not None
    assert sheet.headers == ["1", "2"]


def test_a_single_column_sheet_has_a_header() -> None:
    sheet = build_sheet("S", rows(["Keyword"], ["plumber near me"], ["emergency plumber"]))

    assert sheet is not None
    assert sheet.headers == ["Keyword"]
    assert len(sheet.rows) == 2


def test_blank_and_repeated_headers_get_names() -> None:
    sheet = build_sheet("S", rows(["Name", "", "Name"], ["Ann", "x", "Bo"]))

    assert sheet is not None
    assert sheet.headers == ["Name", "Column B", "Name (2)"]


def test_ragged_rows_and_empty_columns() -> None:
    sheet = build_sheet("S", rows(["A", "B"], ["1", "", "", "extra"], ["2"]))

    assert sheet is not None
    assert sheet.headers == ["A", "B", "Column D"]  # C has neither a name nor values
    assert sheet.rows == [(2, ["1", "", "extra"]), (3, ["2", "", ""])]


def test_an_empty_sheet_is_nothing() -> None:
    assert build_sheet("S", rows([], ["", ""])) is None


# --- CSV ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("content", "encoding"),
    [
        ("Client,Fee\nAcme,500\n", "utf-8"),
        ("﻿Client;Fee\r\nAcme;500\r\n", "utf-8"),  # Excel's UTF-8 CSV in Europe
        ("Client\tFee\nAcme\t500\n", "utf-8"),
        ("Client,Fee\nAcme,500\n", "cp1252"),
    ],
)
def test_csv_delimiters_and_encodings(tmp_path: Path, content: str, encoding: str) -> None:
    path = tmp_path / "fees.csv"
    path.write_bytes(content.encode(encoding))

    [sheet] = extract_csv(path).sheets

    assert (sheet.name, sheet.headers, sheet.rows) == (
        None,
        ["Client", "Fee"],
        [(2, ["Acme", "500"])],
    )


def test_csv_quoted_cells_and_windows_characters(tmp_path: Path) -> None:
    path = tmp_path / "fees.csv"
    path.write_bytes('Client,Note\n"Café Rio","Pays late, usually\nby a week"\n\n'.encode("cp1252"))

    [sheet] = extract_csv(path).sheets

    assert sheet.rows == [(2, ["Café Rio", "Pays late, usually by a week"])]


def test_an_empty_csv_has_no_sheets(tmp_path: Path) -> None:
    path = tmp_path / "empty.csv"
    path.write_text("\n\n")

    assert extract_csv(path).sheets == []


# --- chunking rows ------------------------------------------------------------------------


def test_row_text_leaves_out_empty_cells() -> None:
    assert row_text(7, ["Client", "Fee", "Notes"], ["Acme", "$500", ""]) == (
        "Row 7: Client: Acme; Fee: $500"
    )


def test_every_chunk_starts_with_the_file_sheet_and_columns() -> None:
    sheet = Sheet(
        "Leads",
        ["Name", "Email", "Source", "Notes"],
        [
            (n, [f"Person {n}", f"p{n}@example.com", "Reddit", "Asked about pricing"])
            for n in range(2, 300)
        ],
        notes=["Leads for October"],
    )

    chunks = chunk_sheet("Leads.xlsx", sheet)

    assert len(chunks) > 3
    intro = (
        "File: Leads.xlsx — Sheet: Leads\nLeads for October\nColumns: Name; Email; Source; Notes"
    )
    seen: list[str] = []
    for chunk in chunks:
        assert chunk.text.startswith(intro + "\n\n")
        assert chunk.token_count <= MAX
        assert (chunk.sheet, chunk.heading, chunk.page_from) == ("Leads", "Leads", None)
        seen += chunk.text.split("\n\n", 1)[1].splitlines()
    assert seen == [row_text(n, sheet.headers, cells) for n, cells in sheet.rows]  # no overlap


def test_a_csv_chunk_has_no_sheet_name() -> None:
    [chunk] = chunk_sheet("fees.csv", Sheet(None, ["Client"], [(2, ["Acme"])]))

    assert chunk.text == "File: fees.csv\nColumns: Client\n\nRow 2: Client: Acme"
    assert chunk.sheet is None


def test_a_row_with_a_huge_cell_is_split_and_keeps_its_row_number() -> None:
    essay = " ".join(f"word{n}" for n in range(2000))
    sheet = Sheet("Notes", ["Client", "Note"], [(4, ["Acme", essay])])

    chunks = chunk_sheet("notes.xlsx", sheet)

    assert len(chunks) > 1
    assert all(c.token_count <= MAX for c in chunks)
    assert chunks[0].text.split("\n\n", 1)[1].startswith("Row 4: Client: Acme; Note: word0")
    assert chunks[1].text.split("\n\n", 1)[1].startswith("Row 4 (continued): ")


def test_a_sheet_with_only_column_names_is_one_small_chunk() -> None:
    [chunk] = chunk_sheet("t.xlsx", Sheet("Template", ["Client", "Fee"], []))

    assert chunk.text == "File: t.xlsx — Sheet: Template\nColumns: Client; Fee"
    assert count_tokens(chunk.text) == chunk.token_count
