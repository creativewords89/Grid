"""The demo agent (SPEC step 25): it does no real work. It goes through the leads the Hub
hands it in the batches that chose it, in the running order, and "audits" each by waiting a
moment, giving it a made-up score. `agents/demo/agent.py` is the same agent as a container
of its own, for trying the agent API from outside.
"""

import logging
import time
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.builtin.client import HubClient

COST_PER_ITEM = 0.001

MANIFEST: dict[str, Any] = {
    "name": "Demo agent",
    "version": "1.0.0",
    "description": "Pretends to do its job on its batches' leads, so you can try batches, "
    "tasks, settings and Run now.",
    "settings": [
        {
            "key": "items",
            "type": "int",
            "label": "Items per run",
            "help": "How many leads one run handles at most.",
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
    "result_label": "Demo",
    "cost_per_item_usd": COST_PER_ITEM,
}

log = logging.getLogger("demo-agent")


def _leads(hub: "HubClient", job: dict[str, Any]) -> list[dict[str, Any]]:
    """The leads ready for this agent in the run's batches, batch after batch."""
    leads: list[dict[str, Any]] = []
    for batch in job.get("batches", []):
        status, found = hub.call("GET", f"/batches/{batch['id']}/leads")
        if status == 200:
            leads.extend(found)
    return leads


def do_run(hub: "HubClient", job: dict[str, Any]) -> None:
    config = job["config"]
    work = _leads(hub, job)[: min(int(config["items"]), int(job["daily_limit"]))]
    fail_every = int(config["fail_every"])
    done = failed = 0
    cost = 0.0
    counts: dict[str, Any] = {"done": 0, "failed": 0, "skipped": 0, "cost_usd": "0"}
    log.info("run %s: %d leads", job["run_id"], len(work))
    for number, lead in enumerate(work, start=1):
        time.sleep(float(config["seconds_per_item"]))
        if fail_every and number % fail_every == 0:
            failed += 1
            result: dict[str, Any] = {
                "outcome": "failed",
                "status": "Failed",
                "summary": "A pretend failure.",
            }
        else:
            done += 1
            # A made-up score, so the Leads table has something to show and sort by.
            score = sum(ord(c) for c in lead["lead_id"]) % 101
            result = {
                "outcome": "done",
                "status": "OK",
                "score": score,
                "summary": "A pretend audit by the demo agent.",
            }
        hub.call("PUT", f"/leads/{lead['lead_id']}/result", result)
        cost += COST_PER_ITEM
        counts = {"done": done, "failed": failed, "skipped": 0, "cost_usd": f"{cost:.4f}"}
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
        counts | {"status": "succeeded", "summary": {"items": len(work)}},
    )
    log.info("run %s finished: %d done, %d failed", job["run_id"], done, failed)
