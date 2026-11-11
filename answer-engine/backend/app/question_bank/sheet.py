"""A question set from a spreadsheet (SPEC section 6.9a, step 29).

Any CSV or Excel file with a **question** column becomes a set's threads: one thread per row,
with optional details (the post as it was asked), link, author, topic, subtopic, comments
(one per line, "Name: text") and an answer (saved as a draft to check). The result has the
same shape as the JSON data file, so both are loaded the same way.
"""

import re
from pathlib import Path
from typing import Any

from app.files import sniff
from app.jobs.queue import PermanentError
from app.question_bank.service import FbError
from app.verified.importing import (
    MAX_QUESTION,
    Numbered,
    Skipped,
    _cell,
    _csv_rows,
    _header,
    _xlsx_sheets,
)
from app.verified.service import MAX_TEXT

MAX_ROWS = 10_000
WRONG_TYPE = "Upload the questions as a JSON data file, a CSV or an Excel (.xlsx) file."
NEEDS_COLUMN = (
    "The file needs a header row with a “question” column. Optional columns: details, link, "
    "asked by, topic, subtopic, comments, answer."
)

_HEADERS = {
    "question": {"question", "questions", "q", "title"},
    "details": {"details", "post", "post text", "context", "description", "body", "message"},
    "url": {"url", "link", "post url", "post_url", "permalink"},
    "author": {"author", "asked by", "asked_by", "name"},
    "topic": {"topic", "category"},
    "subtopic": {"subtopic", "sub topic", "sub-topic"},
    "comments": {"comments", "replies"},
    "answer": {"answer", "answers"},
    "key": {"id", "key"},
    "row": {"row", "row number"},
}


def _columns(headers: list[str]) -> dict[str, int]:
    found: dict[str, int] = {}
    for index, header in enumerate(headers):
        name = _header(header)
        for role, names in _HEADERS.items():
            if name in names and role not in found:
                found[role] = index
    return found


def comments_of(text: str) -> list[list[Any]]:
    """One comment per line; "Name: text" keeps the name."""
    comments: list[list[Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        name, sep, said = line.partition(": ")
        if sep and 0 < len(name) <= 40 and said.strip():
            comments.append([name.strip(), said.strip(), []])
        else:
            comments.append(["", line, []])
    return comments


def _table(path: Path, filename: str) -> tuple[dict[str, int], Numbered]:
    try:
        file_type = sniff.detect(path, filename)
    except sniff.SniffError as exc:
        raise FbError(415, "unsupported", str(exc)) from None
    if file_type not in (sniff.XLSX, sniff.CSV):
        raise FbError(415, "unsupported", WRONG_TYPE)
    try:
        sheets = _xlsx_sheets(path) if file_type == sniff.XLSX else iter([_csv_rows(path)])
        for rows in sheets:
            for position, (_, cells) in enumerate(rows[:10]):
                columns = _columns(cells)
                if "question" in columns:
                    return columns, rows[position + 1 :]
    except PermanentError as exc:
        raise FbError(422, "unreadable", str(exc)) from None
    raise FbError(422, "no_columns", NEEDS_COLUMN)


def parse(path: Path, filename: str) -> tuple[dict[str, Any], list[Skipped]]:
    """The data (`posts`, `threads`, `answers`) in a spreadsheet, and the rows skipped."""
    columns, body = _table(path, filename)
    posts: list[dict[str, Any]] = []
    threads: list[dict[str, Any]] = []
    answers: dict[str, Any] = {}
    skipped: list[Skipped] = []
    seen: set[str] = set()
    rows_seen: set[int] = set()
    for number, cells in body:
        if not any(c.strip() for c in cells):
            continue
        question = re.sub(r"\s+", " ", _cell(cells, columns["question"]))
        if not question:
            skipped.append(Skipped(number, "No question."))
            continue
        if len(question) > MAX_QUESTION:
            skipped.append(Skipped(number, "The question is over 2,000 characters."))
            continue
        given_row = _cell(cells, columns.get("row"))
        row = int(given_row) if given_row.isdigit() else number
        key = _cell(cells, columns.get("key"))[:100] or f"r{row}"
        if key in seen or row in rows_seen:
            skipped.append(Skipped(number, "The same question (id or row) appears earlier."))
            continue
        seen.add(key)
        rows_seen.add(row)
        details = _cell(cells, columns.get("details"))[:MAX_TEXT]
        answer = _cell(cells, columns.get("answer"))
        posts.append(
            {
                "row": row,
                "url": _cell(cells, columns.get("url"))[:2000],
                "author": _cell(cells, columns.get("author"))[:200],
                "question": details or question,
                "comments": comments_of(_cell(cells, columns.get("comments"))[:200_000]),
                "picked": [],
            }
        )
        threads.append(
            {
                "key": key,
                "title": question,
                "topic": _cell(cells, columns.get("topic"))[:200],
                "subtopic": _cell(cells, columns.get("subtopic"))[:200],
                "rows": [row],
            }
        )
        if answer:
            # A drafted answer: someone checks it on the page, then approves it.
            answers[key] = {"status": "draft", "items": [{"text": answer[:MAX_TEXT]}]}
        if len(threads) > MAX_ROWS:
            raise FbError(422, "too_many", f"Upload at most {MAX_ROWS:,} questions at a time.")
    if not threads:
        raise FbError(422, "empty", "No questions were found: each row needs a question.")
    return {"posts": posts, "threads": threads, "answers": answers}, skipped
