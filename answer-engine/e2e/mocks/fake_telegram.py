"""A stand-in for the Telegram Bot API, for the end-to-end tests.

Every call is remembered; the tests read them with GET /_sent and clear them with
DELETE /_sent.
"""

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

SENT: list[dict[str, Any]] = []
LOCK = threading.Lock()
NEXT_ID = [500]


class Handler(BaseHTTPRequestHandler):
    def send(self, obj: Any) -> None:
        data = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        method = self.path.rsplit("/", 1)[-1]
        with LOCK:
            NEXT_ID[0] += 1
            SENT.append({"method": method, "id": NEXT_ID[0], **body})
            message_id = NEXT_ID[0]
        if method == "sendMessage":
            result: Any = {"message_id": message_id}
        elif method == "getMe":
            result = {"username": "gr_answers_bot"}
        else:
            result = True
        self.send({"ok": True, "result": result})

    def do_GET(self) -> None:
        with LOCK:
            self.send(SENT)

    def do_DELETE(self) -> None:
        with LOCK:
            SENT.clear()
        self.send({"ok": True})

    def log_message(self, *args: Any) -> None:
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
