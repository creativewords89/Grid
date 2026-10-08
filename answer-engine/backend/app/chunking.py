"""Split a document's blocks into chunks for search (SPEC section 6.3). Pure functions.

- Chunks aim for TARGET tokens and never exceed MAX (except a single word longer than MAX).
- Boundaries fall at headings first, then paragraphs, then sentences, never mid-sentence.
- Consecutive chunks of the same section share up to OVERLAP tokens of whole sentences.
- A table stays in one chunk unless it alone is over MAX; then it is split by rows and each
  part repeats the header row.

Token counts are estimated (about 4 characters per token, a little high for English), so
chunks stay well inside the embedding model's input limit.
"""

import math
import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from typing import Literal

from app.files.blocks import Block

TARGET = 600
MAX = 800
OVERLAP = 100
# A heading only starts a new chunk once the current one has this much content, so short
# sections are kept together instead of becoming tiny chunks.
MIN_SECTION = 100
HEADING_SEPARATOR = " \u203a "  # space, single right angle quote, space

PieceKind = Literal["heading", "text", "table", "overlap"]

# A sentence ends at . ! ? or an ellipsis, plus any closing quotes or brackets, when the next
# word starts with a capital letter (or an opening quote or bracket before one).
_SENTENCE_END = re.compile("[.!?\u2026]+[\"'\u201d\u2019)\\]]*(?=\\s+[\"'\u201c\u2018(\\[]*[A-Z])")
_ABBREVIATIONS = frozenset(
    [
        "mr",
        "mrs",
        "ms",
        "dr",
        "prof",
        "st",
        "vs",
        "etc",
        "e.g",
        "i.e",
        "no",
        "p",
        "pp",
        "fig",
        "approx",
        "inc",
        "ltd",
        "co",
        "jan",
        "feb",
        "mar",
        "apr",
        "jun",
        "jul",
        "aug",
        "sep",
        "sept",
        "oct",
        "nov",
        "dec",
    ]
)


def count_tokens(text: str) -> int:
    return math.ceil(len(text) / 4) if text else 0


def context_line(file_name: str, heading: str | None) -> str:
    """Put before a chunk when it is embedded, so search knows where the text comes from."""
    return f"{file_name}{HEADING_SEPARATOR}{heading}" if heading else file_name


@dataclass(frozen=True)
class Chunk:
    text: str
    heading: str | None
    page_from: int | None
    page_to: int | None
    token_count: int
    from_ocr: bool


@dataclass
class _Piece:
    kind: PieceKind
    text: str
    heading: str | None
    page: int | None
    from_ocr: bool
    paragraph: int  # pieces of one paragraph are joined with a space, others with a blank line
    sentences: list[str] = field(default_factory=list)

    @property
    def tokens(self) -> int:
        return count_tokens(self.text)


def split_sentences(text: str) -> list[str]:
    """Sentences, each keeping its closing punctuation; a line break also ends one."""
    sentences: list[str] = []
    for line in text.splitlines():
        start = 0
        for match in _SENTENCE_END.finditer(line):
            words = line[start : match.start() + 1].split()
            last_word = words[-1].lower().rstrip(".").lstrip("(\"'") if words else ""
            if line[match.start()] == "." and last_word in _ABBREVIATIONS:
                continue
            sentences.append(line[start : match.end()].strip())
            start = match.end()
        sentences.append(line[start:].strip())
    return [sentence for sentence in sentences if sentence]


def _split_words(sentence: str, limit: int) -> Iterator[str]:
    """Last resort for a 'sentence' longer than the limit (e.g. a long list without stops)."""
    current: list[str] = []
    for word in sentence.split():
        if current and count_tokens(" ".join([*current, word])) > limit:
            yield " ".join(current)
            current = []
        current.append(word)
    if current:
        yield " ".join(current)


def _table_parts(table: str) -> Iterator[str]:
    lines = [line for line in table.splitlines() if line.strip()]
    header, rows = lines[:2], lines[2:]
    part: list[str] = []
    for row in rows:
        if part and count_tokens("\n".join([*header, *part, row])) > MAX:
            yield "\n".join([*header, *part])
            part = []
        part.append(row)
    if part or not rows:
        yield "\n".join([*header, *part])


def _pieces(blocks: Iterable[Block]) -> Iterator[_Piece]:
    headings: list[tuple[int, str]] = []
    for number, block in enumerate(blocks):
        text = block.text.strip()
        if not text:
            continue
        if block.kind == "heading":
            title = " ".join(text.split())
            headings = [(lvl, h) for lvl, h in headings if lvl < block.level]
            headings.append((block.level, title))
        path = HEADING_SEPARATOR.join(h for _, h in headings) or None
        base = _Piece("text", "", path, block.page, block.from_ocr, number)

        if block.kind == "heading":
            yield _with(base, "heading", "#" * min(max(block.level, 1), 6) + " " + title)
        elif block.kind == "table":
            parts = [text] if count_tokens(text) <= MAX else list(_table_parts(text))
            for part in parts:
                yield _with(base, "table", part)
        elif count_tokens(text) <= MAX:
            yield _with(base, "text", text, split_sentences(text))
        else:
            for sentence in split_sentences(text):
                small = count_tokens(sentence) <= MAX
                for part in [sentence] if small else _split_words(sentence, MAX):
                    yield _with(base, "text", part, [part])


def _with(base: _Piece, kind: PieceKind, text: str, sentences: list[str] | None = None) -> _Piece:
    return _Piece(
        kind, text, base.heading, base.page, base.from_ocr, base.paragraph, sentences or []
    )


def _join(pieces: list[_Piece]) -> str:
    out = ""
    for i, p in enumerate(pieces):
        if i == 0:
            out = p.text
        elif p.paragraph == pieces[i - 1].paragraph and p.kind in ("text", "overlap"):
            out += " " + p.text
        else:
            out += "\n\n" + p.text
    return out


def _shared_heading(headings: list[str | None]) -> str | None:
    paths = [h.split(HEADING_SEPARATOR) if h else [] for h in headings]
    shared: list[str] = []
    for parts in zip(*paths, strict=False):
        if len(set(parts)) != 1:
            break
        shared.append(parts[0])
    return HEADING_SEPARATOR.join(shared) or None


def _overlap(pieces: list[_Piece]) -> _Piece | None:
    """Whole sentences from the end of the chunk, at most OVERLAP tokens."""
    last = pieces[-1]
    if last.kind not in ("text", "overlap"):
        return None
    tail: list[str] = []
    for sentence in reversed(last.sentences):
        if count_tokens(" ".join([sentence, *tail])) > OVERLAP:
            break
        tail.insert(0, sentence)
    if not tail:
        return None
    text = " ".join(tail)
    return _Piece("overlap", text, last.heading, last.page, last.from_ocr, last.paragraph, tail)


def _make_chunk(pieces: list[_Piece]) -> Chunk:
    text = _join(pieces)
    pages = [p.page for p in pieces if p.page is not None]
    # Labelled with the heading its content shares (a chunk that runs into the next
    # section gets the heading both sections sit under).
    heading = _shared_heading([p.heading for p in pieces if p.kind in ("text", "table")])
    return Chunk(
        text=text,
        heading=heading,
        page_from=min(pages) if pages else None,
        page_to=max(pages) if pages else None,
        token_count=count_tokens(text),
        from_ocr=any(p.from_ocr for p in pieces),
    )


def chunk_blocks(blocks: Iterable[Block]) -> list[Chunk]:
    chunks: list[Chunk] = []
    previous: list[_Piece] = []  # the pieces of chunks[-1]
    current: list[_Piece] = []

    def content_tokens() -> int:
        return sum(p.tokens for p in current if p.kind in ("text", "table"))

    def flush() -> None:
        nonlocal current, previous
        if not any(p.kind in ("text", "table") for p in current):
            current = [p for p in current if p.kind == "heading"]  # keep a dangling heading
            return
        chunks.append(_make_chunk(current))
        previous, current = current, []

    def flush_section_end() -> None:
        """At a heading or the end: a short tail joins the chunk before it when it fits."""
        nonlocal current, previous
        tail = [p for p in current if p.kind != "overlap"]
        if (
            previous
            and 0 < content_tokens() < MIN_SECTION
            and count_tokens(_join(previous + tail)) <= MAX
        ):
            previous = previous + tail
            chunks[-1] = _make_chunk(previous)
            current = []
        elif content_tokens() >= MIN_SECTION or not previous:
            flush()

    for piece in _pieces(blocks):
        if piece.kind == "heading":
            flush_section_end()
            current.append(piece)
            continue
        size = count_tokens(_join([*current, piece])) if current else piece.tokens
        if current and (size > MAX or count_tokens(_join(current)) >= TARGET):
            carry = _overlap(current) if current[-1].heading == piece.heading else None
            flush()
            if carry and count_tokens(_join([carry, piece])) <= MAX:
                current = [carry]
        current.append(piece)
    flush_section_end()
    flush()
    return chunks
