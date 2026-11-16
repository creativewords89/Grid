"""Download a set's questions and answers as Excel (SPEC section 6.9a, steps 32 and 33).

The status chosen in the list decides which questions: approved (the default), to do, drafts,
skipped or all.
No summary sheet. One sheet per group: per topic, or per subtopic once a topic is chosen.
One row per question, its answers side by side (Answer 1, Answer 2…, as many as needed), never
merged. Text from Facebook is written as text, never as a formula.
"""

import io
import re
from collections.abc import Iterable
from typing import Any, Literal

from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE, Cell
from openpyxl.styles import Alignment, Font
from openpyxl.worksheet._write_only import WriteOnlyWorksheet
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import FbPost, FbStatus, FbThread, QuestionSet

MAX_CELL = 32_000  # Excel holds 32,767 characters in a cell
_BAD_SHEET = re.compile(r"[\[\]:*?/\\]")
_BOLD = Font(bold=True)
_WRAP = Alignment(wrap_text=True, vertical="top")
_TOP = Alignment(vertical="top")

Which = Literal["todo", "draft", "approved", "skipped", "all"]
# The sheet and the file are named after it: "… - to do.xlsx".
NAMES: dict[str, tuple[str, str]] = {
    "todo": ("To do", "to-do questions"),
    "draft": ("Drafts", "draft questions"),
    "approved": ("Approved", "approved questions"),
    "skipped": ("Skipped", "skipped questions"),
    "all": ("All", "questions"),
}
_STATUS = {"todo": "To do", "draft": "Draft", "approved": "Approved", "skipped": "Skipped"}


def sheet_name(name: str, taken: set[str]) -> str:
    """A valid, unique sheet name: no []:*?/\\, at most 31 characters."""
    base = _BAD_SHEET.sub(" ", name).strip().strip("'")[:31] or "Other"
    chosen, n = base, 2
    while chosen.lower() in taken:
        suffix = f" ({n})"
        chosen, n = base[: 31 - len(suffix)] + suffix, n + 1
    taken.add(chosen.lower())
    return chosen


def _cell(ws: WriteOnlyWorksheet, value: Any, style: Alignment | None = None) -> Cell:
    if isinstance(value, str):
        value = ILLEGAL_CHARACTERS_RE.sub("", value)[:MAX_CELL]
    cell = WriteOnlyCell(ws, value=value)
    if isinstance(value, str) and cell.data_type == "f":
        cell.data_type = "s"  # "=…" from a post is text, not a formula
    if style is not None:
        cell.alignment = style
    return cell


def _header(ws: WriteOnlyWorksheet, names: Iterable[str]) -> list[Cell]:
    cells = []
    for name in names:
        cell = WriteOnlyCell(ws, value=name)
        cell.font = _BOLD
        cells.append(cell)
    return cells


def chosen(
    db: Session, qset: QuestionSet, topic: str | None, subtopic: str | None, which: Which
) -> list[FbThread]:
    query = select(FbThread).where(FbThread.set_id == qset.id)
    if which != "all":
        query = query.where(FbThread.status == FbStatus(which))
    if topic is not None:
        query = query.where(FbThread.topic == topic)
        if subtopic is not None:
            query = query.where(FbThread.subtopic == subtopic)
    threads = db.scalars(query).all()
    return sorted(
        threads,
        key=lambda t: (
            t.topic == "",
            t.topic.lower(),
            t.subtopic == "",
            t.subtopic.lower(),
            (t.answer_title or t.title).lower(),
        ),
    )


def build(
    db: Session,
    qset: QuestionSet,
    topic: str | None = None,
    subtopic: str | None = None,
    which: Which = "approved",
) -> tuple[bytes, int]:
    """The workbook, and how many questions are in it."""
    threads = chosen(db, qset, topic, subtopic, which)
    posts = {
        p.row: p
        for p in db.scalars(
            select(FbPost).where(
                FbPost.set_id == qset.id,
                FbPost.row.in_({r for t in threads for r in t.rows}),
            )
        )
    }
    by_subtopic = topic is not None
    groups: dict[str, list[FbThread]] = {}
    for t in threads:
        name = t.subtopic if by_subtopic else t.topic
        groups.setdefault(name, []).append(t)

    book = Workbook(write_only=True)
    taken: set[str] = set()

    for name, rows in groups.items():
        label = name or ("Other" if by_subtopic else "No topic")
        ws = book.create_sheet(sheet_name(label, taken))
        # Questions not answered yet (to do, skipped) have no answer columns.
        width = max(len(_answers(t)) for t in rows)
        if which in ("approved", "draft"):
            width = max(width, 1)
        status = which == "all"
        widths = [50, 60, 22, 22] + [12] * status + [60] * width
        for i, w in enumerate(widths):
            ws.column_dimensions[_letter(i)].width = w
        ws.freeze_panes = "B2"
        names = ["Question", "Description", "Topic", "Subtopic"] + ["Status"] * status
        names += [f"Answer {n}" for n in range(1, width + 1)]
        ws.append(_header(ws, names))
        for t in rows:
            found = [posts[r] for r in t.rows if r in posts]
            items = _answers(t)
            row = [
                _cell(ws, t.answer_title or t.title, _WRAP),
                _cell(ws, "\n\n---\n\n".join(p.question.strip() for p in found), _WRAP),
                _cell(ws, t.topic, _TOP),
                _cell(ws, t.subtopic, _TOP),
            ]
            if status:
                row.append(_cell(ws, _STATUS[t.status.value], _TOP))
            row += [_cell(ws, items[n][0] if n < len(items) else "", _WRAP) for n in range(width)]
            ws.append(row)
    if not groups:  # a workbook needs a sheet
        sheet, words = NAMES[which]
        empty = book.create_sheet(sheet)
        empty.append([_cell(empty, f"No {words} here yet.")])

    out = io.BytesIO()
    book.save(out)
    return out.getvalue(), len(threads)


def _answers(t: FbThread) -> list[tuple[str, str]]:
    return [
        (str(a.get("text") or "").strip(), str(a.get("label") or "").strip())
        for a in t.answers
        if str(a.get("text") or "").strip()
    ]


def _letter(index: int) -> str:
    from openpyxl.utils import get_column_letter

    return get_column_letter(index + 1)
