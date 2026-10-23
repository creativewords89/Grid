"""Structured JSON logs with request IDs (SPEC section 11).

One JSON object per line on stdout, which Docker keeps (and rotates, see the Compose file).
Every line logged while a request is handled carries its request ID; the same ID goes back
to the browser in `X-Request-ID`, so a problem someone reports can be found in the logs.

Never log API keys, passwords, tokens or question text: only IDs, kinds and counts.
"""

import json
import logging
import re
import sys
import time
import uuid
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any

from fastapi import Request, Response

request_id: ContextVar[str | None] = ContextVar("request_id", default=None)
job: ContextVar[str | None] = ContextVar("job", default=None)  # "<kind>:<id>" in the worker

# An ID from a trusted proxy is kept if it looks like one; anything else is replaced.
_INCOMING_ID = re.compile(r"^[A-Za-z0-9._-]{8,64}$")
# Standard LogRecord fields; anything else passed as `extra=` is added to the JSON.
_RESERVED = set(vars(logging.makeLogRecord({}))) | {"message", "asctime", "color_message"}

access = logging.getLogger("access")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        line: dict[str, Any] = {
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
        }
        rid = request_id.get()
        if rid is not None:
            line["request_id"] = rid
        running = job.get()
        if running is not None:
            line["job"] = running
        for key, value in vars(record).items():
            if key not in _RESERVED and not key.startswith("_"):
                line[key] = value
        if record.exc_info:
            line["error"] = self.formatException(record.exc_info)
        return json.dumps(line, default=str, ensure_ascii=False)


def setup(json_logs: bool, level: int = logging.INFO) -> None:
    """Send every log line (ours, uvicorn's, SQLAlchemy's) through one handler."""
    handler = logging.StreamHandler(sys.stdout)
    if json_logs:
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
    for name in ("uvicorn", "uvicorn.error"):
        logging.getLogger(name).handlers[:] = []
        logging.getLogger(name).propagate = True
    # The access log below replaces uvicorn's, which would log query strings (the
    # stop-emails link carries a token in its query).
    logging.getLogger("uvicorn.access").disabled = True
    # The SDKs log request bodies at DEBUG; keep them quiet whatever the level.
    for name in ("httpx", "httpcore", "anthropic", "pinecone", "urllib3"):
        logging.getLogger(name).setLevel(logging.WARNING)


async def request_ids(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """Give each request an ID, log one access line for it, and return the ID."""
    incoming = request.headers.get("x-request-id", "")
    rid = incoming if _INCOMING_ID.match(incoming) else uuid.uuid4().hex
    token = request_id.set(rid)
    started = time.perf_counter()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        response.headers["X-Request-ID"] = rid
        return response
    finally:
        if request.url.path != "/api/health":  # Docker checks it every 15 s
            access.info(
                "%s %s %s",
                request.method,
                request.url.path,
                status,
                extra={
                    "method": request.method,
                    "path": request.url.path,  # never the query string
                    "status": status,
                    "ms": round((time.perf_counter() - started) * 1000, 1),
                },
            )
        request_id.reset(token)
