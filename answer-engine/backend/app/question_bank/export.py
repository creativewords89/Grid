"""Download a set's approved questions and answers as Excel (SPEC section 6.9a, step 32).

One sheet per group: per topic, or per subtopic once a topic is chosen. One row per
question, its answers side by side (Answer 1, When answer 1 applies, Answer 2…), never
merged. Text from Facebook is written as text, never as a formula.
"""

import io
import re
from collections.abc import Iterable
from typing import Any

from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE, Cell
from openpyxl.styles import Alignment, Font
from openpyxl.worksheet._write_only import WriteOnlyWorksheet
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.tokens import now
from app.db.models import FbPost, FbStatus, FbThread, QuestionSet, User

MAX_CELL = 32_000  # Excel holds 32,767 characters in a cell
_BAD_SHEET = re.compile(r"[\[\]:*?/\\]")
_BOLD = Font(bold=True)
_WRAP = Alignment(wrap_text=True, vertical="top")
_TOP = Alignment(vertical="top")


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


def approved(
    db: Session, qset: QuestionSet, topic: str | None, subtopic: str | None
) -> list[FbThread]:
    query = select(FbThread).where(FbThread.set_id == qset.id, FbThread.status == FbStatus.APPROVED)
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
) -> tuple[bytes, int]:
    """The workbook, and how many questions are in it."""
    threads = approved(db, qset, topic, subtopic)
    posts = {
        p.row: p
        for p in db.scalars(
            select(FbPost).where(
                FbPost.set_id == qset.id,
                FbPost.row.in_({r for t in threads for r in t.rows}),
            )
        )
    }
    people = {
        u.id: u.name
        for u in db.scalars(
            select(User).where(User.id.in_({t.answered_by for t in threads if t.answered_by}))
        )
    }
    by_subtopic = topic is not None
    groups: dict[str, list[FbThread]] = {}
    for t in threads:
        name = t.subtopic if by_subtopic else t.topic
        groups.setdefault(name, []).append(t)

    book = Workbook(write_only=True)
    taken = {"summary"}
    summary = book.create_sheet("Summary")
    summary.column_dimensions["A"].width = 40
    summary.column_dimensions["B"].width = 12
    summary.column_dimensions["C"].width = 12
    summary.append([_cell(summary, f"{qset.name}: approved questions and answers")])
    scope = " › ".join(x or "No topic" for x in (topic, subtopic) if x is not None)
    summary.append([_cell(summary, f"Topic: {scope}" if scope else "All topics")])
    summary.append([_cell(summary, f"Downloaded {now().strftime('%Y-%m-%d %H:%M')} UTC")])
    summary.append([])
    summary.append(_header(summary, ["Sheet", "Questions", "Answers"]))

    for name, rows in groups.items():
        label = name or ("Other" if by_subtopic else "No topic")
        ws = book.create_sheet(sheet_name(label, taken))
        width = max(1, *(len(_answers(t)) for t in rows))
        widths = [50, 60, 22, 22] + [60, 28] * width + [20, 14]
        for i, w in enumerate(widths):
            ws.column_dimensions[_letter(i)].width = w
        ws.freeze_panes = "B2"
        names = ["Question", "Description", "Topic", "Subtopic"]
        for n in range(1, width + 1):
            names += [f"Answer {n}", f"When answer {n} applies"]
        names += ["Approved by", "Approved on"]
        ws.append(_header(ws, names))
        answers = 0
        for t in rows:
            found = [posts[r] for r in t.rows if r in posts]
            items = _answers(t)
            answers += len(items)
            row = [
                _cell(ws, t.answer_title or t.title, _WRAP),
                _cell(ws, "\n\n---\n\n".join(p.question.strip() for p in found), _WRAP),
                _cell(ws, t.topic, _TOP),
                _cell(ws, t.subtopic, _TOP),
            ]
            for n in range(width):
                text, when = items[n] if n < len(items) else ("", "")
                row += [_cell(ws, text, _WRAP), _cell(ws, when, _WRAP)]
            row += [
                _cell(ws, people.get(t.answered_by, "") if t.answered_by else "", _TOP),
                _cell(ws, t.answered_at.strftime("%Y-%m-%d") if t.answered_at else "", _TOP),
            ]
            ws.append(row)
        summary.append(
            [_cell(summary, ws.title), _cell(summary, len(rows)), _cell(summary, answers)]
        )
    if not groups:
        summary.append([_cell(summary, "No approved questions here yet.")])

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
