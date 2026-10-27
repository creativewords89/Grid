"""Writing leads to the Master Sheet's Leads tab (SPEC section 6.4).

Rows are found by Lead ID and columns by header name, never by position, so people may sort
the tab or move columns. Only the import's own columns are written; the agents' columns are
never touched. Values are written as plain text (RAW), so a cell from an uploaded file that
starts with "=" can't become a formula.
"""

import time
from collections.abc import Iterable
from typing import Any
from urllib.parse import quote

import httpx2

from app import providers
from app.config import get_settings
from app.providers import ProviderError

TAB = "Leads"
# Header -> lead field, in the order a new Leads tab gets them (PLAN.md section 3.2).
COLUMNS: dict[str, str] = {
    "Lead ID": "lead_id",
    "City": "city",
    "Niche": "niche",
    "Batch": "batch",
    "Level": "level",
    "Business Name": "business_name",
    "GBP Link": "gbp_link",
    "Address": "address",
    "Website": "website",
    "Phone": "phone",
    "WhatsApp": "whatsapp",
    "Facebook": "facebook",
    "Instagram": "instagram",
    "Email": "email",
    "Reviews": "reviews",
    "Rating": "rating",
    "Notes": "notes",
}
RANGES_PER_REQUEST = 500
ROWS_PER_APPEND = 2000


def column_letter(index: int) -> str:
    """0 -> A, 25 -> Z, 26 -> AA."""
    letters = ""
    index += 1
    while index:
        index, rest = divmod(index - 1, 26)
        letters = chr(65 + rest) + letters
    return letters


class Sheet:
    def __init__(self, token: str, sheet_id: str) -> None:
        self.base = f"{get_settings().google_sheets_url}/{sheet_id}"
        self.headers = {"Authorization": f"Bearer {token}"}
        self.client = httpx2.Client(timeout=60.0, transport=providers.transport)

    def _call(self, method: str, path: str, **kwargs: Any) -> Any:
        for attempt in range(3):
            try:
                response = self.client.request(
                    method, self.base + path, headers=self.headers, **kwargs
                )
            except httpx2.HTTPError as error:
                raise ProviderError(f"Google can't be reached ({type(error).__name__}).") from None
            if response.status_code == 429 and attempt < 2:  # write quota: wait and retry
                time.sleep(20 * (attempt + 1))
                continue
            if response.status_code != 200:
                raise ProviderError(f"Master Sheet: {providers.google_reason(response)}")
            return response.json()
        raise ProviderError('Master Sheet: Google kept saying "too many requests".')

    def tabs(self) -> list[str]:
        data = self._call("GET", "", params={"fields": "sheets.properties.title"})
        return [s["properties"]["title"] for s in data.get("sheets", [])]

    def add_tab(self, title: str) -> None:
        self._call(
            "POST",
            ":batchUpdate",
            json={"requests": [{"addSheet": {"properties": {"title": title}}}]},
        )

    def read(self, tab: str) -> list[list[str]]:
        data = self._call("GET", f"/values/{quote(_a1(tab, 'A:ZZ'))}")
        return [[str(cell) for cell in row] for row in data.get("values", [])]

    def write(self, tab: str, cells: list[tuple[str, list[list[str]]]]) -> None:
        """Write ranges such as ("A5:P5", [[…]]), in batches."""
        for start in range(0, len(cells), RANGES_PER_REQUEST):
            chunk = cells[start : start + RANGES_PER_REQUEST]
            self._call(
                "POST",
                "/values:batchUpdate",
                json={
                    "valueInputOption": "RAW",
                    "data": [
                        {"range": _a1(tab, where), "values": values} for where, values in chunk
                    ],
                },
            )

    def append(self, tab: str, rows: list[list[str]]) -> None:
        for start in range(0, len(rows), ROWS_PER_APPEND):
            self._call(
                "POST",
                f"/values/{quote(_a1(tab, 'A1'))}:append",
                params={"valueInputOption": "RAW", "insertDataOption": "INSERT_ROWS"},
                json={"values": rows[start : start + ROWS_PER_APPEND]},
            )


def _a1(tab: str, where: str) -> str:
    return "'" + tab.replace("'", "''") + "'!" + where


def _runs(indexes: Iterable[int]) -> list[list[int]]:
    """Group sorted column indexes into runs of neighbours: [0,1,2,5] -> [[0,1,2],[5]]."""
    groups: list[list[int]] = []
    for index in sorted(indexes):
        if groups and index == groups[-1][-1] + 1:
            groups[-1].append(index)
        else:
            groups.append([index])
    return groups


def write_leads(sheet: Sheet, leads: list[dict[str, str]], *, write_level: bool) -> tuple[int, int]:
    """Add new leads and update existing ones (matched by Lead ID). Empty values never blank
    a filled cell; Level is written only when the file had a Level column.
    Returns (rows added, rows updated)."""
    if TAB not in sheet.tabs():
        sheet.add_tab(TAB)
        sheet.write(TAB, [(f"A1:{column_letter(len(COLUMNS) - 1)}1", [list(COLUMNS)])])
    grid = sheet.read(TAB)
    header = grid[0] if grid else []
    positions = {name.strip().lower(): index for index, name in enumerate(header) if name.strip()}
    missing = [name for name in COLUMNS if name.lower() not in positions]
    if missing:  # put any of our columns that aren't there at the end of the header row
        start = len(header)
        sheet.write(
            TAB,
            [(f"{column_letter(start)}1:{column_letter(start + len(missing) - 1)}1", [missing])],
        )
        for offset, name in enumerate(missing):
            positions[name.lower()] = start + offset
    where = {name: positions[name.lower()] for name in COLUMNS}
    id_column = where["Lead ID"]
    row_of = {
        row[id_column].strip(): number
        for number, row in enumerate(grid[1:], start=2)
        if len(row) > id_column and row[id_column].strip()
    }

    width = max(where.values()) + 1
    new_rows: list[list[str]] = []
    updates: list[tuple[str, list[list[str]]]] = []
    for lead in leads:
        values = {
            index: lead.get(field, "")
            for name, field in COLUMNS.items()
            for index in [where[name]]
            if field != "level" or write_level
        }
        number = row_of.get(lead["lead_id"])
        if number is None:
            row = [""] * width
            for index, value in values.items():
                row[index] = value
            new_rows.append(row)
            continue
        filled = {index: value for index, value in values.items() if value}
        if write_level:
            filled[where["Level"]] = lead.get("level", "")
        for run in _runs(filled):
            span = f"{column_letter(run[0])}{number}:{column_letter(run[-1])}{number}"
            updates.append((span, [[filled[index] for index in run]]))
    if updates:
        sheet.write(TAB, updates)
    if new_rows:
        sheet.append(TAB, new_rows)
    updated = sum(1 for lead in leads if lead["lead_id"] in row_of)
    return len(new_rows), updated
