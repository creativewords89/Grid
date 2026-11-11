"""Import verified answers from a CSV or Excel file (SPEC section 6.9, step 26).

Every row is its own verified answer. Rows with the same question are different correct
answers to it: they are never merged, and they share an answer group. Importing an updated
file updates the answers it made before (matched by `import_key`) instead of adding more.
"""

import csv
import hashlib
import io
import re
import unicodedata
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit
from app.db.models import User, VerifiedAnswer, VerifiedOrigin, VerifiedStatus
from app.files import sniff
from app.files.extract_sheet import _decode, _dialect
from app.jobs.queue import PermanentError
from app.verified import service
from app.verified.service import MAX_TEXT, VerifiedError

MAX_ROWS = 5000
MAX_QUESTION = 2000
MAX_APPLIES = 500
MAX_ALSO = 4000

NEEDS_COLUMNS = (
    "The file needs a header row with “question” and “answer” columns, like the Answer "
    "Editor's “Knowledge base” export."
)
WRONG_TYPE = "Upload the answers as a CSV or Excel (.xlsx) file."

_HEADERS = {
    "question": {"question", "questions", "q"},
    "answer": {"answer", "answers", "a"},
    "applies": {
        "when_it_applies",
        "when it applies",
        "applies when",
        "applies_when",
        "angle",
        "perspective",
    },
    "topic": {"topic", "category"},
    "subtopic": {"subtopic", "sub topic", "sub-topic"},
    "also": {
        "similar_questions",
        "similar questions",
        "also asked",
        "also_asked",
        "other wordings",
    },
}


@dataclass
class Row:
    number: int  # the row number a spreadsheet shows
    question: str
    answer: str
    applies_when: str
    also_asked: str
    import_key: str = ""
    group: str = ""
    topic: str = ""
    subtopic: str = ""


@dataclass
class Skipped:
    row: int
    reason: str


@dataclass
class Parsed:
    rows: list[Row] = field(default_factory=list)
    skipped: list[Skipped] = field(default_factory=list)


@dataclass
class Result:
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    skipped: list[Skipped] = field(default_factory=list)


def normalise(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    return re.sub(r"\W+", " ", text).strip()


def group_of(question: str) -> str:
    """Answers to the same question (ignoring case, spaces and punctuation) share this."""
    return hashlib.sha256(normalise(question).encode()).hexdigest()[:24]


def _header(text: str) -> str:
    text = re.sub(r"\(optional\)", "", text, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", text).strip().lower()


def _columns(headers: list[str]) -> dict[str, int]:
    found: dict[str, int] = {}
    for index, header in enumerate(headers):
        name = _header(header)
        for role, names in _HEADERS.items():
            if name in names and role not in found:
                found[role] = index
    return found


Numbered = list[tuple[int, list[str]]]


def _csv_rows(path: Path) -> Numbered:
    text = _decode(path.read_bytes())
    try:
        reader = csv.reader(io.StringIO(text, newline=""), _dialect(text[: 64 * 1024]))
        return [(number, list(row)) for number, row in enumerate(reader, 1)]
    except csv.Error as exc:
        raise PermanentError("This CSV file can't be read. Save it again as CSV UTF-8.") from exc


def _xlsx_sheets(path: Path) -> Iterator[Numbered]:
    from openpyxl import load_workbook

    try:
        # From bytes: openpyxl refuses a path without an .xlsx name (uploads are temp files).
        book = load_workbook(io.BytesIO(path.read_bytes()), read_only=True, data_only=True)
    except Exception as exc:  # openpyxl raises many types for a broken file
        raise PermanentError("This Excel file can't be opened. Save it again and retry.") from exc
    try:
        for ws in book.worksheets:
            yield [
                (number, ["" if v is None else str(v) for v in values])
                for number, values in enumerate(ws.iter_rows(values_only=True), 1)
            ]
    finally:
        book.close()


def _with_header(rows: Numbered) -> tuple[dict[str, int], Numbered] | None:
    """The column roles and the rows under the header, if a header is in the first 10 rows.
    Line breaks inside cells are kept: they are the answer's paragraphs and lists."""
    for position, (_, cells) in enumerate(rows[:10]):
        columns = _columns(cells)
        if "question" in columns and "answer" in columns:
            return columns, rows[position + 1 :]
    return None


def _cell(cells: list[str], index: int | None) -> str:
    if index is None or index >= len(cells):
        return ""
    return cells[index].strip()


def _also(text: str) -> str:
    parts = [re.sub(r"\s+", " ", p).strip() for p in re.split(r"\|\||\n", text)]
    return " || ".join(p for p in parts if p)[:MAX_ALSO]


def parse_file(path: Path, filename: str) -> Parsed:
    """The answers in an uploaded spreadsheet. Raises VerifiedError with a readable reason."""
    try:
        file_type = sniff.detect(path, filename)
    except sniff.SniffError as exc:
        raise VerifiedError(415, "unsupported", str(exc)) from None
    if file_type not in (sniff.XLSX, sniff.CSV):
        raise VerifiedError(415, "unsupported", WRONG_TYPE)
    found = None
    try:
        sheets = _xlsx_sheets(path) if file_type == sniff.XLSX else iter([_csv_rows(path)])
        for rows in sheets:
            found = _with_header(rows)
            if found:
                break
    except PermanentError as exc:
        raise VerifiedError(422, "unreadable", str(exc)) from None
    if found is None:
        raise VerifiedError(422, "no_columns", NEEDS_COLUMNS)
    columns, body = found

    parsed = Parsed()
    seen: set[tuple[str, str, str]] = set()
    unlabelled: dict[str, int] = {}
    for number, cells in body:
        question = _cell(cells, columns["question"])
        answer = _cell(cells, columns["answer"])
        if not any(c.strip() for c in cells):
            continue
        if not question or not answer:
            parsed.skipped.append(Skipped(number, "No question or no answer."))
            continue
        if len(question) > MAX_QUESTION:
            parsed.skipped.append(Skipped(number, "The question is over 2,000 characters."))
            continue
        if len(answer) > MAX_TEXT:
            parsed.skipped.append(Skipped(number, "The answer is over 20,000 characters."))
            continue
        applies = re.sub(r"\s+", " ", _cell(cells, columns.get("applies")))[:MAX_APPLIES]
        same = (normalise(question), normalise(applies), normalise(answer))
        if same in seen:
            parsed.skipped.append(Skipped(number, "The same answer appears earlier in the file."))
            continue
        seen.add(same)
        group = group_of(question)
        if applies:
            slot = "when:" + normalise(applies)
        else:
            unlabelled[group] = unlabelled.get(group, 0) + 1
            slot = f"#{unlabelled[group]}"
        parsed.rows.append(
            Row(
                number=number,
                question=question,
                answer=answer,
                applies_when=applies,
                also_asked=_also(_cell(cells, columns.get("also"))),
                import_key=f"{group}|{slot}",
                group=group,
                topic=service.clean_topic(_cell(cells, columns.get("topic"))),
                subtopic=service.clean_topic(_cell(cells, columns.get("subtopic"))),
            )
        )
        if len(parsed.rows) > MAX_ROWS:
            raise VerifiedError(422, "too_many", f"Import at most {MAX_ROWS:,} answers at a time.")
    if not parsed.rows:
        raise VerifiedError(
            422, "empty", "No answers were found: each row needs a question and an answer."
        )
    return parsed


def apply(db: Session, parsed: Parsed, by: User) -> Result:
    """Create or update one verified answer per row. The caller commits."""
    result = Result(skipped=list(parsed.skipped))
    keys = [row.import_key for row in parsed.rows]
    existing = {
        va.import_key: va
        for va in db.scalars(
            select(VerifiedAnswer).where(
                VerifiedAnswer.import_key.in_(keys), VerifiedAnswer.deleted_at.is_(None)
            )
        )
    }
    for row in parsed.rows:
        va = existing.get(row.import_key)
        if va is None:
            db.add(
                va := VerifiedAnswer(
                    question=row.question,
                    answer=row.answer,
                    applies_when=row.applies_when or None,
                    also_asked=row.also_asked or None,
                    answer_group=row.group,
                    import_key=row.import_key,
                    topic=row.topic,
                    subtopic=row.subtopic,
                    status=VerifiedStatus.ACTIVE,
                    origin=VerifiedOrigin.IMPORT,
                    created_by=by.id,
                    approved_by=by.id,
                    version=1,
                )
            )
            db.flush()
            service.add_version(db, va, by)
            service.sync(db, va)
            audit.record(db, by, "create", "verified_answer", va.id, va.question)
            result.created += 1
            continue
        same = (
            va.question == row.question
            and va.answer == row.answer
            and (va.applies_when or "") == row.applies_when
            and (va.also_asked or "") == row.also_asked
            and va.topic == row.topic
            and va.subtopic == row.subtopic
        )
        if same:
            result.unchanged += 1
            continue
        service.edit(
            db,
            va,
            by,
            row.question,
            row.answer,
            applies_when=row.applies_when,
            also_asked=row.also_asked,
            topic=row.topic,
            subtopic=row.subtopic,
        )
        va.answer_group = row.group
        va.approved_by = by.id
        result.updated += 1
    return result
