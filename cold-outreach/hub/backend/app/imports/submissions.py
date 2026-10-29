"""Files handed in on the Files screen (SPEC step 31): Lead Check on a whole file before it
is in a batch, the file with each wrong cell marked, and a fingerprint of its content so the
same leads are never added to a batch twice; its cities and their Top businesses for Top
Review (step 32). Pure functions over the workbook."""

import hashlib
import io
import json
import zipfile
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from openpyxl import load_workbook
from openpyxl.comments import Comment
from openpyxl.styles import Font, PatternFill
from openpyxl.utils.exceptions import InvalidFileException

from app.auth.tokens import now
from app.db.models import Submission
from app.imports import check, reader
from app.imports.service import SMALL_CITY

REPORT_TAB = "Lead Check"  # the tab the marked file opens on; taken out again on upload
REPORT_HEADER = ["Severity", "Tab", "Row", "Column", "Business", "Problem", "Value"]
AUTHOR = "Lead Check"
RED = PatternFill("solid", fgColor="F8C9C9")
YELLOW = PatternFill("solid", fgColor="FFF1B8")
NO_FILL = PatternFill(fill_type=None)


@dataclass
class Checked:
    businesses: int
    fingerprint: str
    # errors, warnings, each tab's counts and column problems, and the cities (step 32)
    check: dict[str, Any]
    problems: list[dict[str, Any]] = field(default_factory=list)
    # Each business for the Files table (step 33): its tab and row, values and problems.
    leads: list[dict[str, Any]] = field(default_factory=list)


def _fingerprint(report: reader.Report) -> str:
    """The same leads give the same fingerprint, however the file was saved."""
    rows = [[row.tab, sorted(row.values.items())] for row in report.sheet]
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False).encode()).hexdigest()


def _where(lead: reader.Lead, field_name: str, rows: dict[str, reader.SheetRow]) -> reader.SheetRow:
    """The row of a merged business whose cell holds the value with the problem."""
    found = [rows[w] for w in lead.rows if w in rows]
    for row in found:
        if row.values.get(field_name):
            return row
    return found[0]


TABLE_FIELDS = (*check.STANDARD, "notes")


def run(content: bytes, niche: str, progress: Callable[[int], None] | None = None) -> Checked:
    """Lead Check on a file: every problem with its tab, row, column and value. A business
    given on several rows is checked once, as it will be saved. `progress` is told how far
    it is, in percent: reading the tabs is the first 60, checking the businesses the rest."""

    def tell(percent: float) -> None:
        if progress is not None:
            progress(min(99, int(percent)))

    report = reader.read(content, niche, lambda share: tell(share * 60))
    tabs: dict[str, dict[str, Any]] = {}
    problems: list[dict[str, Any]] = []
    for name in report.tab_names:
        layout = report.tab_columns.get(name)
        columns = (
            check.check_tab(layout["fields"], layout["duplicates"], layout["city_not_tab"])
            if layout
            else []
        )
        tabs[name] = {"errors": 0, "warnings": 0, "columns": [i.as_dict() for i in columns]}
    rows = {f"{row.tab} row {row.line}": row for row in report.sheet}
    order = {name: index for index, name in enumerate(report.tab_names)}
    leads: list[dict[str, Any]] = []
    for index, lead in enumerate(report.leads):
        if index % 200 == 0:
            tell(60 + 40 * index / max(1, len(report.leads)))
        found = check.check_lead(lead.values)
        first = rows.get(lead.rows[0])
        leads.append(
            {
                "tab": first.tab if first else "",
                "line": first.line if first else 0,
                "rows": lead.rows,
                "values": {k: lead.values[k][:500] for k in TABLE_FIELDS if lead.values.get(k)},
                "issues": [i.as_dict() for i in found],
            }
        )
        for item in found:
            row = _where(lead, item.field, rows)
            kind = "errors" if item.severity == "error" else "warnings"
            tabs.setdefault(row.tab, {"errors": 0, "warnings": 0, "columns": []})[kind] += 1
            problems.append(
                item.as_dict()
                | {
                    "tab": row.tab,
                    "line": row.line,
                    "business": lead.values.get("business_name") or lead.values.get("gbp_link"),
                    "value": lead.values.get(item.field, "")[:300],
                }
            )
    problems.sort(key=lambda p: (order.get(p["tab"], 0), p["line"], p["severity"] != "error"))
    errors = sum(t["errors"] for t in tabs.values())
    warnings = sum(t["warnings"] + len(t["columns"]) for t in tabs.values())
    return Checked(
        businesses=len(report.leads),
        fingerprint=_fingerprint(report),
        check={"errors": errors, "warnings": warnings, "tabs": tabs, "cities": _cities(report)},
        problems=problems,
        leads=leads,
    )


# --- Top Review (step 32) -------------------------------------------------------------------


def city_key(city: str) -> str:
    return city.strip().lower()


def _cities(report: reader.Report) -> dict[str, dict[str, Any]]:
    """Each city of the file (lower case) -> its name and how many businesses it has."""
    found: dict[str, dict[str, Any]] = {}
    for lead in report.leads:
        city = lead.values.get("city", "")
        item = found.setdefault(city_key(city), {"name": city, "businesses": 0})
        item["businesses"] += 1
    return found


def cities_on(cities: dict[str, dict[str, Any]]) -> list[str]:
    """The cities that need a Top: those with fewer than 10 businesses are off, as in a
    batch (SPEC section 6.4 item 8)."""
    return [key for key, item in cities.items() if item["businesses"] >= SMALL_CITY]


def all_topped(cities: dict[str, dict[str, Any]], tops: dict[str, list[str]]) -> bool:
    return all(tops.get(key) for key in cities_on(cities))


def cities(sub: Submission) -> dict[str, dict[str, Any]]:
    """A checked file's cities (each with its name and businesses)."""
    found: dict[str, dict[str, Any]] = sub.check.get("cities", {})
    return found


def lock_if_topped(sub: Submission) -> None:
    """A checked file without errors whose every city that is on has a Top is ready, and
    locked for Top Review."""
    if sub.state != "checked" or sub.check.get("errors") or sub.topped_at is not None:
        return
    if all_topped(cities(sub), sub.tops):
        sub.topped_at = now()


def city_businesses(content: bytes, niche: str, key: str) -> list[dict[str, Any]]:
    """The businesses of one city of the file, as they will be saved: each with its key
    (the first row it is on), its values and its other columns."""
    report = reader.read(content, niche)
    return [
        {
            "key": lead.rows[0],
            "rows": lead.rows,
            "values": {k: v for k, v in lead.values.items() if v and k not in ("niche", "level")},
            "extra": lead.extra,
        }
        for lead in report.leads
        if city_key(lead.values.get("city", "")) == key
    ]


def _open(content: bytes) -> Any:
    try:
        return load_workbook(io.BytesIO(content))
    except (InvalidFileException, zipfile.BadZipFile, KeyError, OSError, ValueError) as error:
        message = "This isn't an Excel file (.xlsx). Save it as .xlsx and try again."
        raise reader.ReadError(message) from error


def _unmark(book: Any) -> bool:
    """Take out what an earlier marked copy added: its report tab, notes and colours."""
    changed = False
    for sheet in list(book.worksheets):
        if sheet.title.startswith(REPORT_TAB) and sheet.cell(1, 1).value == REPORT_HEADER[0]:
            book.remove(sheet)
            changed = True
            continue
        for line in sheet.iter_rows():
            for cell in line:
                if cell.comment is not None and cell.comment.author == AUTHOR:
                    cell.comment = None
                    if cell.fill.fgColor.rgb in ("00F8C9C9", "00FFF1B8"):
                        cell.fill = NO_FILL
                    changed = True
    return changed


def clean(content: bytes) -> bytes:
    """A revised file as handed in, without the marks of the copy it was fixed in."""
    book = _open(content)
    if not _unmark(book):
        return content
    out = io.BytesIO()
    book.save(out)
    return out.getvalue()


def _columns(sheet: Any) -> tuple[int, dict[str, int]] | None:
    """The header row of a tab and the column of each field (the first one, as read)."""
    top = [tuple(c.value for c in line) for line in sheet.iter_rows(max_row=5)]
    at = reader._header_row(top)
    if at is None:
        return None
    found: dict[str, int] = {}
    for index, cell in enumerate(top[at]):
        target = reader.HEADER_TO_FIELD.get(reader._squash(reader.clean(cell)))
        if target and target not in found:
            found[target] = index + 1
    return at + 1, found


def marked(content: bytes, problems: list[dict[str, Any]], tab_check: dict[str, Any]) -> bytes:
    """The file as handed in, each wrong cell red (error) or yellow (warning) with a note,
    and a first tab listing every problem."""
    book = _open(content)
    _unmark(book)
    sheets = {reader.clean(s.title): s for s in book.worksheets}
    layouts = {name: _columns(sheet) for name, sheet in sheets.items()}
    for item in problems:
        sheet, layout = sheets.get(item["tab"]), layouts.get(item["tab"])
        column = layout[1].get(item["field"]) if layout else None
        if sheet is None or column is None:
            continue
        cell = sheet.cell(item["line"], column)
        error = item["severity"] == "error"
        if error or cell.fill != RED:
            cell.fill = RED if error else YELLOW
        old = cell.comment.text + "\n" if cell.comment else ""
        cell.comment = Comment(f"{old}{'Error' if error else 'Warning'}: {item['message']}", AUTHOR)
    report = book.create_sheet(REPORT_TAB, 0)
    report.append(REPORT_HEADER)
    for cell in report[1]:
        cell.font = Font(bold=True)
    for item in problems:
        report.append(
            [
                "Error" if item["severity"] == "error" else "Warning",
                item["tab"],
                item["line"],
                check.STANDARD.get(item["field"], item["field"]),
                item.get("business") or "",
                item["message"],
                item.get("value") or "",
            ]
        )
    for tab, counts in (tab_check.get("tabs") or {}).items():
        for item in counts.get("columns", []):
            column = check.STANDARD.get(item["field"], item["field"])
            report.append(["Warning", tab, "", column, "", item["message"], ""])
    if report.max_row == 1:
        report.append(["", "", "", "", "", "No problems: this file is ready.", ""])
    for line in report.iter_rows(min_row=2):
        for cell in line:
            if isinstance(cell.value, str):
                cell.data_type = "s"  # text: a value starting with = never runs as a formula
    for index, width in enumerate([10, 18, 7, 16, 30, 50, 40]):
        report.column_dimensions[report.cell(1, index + 1).column_letter].width = width
    report.freeze_panes = "A2"
    for sheet in book.worksheets:
        sheet.sheet_view.tabSelected = False
    report.sheet_view.tabSelected = True
    book.active = 0
    out = io.BytesIO()
    book.save(out)
    return out.getvalue()
