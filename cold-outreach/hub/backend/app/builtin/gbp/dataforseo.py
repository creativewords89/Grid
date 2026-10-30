"""DataForSEO's Standard queue for the GBP audit agent (`agents/gbp-audit/SPEC.md` section 3):
tasks are posted (up to 100 at once, each tagged with its Lead ID), then each is fetched
until it is ready. Posting is what costs money; DataForSEO says how much per task."""

from dataclasses import dataclass
from typing import Any

import httpx2

INFO = "business_data/google/my_business_info"
POSTS = "business_data/google/my_business_updates"
REVIEWS = "business_data/google/reviews"

US = 2840  # DataForSEO's location code for the United States
CREATED = 20100
READY = 20000
WAITING = (40601, 40602)  # handed to a worker, or still in the queue
NO_RESULTS = 40102  # nothing found: an empty result, not an error
PER_POST = 100

transport: httpx2.BaseTransport | None = None  # tests swap it for an httpx2.MockTransport


class DataForSeoError(Exception):
    """DataForSEO can't be reached, refused the key, or answered unexpectedly."""


@dataclass
class Posted:
    tag: str  # the Lead ID
    task_id: str | None  # None when DataForSEO refused the task
    cost: float
    error: str = ""


@dataclass
class Fetched:
    state: str  # "ready", "waiting" or "error"
    result: list[dict[str, Any]]
    error: str = ""


class DataForSeo:
    def __init__(self, base: str, login: str, password: str) -> None:
        self.base = base.rstrip("/")
        self.auth = httpx2.BasicAuth(login, password)

    def _call(self, method: str, path: str, body: Any = None) -> dict[str, Any]:
        try:
            with httpx2.Client(timeout=60.0, transport=transport) as client:
                response = client.request(method, f"{self.base}/{path}", json=body, auth=self.auth)
        except httpx2.HTTPError as error:
            raise DataForSeoError(
                f"DataForSEO can't be reached ({type(error).__name__})."
            ) from None
        try:
            data = response.json()
        except ValueError:
            data = None
        if response.status_code == 401 or (data or {}).get("status_code") == 40100:
            raise DataForSeoError("DataForSEO refused the login or password.")
        if not isinstance(data, dict) or data.get("status_code") != READY:
            message = (data or {}).get("status_message") if isinstance(data, dict) else None
            raise DataForSeoError(
                f"DataForSEO said: {message or f'an unexpected answer ({response.status_code})'}"
            )
        return data

    def post(self, endpoint: str, tasks: list[dict[str, Any]]) -> list[Posted]:
        """Post tasks, each with its `tag`; what each was, in the order sent."""
        out: list[Posted] = []
        for start in range(0, len(tasks), PER_POST):
            chunk = tasks[start : start + PER_POST]
            data = self._call("POST", f"{endpoint}/task_post", chunk)
            answered = data.get("tasks") or []
            for sent, task in zip(chunk, answered, strict=False):
                ok = task.get("status_code") == CREATED and task.get("id")
                out.append(
                    Posted(
                        tag=str(sent.get("tag", "")),
                        task_id=str(task["id"]) if ok else None,
                        cost=float(task.get("cost") or 0),
                        error="" if ok else str(task.get("status_message") or "refused"),
                    )
                )
            for sent in chunk[len(answered) :]:
                out.append(Posted(str(sent.get("tag", "")), None, 0.0, "no answer"))
        return out

    def get(self, endpoint: str, task_id: str) -> Fetched:
        data = self._call("GET", f"{endpoint}/task_get/{task_id}")
        task = (data.get("tasks") or [{}])[0]
        code = task.get("status_code")
        if code == READY:
            return Fetched("ready", [r for r in task.get("result") or [] if isinstance(r, dict)])
        if code == NO_RESULTS:
            return Fetched("ready", [])
        if code in WAITING:
            return Fetched("waiting", [])
        return Fetched("error", [], str(task.get("status_message") or f"status {code}"))
