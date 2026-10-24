"""What an extractor hands to the chunker: the document as an ordered list of blocks."""

from dataclasses import dataclass
from typing import Literal

BlockKind = Literal["heading", "text", "table"]


@dataclass(frozen=True)
class Block:
    kind: BlockKind
    text: str  # tables are Markdown tables
    page: int | None = None  # 1-based; None when the format has no pages
    level: int = 1  # headings only: smaller is higher (a Word Title is 0)
    from_ocr: bool = False


@dataclass
class Extracted:
    blocks: list[Block]
    page_count: int | None
    scanned_pages: list[int]  # pages with no usable text layer, for OCR (build step 6)
