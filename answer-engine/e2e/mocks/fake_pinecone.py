"""A stand-in for the Pinecone index (data plane only), for the end-to-end tests.

Search scores records by the share of query words they contain, which is enough for the
tests' documents. Records live in memory, so every run starts empty.
"""

import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

DATA: dict[str, dict[str, dict[str, Any]]] = {}
LOCK = threading.Lock()


def words(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9$]+", text.lower()))


class Handler(BaseHTTPRequestHandler):
    def send(self, code: int, obj: Any = None) -> None:
        data = json.dumps(obj or {}).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("content-length") or 0)).decode()
        with LOCK:
            if self.path.endswith("/search"):
                namespace = self.path.split("/")[3]
                query = json.loads(body)
                wanted = words(query["query"]["inputs"]["text"])
                scored = sorted(
                    (
                        (len(wanted & words(r.get("text", ""))) / max(len(wanted), 1), i, r)
                        for i, r in DATA.get(namespace, {}).items()
                    ),
                    key=lambda hit: -hit[0],
                )[: query["rerank"]["top_n"]]
                hits = [
                    {"_id": i, "_score": score, "fields": {"file_id": r.get("file_id")}}
                    for score, i, r in scored
                ]
                return self.send(200, {"result": {"hits": hits}, "usage": {"read_units": 1}})
            if self.path.startswith("/records/namespaces/"):
                namespace = self.path.split("/")[3]
                for line in body.splitlines():
                    record = json.loads(line)
                    DATA.setdefault(namespace, {})[record["_id"]] = record
                return self.send(201)
            if self.path == "/vectors/delete":
                request = json.loads(body)
                for record_id in request["ids"]:
                    DATA.get(request["namespace"], {}).pop(record_id, None)
                return self.send(200)
        self.send(404)

    def do_GET(self) -> None:
        url = urlparse(self.path)
        if url.path == "/vectors/list":
            namespace = parse_qs(url.query).get("namespace", [""])[0]
            with LOCK:
                ids = [{"id": i} for i in DATA.get(namespace, {})]
            return self.send(200, {"vectors": ids, "namespace": namespace})
        self.send(404)

    def log_message(self, *args: Any) -> None:
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
