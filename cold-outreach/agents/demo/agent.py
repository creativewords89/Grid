"""A demo agent for trying the Agent Hub (hub/SPEC.md section 6.2). It does no real work:
each "item" just waits a moment. Only Python's standard library is needed.

    HUB_URL=http://localhost:8000 AGENT_TOKEN=hub_agent_… python agent.py

Every real agent follows the same steps:
1. send its manifest when it starts (PUT /api/agent/v1/manifest);
2. ask for work every 30 seconds (GET /api/agent/v1/next-run; 204 means nothing to do);
3. report progress after each few items and stop when the Hub says "stop";
4. report how the run ended (POST /api/agent/v1/runs/{id}/finish).
"""

import json
import logging
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any

MANIFEST = {
    "name": "Demo agent",
    "version": "1.0.0",
    "description": "Pretends to audit leads, so you can try switches, settings and Run now.",
    "settings": [
        {
            "key": "items",
            "type": "int",
            "label": "Items per run",
            "help": "How many pretend leads one run handles.",
            "default": 10,
            "min": 1,
            "max": 1000,
        },
        {
            "key": "seconds_per_item",
            "type": "float",
            "label": "Seconds per item",
            "default": 1.0,
            "min": 0,
            "max": 60,
        },
        {
            "key": "fail_every",
            "type": "int",
            "label": "Fail every Nth item (0 = never)",
            "default": 0,
            "min": 0,
            "max": 100,
        },
    ],
    "connections": [],
    "sheet_columns": [],
    "cost_per_item_usd": 0.001,
}

log = logging.getLogger("demo-agent")


class Hub:
    def __init__(self, url: str, token: str) -> None:
        self.base = url.rstrip("/") + "/api/agent/v1"
        self.token = token

    def call(self, method: str, path: str, body: Any = None) -> tuple[int, Any]:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(  # noqa: S310  (the Hub's own address)
            self.base + path,
            data=data,
            method=method,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
                text = response.read().decode()
                return response.status, json.loads(text) if text else None
        except urllib.error.HTTPError as error:
            text = error.read().decode()
            return error.code, json.loads(text) if text else None


def do_run(hub: Hub, job: dict[str, Any]) -> None:
    config = job["config"]
    total = min(int(config["items"]), int(job["daily_limit"]))
    done = failed = 0
    cost = 0.0
    log.info("run %s: %d items", job["run_id"], total)
    for number in range(1, total + 1):
        time.sleep(float(config["seconds_per_item"]))
        fail_every = int(config["fail_every"])
        if fail_every and number % fail_every == 0:
            failed += 1
        else:
            done += 1
        cost += MANIFEST["cost_per_item_usd"]  # type: ignore[operator]
        counts = {"done": done, "failed": failed, "skipped": 0, "cost_usd": f"{cost:.4f}"}
        if number % 5 == 0 or number == total:
            _, reply = hub.call("POST", f"/runs/{job['run_id']}/progress", counts)
            if reply and reply.get("action") == "stop":
                log.info("the Hub said stop: %s", reply.get("reason"))
                hub.call(
                    "POST",
                    f"/runs/{job['run_id']}/finish",
                    counts | {"status": "stopped", "stop_reason": reply.get("reason")},
                )
                return
    hub.call(
        "POST",
        f"/runs/{job['run_id']}/finish",
        counts | {"status": "succeeded", "summary": {"items": total}},
    )
    log.info("run %s finished: %d done, %d failed", job["run_id"], done, failed)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    url, token = os.environ.get("HUB_URL", ""), os.environ.get("AGENT_TOKEN", "")
    if not url or not token:
        sys.exit("Set HUB_URL and AGENT_TOKEN (from the Hub's Agents screen).")
    poll = float(os.environ.get("POLL_SECONDS", "30"))
    hub = Hub(url, token)
    status, reply = hub.call("PUT", "/manifest", MANIFEST)
    if status != 200:
        sys.exit(f"The Hub refused the manifest ({status}): {reply}")
    log.info("connected to the Hub; waiting for work")
    while True:
        status, job = hub.call("GET", "/next-run")
        if status == 200:
            do_run(hub, job)
            continue
        if status != 204:
            log.warning("the Hub answered %s: %s", status, job)
        time.sleep(poll)


if __name__ == "__main__":
    main()
