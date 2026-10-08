"""Pick the reader for a file type and describe anything it had to skip."""

from dataclasses import dataclass, field
from pathlib import Path

from app.files import sniff
from app.files.blocks import Block, Extracted
from app.files.extract_docx import extract_docx
from app.files.extract_pdf import extract_pdf
from app.files.extract_sheet import extract_csv, extract_xlsx
from app.files.sheets import Sheet


@dataclass
class Result:
    blocks: list[Block]
    page_count: int | None
    warning: str | None
    sheets: list[Sheet] = field(default_factory=list)
    sheet_count: int | None = None


def _pages(count: int) -> str:
    return "1 page looks" if count == 1 else f"{count} pages look"


def extract(path: Path, mime: str) -> Result:
    if mime == sniff.PDF.mime:
        found: Extracted = extract_pdf(path)
        warning = None
        if found.scanned_pages:
            # OCR (build step 6) will read these; until then they are skipped.
            warning = (
                f"{_pages(len(found.scanned_pages))} scanned and will be read once "
                "scanned-page reading is switched on."
            )
        return Result(found.blocks, found.page_count, warning)
    if mime == sniff.DOCX.mime:
        found = extract_docx(path)
        return Result(found.blocks, found.page_count, None)
    if mime in (sniff.XLSX.mime, sniff.CSV.mime):
        book = extract_xlsx(path) if mime == sniff.XLSX.mime else extract_csv(path)
        count = len(book.sheets) if mime == sniff.XLSX.mime else None
        return Result([], None, book.warning, book.sheets, count)
    return Result([], None, "Images will be read once scanned-page reading is switched on.")
