"""A fake Google for the end-to-end tests: the token endpoint, the Sheets API (keeping a
real grid per tab) and Drive's create/delete. Standard library only.

    python3 fake_google.py 9921

The Hub is pointed at it with GOOGLE_TOKEN_URL, GOOGLE_SHEETS_URL and GOOGLE_DRIVE_URL (see
serve.sh). GET /_state returns every tab, so a test can check what the Hub wrote.
"""

import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

TABS: dict[str, list[list[str]]] = {}
LOCK = threading.Lock()


def column_index(letters: str) -> int:
    index = 0
    for char in letters:
        index = index * 26 + ord(char) - 64
    return index - 1


def put(where: str, values: list[list[str]]) -> None:
    match = re.fullmatch(r"'(.+)'!([A-Z]+)(\d+)(?::[A-Z]+\d+)?", where)
    if match is None:
        raise ValueError(where)
    grid = TABS[match.group(1).replace("''", "'")]
    column, row = column_index(match.group(2)), int(match.group(3)) - 1
    for r, line in enumerate(values):
        while len(grid) <= row + r:
            grid.append([])
        target = grid[row + r]
        for c, value in enumerate(line):
            while len(target) <= column + c:
                target.append("")
            target[column + c] = value


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_: Any) -> None:  # quiet
        pass

    def reply(self, status: int, body: Any = None) -> None:
        data = json.dumps(body if body is not None else {}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self) -> Any:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw) if raw else {}
        except ValueError:
            return {}

    def do_GET(self) -> None:
        path = unquote(urlsplit(self.path).path)
        with LOCK:
            if path == "/_state":
                return self.reply(200, TABS)
            if path.startswith("/sheets/") and "/values/" in path:
                tab = re.search(r"/values/'(.+)'!", path)
                rows = TABS.get(tab.group(1), []) if tab else []
                if path.endswith("!1:1"):
                    rows = rows[:1]
                return self.reply(200, {"values": rows})
            if path.startswith("/sheets/"):
                sheets = [{"properties": {"title": t}} for t in TABS]
                return self.reply(200, {"properties": {"title": "E2E Master"}, "sheets": sheets})
        self.reply(404, {"error": {"message": "not found"}})

    def do_POST(self) -> None:
        parts = urlsplit(self.path)
        path = unquote(parts.path)
        body = self.body()
        with LOCK:
            if path == "/token":
                return self.reply(200, {"access_token": "ya29.e2e", "expires_in": 3600})
            if path.startswith("/drive"):
                return self.reply(200, {"id": "e2e-file"})
            if path.endswith("/values:batchUpdate"):
                for item in body["data"]:
                    put(item["range"], item["values"])
                return self.reply(200)
            if path.endswith(":batchUpdate"):
                for item in body["requests"]:
                    TABS.setdefault(item["addSheet"]["properties"]["title"], [])
                return self.reply(200)
            if path.endswith(":append"):
                assert parse_qs(parts.query)["valueInputOption"] == ["RAW"]
                tab = re.search(r"/values/'(.+)'!", path)
                if tab:
                    TABS[tab.group(1)].extend(list(row) for row in body["values"])
                return self.reply(200)
        self.reply(404, {"error": {"message": "not found"}})

    def do_DELETE(self) -> None:
        self.send_response(204)
        self.end_headers()


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
