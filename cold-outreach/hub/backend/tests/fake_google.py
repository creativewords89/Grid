"""A fake Google (token + Sheets API) that keeps a real grid per tab, for import tests."""

import json
import re
from dataclasses import dataclass, field
from urllib.parse import unquote

import httpx2

from app.imports.sheet import column_letter


def _column_index(letters: str) -> int:
    index = 0
    for char in letters:
        index = index * 26 + ord(char) - 64
    return index - 1


@dataclass
class FakeSheets:
    tabs: dict[str, list[list[str]]] = field(default_factory=dict)
    writes: int = 0
    fail_writes: bool = False

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        if request.url.host == "oauth2.googleapis.com":
            return httpx2.Response(200, json={"access_token": "ya29.fake"})
        path = unquote(request.url.path)
        if request.method == "GET" and "/values/" not in path:
            return httpx2.Response(
                200, json={"sheets": [{"properties": {"title": t}} for t in self.tabs]}
            )
        if path.endswith(":batchUpdate") and "/values" not in path:
            for item in json.loads(request.content)["requests"]:
                self.tabs.setdefault(item["addSheet"]["properties"]["title"], [])
            return httpx2.Response(200, json={})
        if request.method == "GET":
            tab = re.search(r"/values/'(.+)'!", path)
            assert tab is not None
            return httpx2.Response(200, json={"values": self.tabs[tab.group(1)]})
        if self.fail_writes:
            return httpx2.Response(500, json={"error": {"message": "backend error"}})
        self.writes += 1
        body = json.loads(request.content)
        if path.endswith("values:batchUpdate"):
            assert body["valueInputOption"] == "RAW"
            for item in body["data"]:
                self._put(item["range"], item["values"])
            return httpx2.Response(200, json={})
        assert path.endswith(":append") and request.url.params["valueInputOption"] == "RAW"
        tab = re.search(r"/values/'(.+)'!", path)
        assert tab is not None
        self.tabs[tab.group(1)].extend([list(row) for row in body["values"]])
        return httpx2.Response(200, json={})

    def _put(self, where: str, values: list[list[str]]) -> None:
        match = re.fullmatch(r"'(.+)'!([A-Z]+)(\d+)(?::[A-Z]+\d+)?", where)
        assert match is not None, where
        grid = self.tabs[match.group(1)]
        column, row = _column_index(match.group(2)), int(match.group(3)) - 1
        for r, line in enumerate(values):
            while len(grid) <= row + r:
                grid.append([])
            target = grid[row + r]
            for c, value in enumerate(line):
                while len(target) <= column + c:
                    target.append("")
                target[column + c] = value

    def table(self, tab: str = "Leads") -> list[dict[str, str]]:
        """The tab as dicts keyed by header (empty cells as "")."""
        grid = self.tabs[tab]
        header = grid[0]
        return [
            {name: (row[i] if i < len(row) else "") for i, name in enumerate(header)}
            for row in grid[1:]
        ]


__all__ = ["FakeSheets", "column_letter"]
