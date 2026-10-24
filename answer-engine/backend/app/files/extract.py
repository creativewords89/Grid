"""Pick the reader for a file type, run OCR where needed, and describe anything skipped."""

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from app.ai.ocr_client import Ocr
from app.ai.usage import Usage
from app.files import sniff
from app.files.blocks import Block
from app.files.extract_docx import extract_docx
from app.files.extract_pdf import extract_pdf
from app.files.extract_sheet import extract_csv, extract_xlsx
from app.files.ocr import OcrResult, image_pages, pdf_pages, read_pages
from app.files.sheets import Sheet

NO_KEY = "can't be read until the Claude API key is set up (Owner: add ANTHROPIC_API_KEY)."

Progress = Callable[[int, int], None]


@dataclass
class Result:
    blocks: list[Block]
    page_count: int | None
    warning: str | None
    sheets: list[Sheet] = field(default_factory=list)
    sheet_count: int | None = None
    ocr_pages: int = 0
    usage: Usage = field(default_factory=Usage)


def _pages(numbers: list[int]) -> str:
    if len(numbers) == 1:
        return f"Page {numbers[0]}"
    if len(numbers) <= 5:
        return "Pages " + ", ".join(map(str, numbers[:-1])) + f" and {numbers[-1]}"
    return f"{len(numbers)} pages"


def _failed(result: OcrResult, total: int) -> str | None:
    if not result.failed_pages:
        return None
    if total == 1 and len(result.failed_pages) == 1:
        return "This page couldn't be read."
    return f"{_pages(result.failed_pages)} couldn't be read."


def extract(path: Path, mime: str, ocr: Ocr | None, progress: Progress) -> Result:
    if mime == sniff.PDF.mime:
        found = extract_pdf(path)
        scanned = found.scanned_pages
        if not scanned:
            return Result(found.blocks, found.page_count, None)
        if ocr is None:
            label = "1 scanned page" if len(scanned) == 1 else f"{len(scanned)} scanned pages"
            return Result(found.blocks, found.page_count, f"{label} {NO_KEY}")
        read = read_pages(ocr, pdf_pages(path, scanned), len(scanned), progress)
        blocks = sorted(found.blocks + read.blocks, key=lambda block: block.page or 0)
        warning = _failed(read, len(scanned))
        return Result(
            blocks, found.page_count, warning, ocr_pages=read.pages_read, usage=read.usage
        )

    if mime == sniff.DOCX.mime:
        document = extract_docx(path)
        return Result(document.blocks, document.page_count, None)

    if mime in (sniff.XLSX.mime, sniff.CSV.mime):
        book = extract_xlsx(path) if mime == sniff.XLSX.mime else extract_csv(path)
        count = len(book.sheets) if mime == sniff.XLSX.mime else None
        return Result([], None, book.warning, book.sheets, count)

    # Images: photos and scans of paper.
    if ocr is None:
        return Result([], None, f"Images {NO_KEY}")
    pages = image_pages(path)
    read = read_pages(ocr, pages, len(pages), progress)
    return Result(
        read.blocks,
        len(pages),
        _failed(read, len(pages)),
        ocr_pages=read.pages_read,
        usage=read.usage,
    )
