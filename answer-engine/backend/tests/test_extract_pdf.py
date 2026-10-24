"""Reading PDFs into blocks (SPEC section 6.1)."""

from pathlib import Path

import pymupdf
import pytest

from app.files.extract_pdf import DAMAGED, PROTECTED_PDF, extract_pdf
from app.jobs.queue import PermanentError
from tests.files.build import LOREM, image_page, locked_pdf, pdf, table, text


def test_headings_paragraphs_and_tables_in_reading_order(tmp_path: Path) -> None:
    def page(p: pymupdf.Page) -> None:
        y = text(p, 60, "Pricing Guide", size=24)
        y = text(p, y, LOREM)
        y = text(p, y, "Plans and fees", size=16)
        y = table(p, y, [["Plan", "Fee"], ["Basic", "$500"], ["Pro", "$900"]])
        text(p, y, "Invoices are sent on the 1st of the month.")

    result = extract_pdf(pdf(tmp_path / "a.pdf", page))

    assert [(b.kind, b.level if b.kind == "heading" else None) for b in result.blocks] == [
        ("heading", 1),
        ("text", None),
        ("heading", 2),
        ("table", None),
        ("text", None),
    ]
    assert result.blocks[0].text == "Pricing Guide"
    assert result.blocks[1].text == LOREM
    assert result.blocks[3].text.splitlines() == [
        "| Plan | Fee |",
        "|---|---|",
        "| Basic | $500 |",
        "| Pro | $900 |",
    ]
    assert result.page_count == 1
    assert result.scanned_pages == []


def test_table_text_is_not_repeated_as_paragraphs(tmp_path: Path) -> None:
    def page(p: pymupdf.Page) -> None:
        y = text(p, 60, LOREM)
        table(p, y, [["Plan", "Fee"], ["Basic", "$500"]])

    blocks = extract_pdf(pdf(tmp_path / "a.pdf", page)).blocks

    assert sum("Basic" in b.text for b in blocks) == 1


def test_heading_levels_rank_the_sizes_used(tmp_path: Path) -> None:
    def page(p: pymupdf.Page) -> None:
        y = text(p, 60, "Handbook", size=20)
        y = text(p, y, "Onboarding", size=14)
        y = text(p, y, LOREM)
        y = text(p, y, "Checklist", size=13)
        y = text(p, y, LOREM)
        y = text(p, y, "Notes", bold=True)
        text(p, y, LOREM)

    blocks = extract_pdf(pdf(tmp_path / "a.pdf", page)).blocks

    assert [(b.text, b.level) for b in blocks if b.kind == "heading"] == [
        ("Handbook", 1),
        ("Onboarding", 2),
        ("Checklist", 3),
        ("Notes", 4),
    ]


def test_a_heading_sharing_a_block_with_its_paragraph_is_split_off(tmp_path: Path) -> None:
    def page(p: pymupdf.Page) -> None:
        # One text box: a large heading line straight above body lines, as LibreOffice
        # and Word exports often produce.
        p.insert_text((72, 80), "Billing", fontsize=16)
        text(p, 84, LOREM)

    blocks = extract_pdf(pdf(tmp_path / "a.pdf", page)).blocks

    assert [(b.kind, b.text) for b in blocks] == [("heading", "Billing"), ("text", LOREM)]


def test_bold_short_lines_are_headings(tmp_path: Path) -> None:
    def page(p: pymupdf.Page) -> None:
        y = text(p, 60, LOREM)
        y = text(p, y, "Reporting", bold=True)
        text(p, y, LOREM)

    blocks = extract_pdf(pdf(tmp_path / "a.pdf", page)).blocks

    assert [(b.kind, b.text) for b in blocks if b.kind == "heading"] == [("heading", "Reporting")]


def test_words_split_across_lines_are_joined(tmp_path: Path) -> None:
    def page(p: pymupdf.Page) -> None:
        text(p, 60, "Payment is due within four-\nteen days of the invoice date.")

    [block] = extract_pdf(pdf(tmp_path / "a.pdf", page)).blocks

    assert block.text == "Payment is due within fourteen days of the invoice date."


def test_page_numbers_and_running_headers(tmp_path: Path) -> None:
    def page(n: int):  # type: ignore[no-untyped-def]
        def write(p: pymupdf.Page) -> None:
            p.insert_text((72, 30), "GridRankers — Confidential", fontsize=9)
            text(p, 80, f"Content of page {n}. " + LOREM)
            p.insert_text((280, p.rect.height - 25), f"Page {n} of 4", fontsize=9)

        return write

    result = extract_pdf(pdf(tmp_path / "a.pdf", *(page(n) for n in range(1, 5))))

    assert [(b.page, b.text[:17]) for b in result.blocks] == [
        (1, "Content of page 1"),
        (2, "Content of page 2"),
        (3, "Content of page 3"),
        (4, "Content of page 4"),
    ]
    assert result.page_count == 4


def test_scanned_pages_are_listed_not_read(tmp_path: Path) -> None:
    def typed(p: pymupdf.Page) -> None:
        text(p, 60, LOREM)

    def blank(p: pymupdf.Page) -> None:
        p.insert_text((72, 60), "12", fontsize=9)  # a stray page number only

    result = extract_pdf(pdf(tmp_path / "a.pdf", typed, image_page, blank, typed))

    assert result.scanned_pages == [2, 3]
    assert {b.page for b in result.blocks} == {1, 4}
    assert result.page_count == 4


def test_password_protected_pdf_fails_for_good(tmp_path: Path) -> None:
    path = locked_pdf(tmp_path / "locked.pdf")

    with pytest.raises(PermanentError, match="password-protected") as refused:
        extract_pdf(path)
    assert str(refused.value) == PROTECTED_PDF


def test_damaged_pdf_fails_for_good(tmp_path: Path) -> None:
    path = tmp_path / "broken.pdf"
    path.write_bytes(b"%PDF-1.7\n this is not really a pdf")

    with pytest.raises(PermanentError) as refused:
        extract_pdf(path)
    assert str(refused.value) == DAMAGED
