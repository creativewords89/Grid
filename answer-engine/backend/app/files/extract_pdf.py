"""Read a PDF into blocks with PyMuPDF (SPEC section 6.1).

- Headings are lines set noticeably larger (or bold and short) than the body text.
- Tables found by PyMuPDF become Markdown tables, in reading order.
- Lines repeated at the top or bottom of most pages (running headers, page numbers) are dropped.
- Pages with almost no text, or mostly an image with little text, are listed as scanned
  for OCR (build step 6) instead of being read here.
"""

import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pymupdf

from app.files.blocks import Block, BlockKind, Extracted
from app.jobs.queue import PermanentError

pymupdf.no_recommend_layout()  # keep its install suggestion out of the worker log

SCANNED_MAX_CHARS = 30
IMAGE_PAGE_SHARE = 0.7
IMAGE_PAGE_MAX_CHARS = 200
MARGIN_SHARE = 0.08  # top and bottom 8% of the page hold running headers and footers

PROTECTED_PDF = "This PDF is password-protected. Remove the password and upload it again."
DAMAGED = "This PDF is damaged and can't be read. Try saving it again as PDF."


@dataclass
class _Line:
    text: str
    size: float
    bold: bool


@dataclass
class _TextBlock:
    y: float
    x: float
    lines: list[_Line]
    margin: bool  # in the top or bottom band of the page

    @property
    def text(self) -> str:
        return _join_lines([line.text for line in self.lines])


def _join_lines(lines: list[str]) -> str:
    out = ""
    for line in (ln.strip() for ln in lines):
        if not line:
            continue
        if out.endswith("-") and line[:1].islower():
            out = out[:-1] + line  # re-join a word hyphenated across lines
        else:
            out = f"{out} {line}" if out else line
    return out


def _line(raw: dict[str, Any]) -> _Line:
    spans = [s for s in raw["spans"] if s["text"].strip()]
    text = "".join(s["text"] for s in raw["spans"])
    if not spans:
        return _Line(text, 0.0, False)
    size = max(s["size"] for s in spans)
    bold = all(s["flags"] & 16 or "bold" in s["font"].lower() for s in spans)
    return _Line(text, size, bold)


def _style_groups(lines: list[_Line]) -> list[list[_Line]]:
    groups: list[list[_Line]] = []
    for line in lines:
        style = (round(line.size * 2) / 2, line.bold)
        last = groups[-1][-1] if groups else None
        if last is not None and (round(last.size * 2) / 2, last.bold) == style:
            groups[-1].append(line)
        else:
            groups.append([line])
    return groups


def _overlap_share(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    x0, y0, x1, y1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    area = (a[2] - a[0]) * (a[3] - a[1])
    if x1 <= x0 or y1 <= y0 or area <= 0:
        return 0.0
    return (x1 - x0) * (y1 - y0) / area


def _image_share(page: pymupdf.Page) -> float:
    page_area = page.rect.width * page.rect.height
    covered = 0.0
    for info in page.get_image_info():
        rect = pymupdf.Rect(info["bbox"]) & page.rect
        covered += max(rect.width, 0) * max(rect.height, 0)
    return min(covered / page_area, 1.0) if page_area else 0.0


def _tables(page: pymupdf.Page) -> list[tuple[tuple[float, ...], str]]:
    try:
        found = page.find_tables()
    except Exception:  # table detection is best effort; the text is still read
        return []
    tables = []
    for table in found.tables:
        # Built from the ruled grid only: PyMuPDF may guess a header from the text just
        # above the table (often its heading), which we don't want inside the table.
        rows = [[_cell(value) for value in row] for row in table.extract()]
        rows = [row for row in rows if any(row)]
        if len(rows) >= 2:
            tables.append((tuple(table.bbox), _markdown(rows)))
    return tables


def _cell(value: str | None) -> str:
    return " ".join((value or "").split()).replace("|", "\\|")


def _markdown(rows: list[list[str]]) -> str:
    lines = ["| " + " | ".join(rows[0]) + " |", "|" + "---|" * len(rows[0])]
    return "\n".join(lines + ["| " + " | ".join(row) + " |" for row in rows[1:]])


def _normalise(text: str) -> str:
    return re.sub(r"\d+", "#", text.strip().lower())


def _heading_size(block: _TextBlock, body_size: float) -> float | None:
    """The block's font size if it looks like a heading, else None. Bold body-size
    headings count as slightly smaller than any larger heading."""
    text = block.text
    if not text or len(block.lines) > 2 or len(text) > 120 or text.endswith((".", ":", ",")):
        return None
    size = round(max(line.size for line in block.lines) * 2) / 2
    if size >= body_size * 1.15:
        return size
    if all(line.bold for line in block.lines) and len(text) <= 80 and size >= body_size * 0.95:
        return body_size + 0.25
    return None


def extract_pdf(path: Path) -> Extracted:
    try:
        doc = pymupdf.open(path)
    except Exception as exc:
        raise PermanentError(DAMAGED) from exc
    with doc:
        if doc.needs_pass:
            raise PermanentError(PROTECTED_PDF)
        pages: list[tuple[int, list[_TextBlock], list[tuple[tuple[float, ...], str]]]] = []
        sizes: Counter[float] = Counter()
        scanned: list[int] = []
        try:
            for index in range(doc.page_count):
                number, page = index + 1, doc[index]
                text_blocks, tables, chars, page_sizes = _read_page(page)
                if chars < SCANNED_MAX_CHARS or (
                    _image_share(page) >= IMAGE_PAGE_SHARE and chars < IMAGE_PAGE_MAX_CHARS
                ):
                    scanned.append(number)
                    continue
                sizes.update(page_sizes)
                pages.append((number, text_blocks, tables))
        except PermanentError:
            raise
        except Exception as exc:
            raise PermanentError(DAMAGED) from exc
        page_count = doc.page_count

    body_size = sizes.most_common(1)[0][0] if sizes else 11.0
    repeated = _repeated_margin_lines(pages)
    # Heading levels rank the heading sizes used in this document: the biggest is level 1.
    heading_sizes = sorted(
        {
            size
            for _, text_blocks, _ in pages
            for block in text_blocks
            if (size := _heading_size(block, body_size)) is not None
        },
        reverse=True,
    )
    level_of = {size: rank + 1 for rank, size in enumerate(heading_sizes)}
    blocks: list[Block] = []
    for number, text_blocks, tables in pages:
        items: list[tuple[float, float, Block]] = []
        for block in text_blocks:
            text = block.text
            if not text or (block.margin and _normalise(text) in repeated):
                continue
            heading = _heading_size(block, body_size)
            kind: BlockKind = "heading" if heading is not None else "text"
            level = level_of[heading] if heading is not None else 1
            items.append((block.y, block.x, Block(kind, text, page=number, level=level)))
        for bbox, markdown in tables:
            items.append((bbox[1], bbox[0], Block("table", markdown, page=number)))
        blocks += [block for _, _, block in sorted(items, key=lambda item: (item[0], item[1]))]
    return Extracted(blocks=blocks, page_count=page_count, scanned_pages=scanned)


def _read_page(
    page: pymupdf.Page,
) -> tuple[list[_TextBlock], list[tuple[tuple[float, ...], str]], int, Counter[float]]:
    """Text blocks outside tables, the tables, the character count and the font sizes used
    (sizes include table text, so a short document's body size is still found)."""
    tables = _tables(page)
    sizes: Counter[float] = Counter()
    height = page.rect.height or 1.0
    text_blocks: list[_TextBlock] = []
    chars = 0
    for raw in page.get_text("dict", sort=True)["blocks"]:
        if raw.get("type") != 0:
            continue
        lines = [_line(line) for line in raw["lines"]]
        lines = [line for line in lines if line.text.strip()]
        if not lines:
            continue
        chars += sum(len(line.text.strip()) for line in lines)
        for line in lines:
            sizes[round(line.size * 2) / 2] += len(line.text.strip())
        bbox = tuple(raw["bbox"])
        if any(_overlap_share(bbox, table_bbox) > 0.5 for table_bbox, _ in tables):
            continue  # already part of a table
        margin = bbox[3] <= height * MARGIN_SHARE or bbox[1] >= height * (1 - MARGIN_SHARE)
        # PDF writers often put a heading and the paragraph after it in one block: split
        # wherever the line style changes. Each part keeps its order via a small y offset.
        for offset, group in enumerate(_style_groups(lines)):
            text_blocks.append(_TextBlock(bbox[1] + offset * 0.01, bbox[0], group, margin))
    return text_blocks, tables, chars, sizes


def _repeated_margin_lines(
    pages: list[tuple[int, list[_TextBlock], list[tuple[tuple[float, ...], str]]]],
) -> set[str]:
    """Header/footer lines (digits ignored, so page numbers match) on half the pages or more."""
    if len(pages) < 3:
        return set()
    seen: Counter[str] = Counter()
    for _, text_blocks, _ in pages:
        seen.update({_normalise(b.text) for b in text_blocks if b.margin and b.text})
    return {text for text, count in seen.items() if count >= max(3, len(pages) / 2)}
