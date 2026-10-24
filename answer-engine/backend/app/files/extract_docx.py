"""Read a Word document into blocks with python-docx (SPEC section 6.1).

Headings come from the Title and Heading styles, list items get a "- " prefix and tables
become Markdown tables. Word stores where pages broke when the file was last saved, so
blocks get page numbers when that information is there. Images, text boxes, headers and
footers are not read in v1.
"""

import re
import zipfile
from collections.abc import Iterator
from pathlib import Path

import docx
from docx.document import Document
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph

from app.files.blocks import Block, Extracted
from app.jobs.queue import PermanentError

DAMAGED = "This Word file is damaged and can't be read. Try saving it again as .docx."


def _heading_level(paragraph: Paragraph) -> int | None:
    """0 for the Title, N for Heading N, None for body text."""
    name = (paragraph.style.name if paragraph.style is not None else "") or ""
    if name == "Title":
        return 0  # above Heading 1, so sections keep the document title in their path
    match = re.fullmatch(r"Heading (\d)", name)
    return int(match.group(1)) if match else None


def _is_list(paragraph: Paragraph) -> bool:
    name = (paragraph.style.name if paragraph.style is not None else "") or ""
    properties = paragraph._p.pPr
    return name.startswith("List") or (properties is not None and properties.numPr is not None)


def _page_breaks(element: object) -> int:
    """Page breaks inside a paragraph: rendered ones Word recorded, plus manual ones."""
    xml = element  # an lxml element
    rendered = len(xml.findall(".//" + qn("w:lastRenderedPageBreak")))  # type: ignore[attr-defined]
    breaks = xml.iter(qn("w:br"))  # type: ignore[attr-defined]
    manual = len([br for br in breaks if br.get(qn("w:type")) == "page"])
    return rendered + manual


def _cell_text(text: str) -> str:
    return " ".join(text.split()).replace("|", "\\|")


def _markdown(table: Table) -> str | None:
    rows: list[list[str]] = []
    for row in table.rows:
        cells: list[str] = []
        previous = None
        for cell in row.cells:
            if cell._tc is previous:  # a merged cell is returned once per grid column
                continue
            previous = cell._tc
            cells.append(_cell_text(cell.text))
        if any(cells):
            rows.append(cells)
    if not rows:
        return None
    width = max(len(row) for row in rows)
    rows = [row + [""] * (width - len(row)) for row in rows]
    lines = ["| " + " | ".join(rows[0]) + " |", "|" + "---|" * width]
    lines += ["| " + " | ".join(row) + " |" for row in rows[1:]]
    return "\n".join(lines)


def _body(document: Document) -> Iterator[Paragraph | Table]:
    for child in document.element.body.iterchildren():
        if child.tag == qn("w:p"):
            yield Paragraph(child, document)
        elif child.tag == qn("w:tbl"):
            yield Table(child, document)


def _page_count(path: Path) -> int | None:
    try:
        with zipfile.ZipFile(path) as archive:
            xml = archive.read("docProps/app.xml").decode("utf-8", "replace")
    except (KeyError, OSError, zipfile.BadZipFile):
        return None
    # Only Microsoft Word counts pages when saving; other writers (LibreOffice, python-docx,
    # online editors) leave a placeholder such as 1.
    application = re.search(r"<(?:\w+:)?Application>([^<]*)</", xml)
    if not application or not application.group(1).startswith("Microsoft"):
        return None
    match = re.search(r"<(?:\w+:)?Pages>(\d+)</", xml)
    return int(match.group(1)) if match else None


def extract_docx(path: Path) -> Extracted:
    try:
        document = docx.Document(str(path))
        items = list(_body(document))
    except Exception as exc:
        raise PermanentError(DAMAGED) from exc

    has_page_info = any(_page_breaks(item._element) for item in items)
    page = 1
    blocks: list[Block] = []
    for item in items:
        at = page if has_page_info else None
        if isinstance(item, Table):
            markdown = _markdown(item)
            if markdown:
                blocks.append(Block("table", markdown, page=at))
            page += _page_breaks(item._element)
            continue
        text = item.text.strip()
        breaks = _page_breaks(item._p)
        if text:
            level = _heading_level(item)
            if level is not None:
                blocks.append(Block("heading", text, page=at, level=level))
            else:
                blocks.append(Block("text", f"- {text}" if _is_list(item) else text, page=at))
        page += breaks

    counted = page if has_page_info else None
    recorded = _page_count(path)
    page_count = max(filter(None, (recorded, counted)), default=None)
    return Extracted(blocks=blocks, page_count=page_count, scanned_pages=[])
