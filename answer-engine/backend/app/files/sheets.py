"""What the spreadsheet readers hand to the chunker: one table per sheet."""

from dataclasses import dataclass, field


@dataclass
class Sheet:
    name: str | None  # None for a CSV file
    headers: list[str]
    rows: list[tuple[int, list[str]]]  # (row number as shown in Excel, cell texts)
    notes: list[str] = field(default_factory=list)  # title lines above the header row


@dataclass
class Workbook:
    sheets: list[Sheet]
    warning: str | None = None
