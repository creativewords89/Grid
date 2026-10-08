"""Read scanned pages and images with Claude (SPEC section 6.2).

Pages are rendered (PDF) or converted (photos, HEIC, multi-page TIFF), shrunk so the long
side is at most 2000 px, and sent to Claude up to 4 at a time. Claude's Markdown comes
back as blocks marked `from_ocr`. A page that is declined or keeps failing is left empty
and counted in the file's warning; a refused API key fails the file so it can be retried.
"""

import io
import logging
import re
import time
from collections.abc import Callable, Iterable, Iterator
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from pathlib import Path

import anthropic
import pymupdf
from PIL import Image, ImageOps, ImageSequence, UnidentifiedImageError
from pillow_heif import register_heif_opener

from app.ai.ocr_client import KeyRejected, Ocr, Transcript
from app.ai.usage import Usage
from app.files.blocks import Block
from app.jobs.queue import PermanentError

register_heif_opener()  # lets Pillow open iPhone photos (.heic)

log = logging.getLogger(__name__)

MAX_SIDE = 2000  # px on the long side
RENDER_DPI = 200
MAX_IMAGE_BYTES = 3_700_000  # stays under the API's 5 MB limit once base64-encoded
PARALLEL = 4
ATTEMPTS = 3
RETRY_WAIT = (2.0, 6.0)  # seconds before attempts 2 and 3; the SDK also retries 429/5xx

KEY_REFUSED = (
    "Scanned pages couldn't be read: the Claude API key was refused. Ask the Owner to "
    "check it, then press Retry."
)
DAMAGED_IMAGE = "This image is damaged and can't be read."
HUGE_IMAGE = "This image is too large to read. Save a smaller copy and upload that."

Progress = Callable[[int, int], None]


@dataclass(frozen=True)
class PageImage:
    page: int
    data: bytes
    media_type: str


@dataclass
class OcrResult:
    blocks: list[Block] = field(default_factory=list)
    pages_read: int = 0
    failed_pages: list[int] = field(default_factory=list)
    usage: Usage = field(default_factory=Usage)


# --- preparing images ----------------------------------------------------------------------


def _encode(image: Image.Image) -> tuple[bytes, str]:
    """PNG keeps text sharp; a photo too big as PNG is sent as JPEG instead."""
    out = io.BytesIO()
    image.save(out, "PNG", optimize=True)
    if out.tell() <= MAX_IMAGE_BYTES:
        return out.getvalue(), "image/png"
    for quality in (85, 70, 55):
        out = io.BytesIO()
        image.convert("RGB").save(out, "JPEG", quality=quality)
        if out.tell() <= MAX_IMAGE_BYTES:
            break
    return out.getvalue(), "image/jpeg"


def _normalise(image: Image.Image) -> Image.Image:
    image = ImageOps.exif_transpose(image)  # phone photos are often stored sideways
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGBA").convert("RGB") if "A" in image.mode else image.convert("RGB")
    image.thumbnail((MAX_SIDE, MAX_SIDE))
    return image


def image_pages(path: Path) -> list[PageImage]:
    """Every frame of an uploaded image (TIFF faxes can have several), ready for Claude."""
    try:
        with Image.open(path) as source:
            pages = []
            for number, frame in enumerate(ImageSequence.Iterator(source), start=1):
                data, media_type = _encode(_normalise(frame.copy()))
                pages.append(PageImage(number, data, media_type))
            return pages
    except Image.DecompressionBombError as exc:
        raise PermanentError(HUGE_IMAGE) from exc
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
        raise PermanentError(DAMAGED_IMAGE) from exc


def pdf_pages(path: Path, numbers: list[int]) -> Iterator[PageImage]:
    """Render the given (1-based) PDF pages at 200 DPI, shrunk to fit MAX_SIDE."""
    with pymupdf.open(path) as doc:
        for number in numbers:
            page = doc[number - 1]
            longest_inches = max(page.rect.width, page.rect.height) / 72
            dpi = min(RENDER_DPI, int(MAX_SIDE / longest_inches)) if longest_inches else RENDER_DPI
            pixmap = page.get_pixmap(dpi=max(dpi, 72))
            image = Image.open(io.BytesIO(pixmap.tobytes("png")))
            data, media_type = _encode(_normalise(image))
            yield PageImage(number, data, media_type)


# --- reading with Claude --------------------------------------------------------------------


def _transcribe(ocr: Ocr, page: PageImage) -> Transcript | None:
    """The page's transcript, or None after ATTEMPTS failures. KeyRejected propagates."""
    for attempt in range(ATTEMPTS):
        try:
            return ocr.transcribe(page.data, page.media_type)
        except KeyRejected:
            raise
        except anthropic.BadRequestError:
            log.exception("page %s was refused as a bad request", page.page)
            return None  # the same request would fail again
        except Exception:
            log.warning(
                "reading page %s failed (attempt %s)", page.page, attempt + 1, exc_info=True
            )
            if attempt < ATTEMPTS - 1:
                time.sleep(RETRY_WAIT[attempt])
    return None


_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*$")


def markdown_blocks(text: str, page: int) -> list[Block]:
    """Claude's Markdown transcript as blocks: # headings, | tables, and paragraphs."""
    blocks: list[Block] = []
    paragraph: list[str] = []
    table: list[str] = []

    def end_paragraph() -> None:
        if paragraph:
            blocks.append(Block("text", "\n".join(paragraph), page=page, from_ocr=True))
            paragraph.clear()

    def end_table() -> None:
        if table:
            rows = list(table)
            if len(rows) > 1 and not re.fullmatch(r"\|?[\s:|-]+\|?", rows[1]):
                columns = max(rows[0].count("|") - 1, 1)
                rows.insert(1, "|" + "---|" * columns)  # add the missing separator row
            blocks.append(Block("table", "\n".join(rows), page=page, from_ocr=True))
            table.clear()

    for raw in text.splitlines():
        line = raw.rstrip()
        if line.lstrip().startswith("|"):
            end_paragraph()
            table.append(line.strip())
            continue
        end_table()
        heading = _HEADING.match(line.strip())
        if heading:
            end_paragraph()
            level = len(heading.group(1))
            blocks.append(Block("heading", heading.group(2), page=page, level=level, from_ocr=True))
        elif not line.strip():
            end_paragraph()
        else:
            paragraph.append(line.strip())
    end_paragraph()
    end_table()
    return blocks


def read_pages(ocr: Ocr, pages: Iterable[PageImage], total: int, progress: Progress) -> OcrResult:
    """Transcribe pages, PARALLEL at a time. Pages are rendered as they are needed, so a
    long scan never sits in memory all at once."""
    result = OcrResult()
    done = 0
    progress(done, total)
    queue = iter(pages)
    with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
        running: dict[Future[Transcript | None], int] = {}

        def submit_next() -> None:
            page = next(queue, None)
            if page is not None:
                running[pool.submit(_transcribe, ocr, page)] = page.page

        for _ in range(PARALLEL * 2):
            submit_next()
        try:
            while running:
                finished, _ = wait(running, return_when=FIRST_COMPLETED)
                for future in finished:
                    number = running.pop(future)
                    transcript = future.result()  # KeyRejected stops everything
                    submit_next()
                    done += 1
                    progress(done, total)
                    if transcript is None or transcript.outcome == "refused":
                        result.failed_pages.append(number)
                    else:
                        result.pages_read += 1
                        result.blocks += markdown_blocks(transcript.text, number)
                    if transcript is not None:
                        result.usage.add(
                            transcript.model, transcript.input_tokens, transcript.output_tokens
                        )
        except KeyRejected as exc:
            for other in running:
                other.cancel()
            raise PermanentError(KEY_REFUSED) from exc
    result.failed_pages.sort()
    result.blocks.sort(key=lambda block: block.page or 0)  # stable: keeps order within a page
    return result
