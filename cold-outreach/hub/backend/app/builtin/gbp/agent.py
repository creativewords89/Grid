"""The GBP audit agent's runs (`agents/gbp-audit/SPEC.md`): collect each ready lead's Google
Business Profile, posts and latest reviews from DataForSEO's Standard queue, and save what
was collected as the lead's result (`details`) and a `gbp.json` file. Step 48 only collects;
comparing with the batch's benchmark and listing opportunities come next.

A run: the leads' GBP links become profile IDs; the profiles are posted to DataForSEO at
once and fetched when ready; then the found profiles' posts and reviews. The Hub hears
from the agent while it waits, so it can stop it."""

import json
import logging
import re
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from app.builtin.gbp import collect, links
from app.builtin.gbp.dataforseo import INFO, POSTS, REVIEWS, US, DataForSeo, DataForSeoError
from app.config import get_settings

if TYPE_CHECKING:
    from app.builtin.client import HubClient

COST_PER_ITEM = 0.01
POLL_SECONDS = 20.0  # how often waiting tasks are fetched again (tests set it to 0)
sleep: Callable[[float], None] = time.sleep

MANIFEST: dict[str, Any] = {
    "name": "GBP audit agent",
    "version": "0.1.0",
    "description": "Collects each lead's Google Business Profile, posts and latest reviews "
    "from DataForSEO. It doesn't compare or score yet.",
    "settings": [
        {
            "key": "items",
            "type": "int",
            "label": "Leads per run",
            "help": "How many leads one run collects at most.",
            "default": 50,
            "min": 1,
            "max": 1000,
        },
        {
            "key": "posts",
            "type": "int",
            "label": "Posts to collect",
            "help": "The latest posts per profile; DataForSEO charges per 10.",
            "default": 20,
            "min": 10,
            "max": 100,
        },
        {
            "key": "reviews",
            "type": "int",
            "label": "Reviews to collect",
            "help": "The latest reviews per profile; 0 collects none.",
            "default": 50,
            "min": 0,
            "max": 100,
        },
        {
            "key": "wait_minutes",
            "type": "int",
            "label": "Longest wait for DataForSEO (minutes)",
            "help": "Leads not ready by then are tried again on the next run.",
            "default": 60,
            "min": 5,
            "max": 240,
        },
    ],
    "connections": ["dataforseo"],
    "result_label": "GBP",
    "cost_per_item_usd": COST_PER_ITEM,
}

log = logging.getLogger("gbp-audit")


class Stopped(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _digits(text: Any) -> str:
    return re.sub(r"\D", "", str(text or ""))[-10:]


def _words(text: Any) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", str(text or "").lower())) - {"llc", "inc", "the", "co"}


def same_business(lead: dict[str, Any], info: dict[str, Any]) -> bool:
    """Whether a profile found by name and address is the lead's: the same phone, or most of
    the lead's name in the profile's."""
    phone = _digits(lead.get("phone"))
    if phone and len(phone) == 10 and phone == _digits(info.get("phone")):
        return True
    mine, theirs = _words(lead.get("business_name")), _words(info.get("title"))
    return bool(mine) and len(mine & theirs) >= max(1, round(0.75 * len(mine)))


class Run:
    def __init__(self, hub: "HubClient", job: dict[str, Any], api: DataForSeo) -> None:
        self.hub, self.job, self.api = hub, job, api
        self.config = job["config"]
        self.done = self.failed = self.skipped = 0
        self.cost = 0.0

    def counts(self) -> dict[str, Any]:
        return {
            "done": self.done,
            "failed": self.failed,
            "skipped": self.skipped,
            "cost_usd": f"{self.cost:.4f}",
        }

    def report(self) -> None:
        """Progress (also while waiting, so the Hub knows the agent is alive); stop if told."""
        _, reply = self.hub.call("POST", f"/runs/{self.job['run_id']}/progress", self.counts())
        if reply and reply.get("action") == "stop":
            raise Stopped(str(reply.get("reason") or "Stopped in the Hub."))

    def save(
        self,
        lead: dict[str, Any],
        outcome: str,
        status: str,
        summary: str,
        data: dict[str, Any] | None = None,
    ) -> None:
        details: dict[str, Any] = {
            "schema_version": 1,
            "agent": "gbp",
            "lead_id": lead["lead_id"],
            "audited_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "input": {"gbp_link": lead.get("gbp_link", "")},
            "data": data or {},
            "findings": [],  # comparing with the benchmark comes in the next step
            "score": None,
        }
        if data is not None:
            self.hub.upload(
                f"/leads/{lead['lead_id']}/files",
                "gbp.json",
                json.dumps(details, indent=2).encode(),
                "application/json",
            )
            # The full latest reviews and posts stay in the file; the result keeps the rest.
            short = json.loads(json.dumps(data))
            if short.get("reviews"):
                short["reviews"].pop("latest", None)
            if short.get("posts"):
                short["posts"]["items"] = short["posts"]["items"][:5]
            details["data"] = short
        body = {"outcome": outcome, "status": status, "summary": summary, "details": details}
        self.hub.call("PUT", f"/leads/{lead['lead_id']}/result", body)
        if outcome == "done":
            self.done += 1
        elif outcome == "skipped":
            self.skipped += 1
        else:
            self.failed += 1
        self.report()

    def wait(self, endpoint: str, posted: dict[str, str]) -> dict[str, Any]:
        """Each posted task's result list, or its error message; what isn't ready by the
        deadline is missing."""
        out: dict[str, Any] = {}
        deadline = time.monotonic() + 60 * int(self.config["wait_minutes"])
        while True:
            for tag, task_id in posted.items():
                if tag in out:
                    continue
                fetched = self.api.get(endpoint, task_id)
                if fetched.state == "ready":
                    out[tag] = fetched.result
                elif fetched.state == "error":
                    out[tag] = fetched.error
            if len(out) == len(posted) or time.monotonic() >= deadline:
                return out
            self.report()
            sleep(POLL_SECONDS)

    def post(self, endpoint: str, tasks: list[dict[str, Any]]) -> dict[str, str]:
        posted = self.api.post(endpoint, tasks)
        self.cost += sum(p.cost for p in posted)
        for p in posted:
            if p.task_id is None:
                log.warning("%s: DataForSEO refused the %s task: %s", p.tag, endpoint, p.error)
        return {p.tag: p.task_id for p in posted if p.task_id}

    def go(self, leads: list[dict[str, Any]]) -> None:
        searched: set[str] = set()
        tasks = []
        for lead in leads:
            if not lead.get("gbp_link"):
                self.save(lead, "skipped", "NO_GBP_LINK", "No GBP link in the lead file.")
                continue
            place = links.resolve(lead["gbp_link"])
            if place is not None:
                keyword = place.keyword
            else:  # a link without the profile's ID: looked up by name and address
                keyword = f"{lead.get('business_name', '')}, {lead.get('address', '')}".strip(", ")
                searched.add(lead["lead_id"])
            tasks.append(
                {
                    "keyword": keyword,
                    "location_code": US,
                    "language_code": "en",
                    "tag": lead["lead_id"],
                }
            )
        by_id = {lead["lead_id"]: lead for lead in leads}
        posted = self.post(INFO, tasks)
        for tag in {t["tag"] for t in tasks} - set(posted):
            self.save(by_id[tag], "failed", "FAILED", "DataForSEO refused the profile task.")
        answers = self.wait(INFO, posted)
        found: dict[str, dict[str, Any]] = {}
        for tag in posted:
            answer = answers.get(tag)
            lead = by_id[tag]
            if answer is None:
                self.save(lead, "failed", "FAILED", "DataForSEO wasn't ready in time.")
            elif isinstance(answer, str):
                self.save(lead, "failed", "FAILED", f"DataForSEO said: {answer}")
            else:
                items = [x for r in answer for x in r.get("items") or [] if isinstance(x, dict)]
                info = items[0] if items else None
                if info is None or (tag in searched and not same_business(lead, info)):
                    self.save(lead, "done", "NOT_FOUND", "No Google Business Profile found.")
                else:
                    found[tag] = info
        self.extras(by_id, found)

    def extras(self, by_id: dict[str, dict[str, Any]], found: dict[str, dict[str, Any]]) -> None:
        """The posts and reviews of the profiles found, then each lead's result."""
        today = datetime.now(UTC)
        open_ones = {
            tag: info
            for tag, info in found.items()
            if collect.basics(info)["status"] != "closed_forever"
        }
        for tag in set(found) - set(open_ones):
            data = collect.collect(found[tag], None, None, today)
            self.save(by_id[tag], "done", "CLOSED", "Permanently closed on Google.", data)

        def task(tag: str, info: dict[str, Any], **more: Any) -> dict[str, Any]:
            keyword = f"cid:{info['cid']}" if info.get("cid") else str(info.get("title", ""))
            return {
                "keyword": keyword,
                "location_code": US,
                "language_code": "en",
                "tag": tag,
                **more,
            }

        posted_posts = (
            self.post(
                POSTS, [task(t, i, depth=int(self.config["posts"])) for t, i in open_ones.items()]
            )
            if open_ones
            else {}
        )
        depth = int(self.config["reviews"])
        posted_reviews = (
            self.post(
                REVIEWS, [task(t, i, depth=depth, sort_by="newest") for t, i in open_ones.items()]
            )
            if open_ones and depth
            else {}
        )
        post_answers = self.wait(POSTS, posted_posts)
        review_answers = self.wait(REVIEWS, posted_reviews)
        for tag, info in open_ones.items():
            posts = post_answers.get(tag)
            reviews = review_answers.get(tag)
            data = collect.collect(
                info,
                posts if isinstance(posts, list) else None,
                reviews if isinstance(reviews, list) else None,
                today,
            )
            self.save(by_id[tag], "done", "COLLECTED", collect.summary(data), data)


def _leads(hub: "HubClient", job: dict[str, Any]) -> list[dict[str, Any]]:
    """The leads ready for this agent in the run's batches, batch after batch; never Top."""
    leads: list[dict[str, Any]] = []
    for batch in job.get("batches", []):
        status, found = hub.call("GET", f"/batches/{batch['id']}/leads")
        if status == 200:
            leads.extend(x for x in found if x.get("level") != "Top")
    return leads


def do_run(hub: "HubClient", job: dict[str, Any]) -> None:
    config = job["config"]
    limit = min(int(config["items"]), int(job.get("items_left", job["daily_limit"])))
    work = _leads(hub, job)[:limit]
    key = job.get("connections", {}).get("dataforseo", {})
    run_id = job["run_id"]
    if not key.get("dataforseo_login") or not key.get("dataforseo_password"):
        hub.call(
            "POST",
            f"/runs/{run_id}/finish",
            {
                "status": "failed",
                "stop_reason": "Enter DataForSEO's login and password in Connections first.",
            },
        )
        return
    api = DataForSeo(
        get_settings().dataforseo_url, key["dataforseo_login"], key["dataforseo_password"]
    )
    run = Run(hub, job, api)
    log.info("run %s: %d leads", run_id, len(work))
    try:
        if work:
            run.go(work)
    except Stopped as stop:
        hub.call(
            "POST",
            f"/runs/{run_id}/finish",
            run.counts() | {"status": "stopped", "stop_reason": stop.reason},
        )
        return
    except DataForSeoError as error:
        hub.call(
            "POST",
            f"/runs/{run_id}/finish",
            run.counts() | {"status": "failed", "stop_reason": str(error)},
        )
        return
    hub.call(
        "POST",
        f"/runs/{run_id}/finish",
        run.counts() | {"status": "succeeded", "summary": {"items": len(work)}},
    )
    log.info("run %s finished: %s", run_id, run.counts())
