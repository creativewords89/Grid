"""Test runs (SPEC step 50): an agent tried on a few leads, from a batch or pasted GBP links,
right away, its report kept in the run (`Run.test`) and never written to the leads.

The leads are handed to the agent with test IDs (`T-1`, `T-2` …) so its results and files,
saved through the agent API as for any lead, land in the test and not on the real lead.
An agent sees a test run by `test: true` and reads its leads from `test_leads`.
"""

import base64
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.agents import service
from app.db.models import Agent, Batch, Lead, Run, RunStatus, RunTrigger, User
from app.errors import ApiError

MAX_LEADS = 10
KEEP = 20  # the last tests of an agent keep their reports
MAX_FILE = 2_000_000  # bytes of one file kept in a test
PREFIX = "T-"


def lead_out(lead: Lead, benchmark_id: uuid.UUID | None = None) -> dict[str, Any]:
    """A lead as the agent API hands it out (GET /batches/{id}/leads), with the benchmark of
    its batch (step 51: an agent compares with it)."""
    return {
        "benchmark_id": str(benchmark_id) if benchmark_id else None,
        "lead_id": lead.lead_id,
        "niche": lead.niche,
        "city": lead.city,
        "level": lead.level,
        "business_name": lead.business_name,
        "gbp_link": lead.gbp_link,
        "emails": lead.emails,
        **(lead.data or {}),
        "needed_results": {},
        "result": None,
    }


def _from_batch(
    db: Session, batch_id: uuid.UUID | None, count: int, lead_ids: list[str]
) -> tuple[str, list[dict[str, Any]]]:
    if lead_ids:
        found = {x.lead_id: x for x in db.scalars(select(Lead).where(Lead.lead_id.in_(lead_ids)))}
        missing = [x for x in lead_ids if x not in found]
        if missing:
            raise ApiError(
                422,
                "unknown_leads",
                f"No such lead: {', '.join(missing)}.",
                {"lead_ids": "Unknown."},
            )
        batch_ids = {x.batch_id for x in found.values() if x.batch_id}
        benchmarks: dict[uuid.UUID | None, uuid.UUID | None] = {
            b.id: b.benchmark_id for b in db.scalars(select(Batch).where(Batch.id.in_(batch_ids)))
        }
        return ", ".join(lead_ids), [
            lead_out(found[x], benchmarks.get(found[x].batch_id)) for x in lead_ids
        ]
    batch = db.get(Batch, batch_id) if batch_id else None
    if batch is None:
        raise ApiError(422, "invalid", "Choose a batch.", {"batch_id": "Required."})
    leads = list(
        db.scalars(
            select(Lead)
            .where(Lead.batch_id == batch.id, Lead.level != "Top")
            .order_by(Lead.lead_id)
            .limit(count)
        )
    )
    if not leads:
        raise ApiError(409, "no_leads", f"{batch.name} has no leads to test yet.")
    return f"{len(leads)} {'lead' if len(leads) == 1 else 'leads'} from {batch.name}", [
        lead_out(x, batch.benchmark_id) for x in leads
    ]


def _from_links(links: list[str]) -> tuple[str, list[dict[str, Any]]]:
    out: list[dict[str, Any]] = [
        {
            "lead_id": "",
            "niche": "",
            "city": "",
            "level": "",
            "business_name": "",
            "gbp_link": link,
            "emails": [],
            "needed_results": {},
            "result": None,
        }
        for link in links
    ]
    return f"{len(links)} pasted GBP {'link' if len(links) == 1 else 'links'}", out


def start(
    db: Session,
    agent: Agent,
    user: User,
    batch_id: uuid.UUID | None,
    count: int,
    lead_ids: list[str],
    links: list[str],
) -> Run:
    """Queue a test run on up to 10 leads; refused like Run now while the agent is off,
    never connected or busy."""
    if links:
        what, leads = _from_links(links[:MAX_LEADS])
    else:
        what, leads = _from_batch(db, batch_id, min(count, MAX_LEADS), lead_ids[:MAX_LEADS])
    run = service.queue_run(db, agent, RunTrigger.TEST, user)
    handed = []
    for number, lead in enumerate(leads, start=1):
        handed.append(lead | {"lead_id": f"{PREFIX}{number}", "source_lead_id": lead["lead_id"]})
    run.test = {"what": what, "leads": handed, "results": {}, "files": {}}
    _forget_old(db, agent)
    return run


def _forget_old(db: Session, agent: Agent) -> None:
    """Older tests than the last KEEP lose their report; the run (its cost) stays."""
    old = db.scalars(
        select(Run)
        .where(Run.agent_id == agent.id, Run.trigger == RunTrigger.TEST, Run.test.is_not(None))
        .order_by(Run.queued_at.desc())
        .offset(KEEP)
    )
    for run in old:
        run.test = None


def running_test(db: Session, agent: Agent) -> Run | None:
    return db.scalar(
        select(Run).where(
            Run.agent_id == agent.id,
            Run.trigger == RunTrigger.TEST,
            Run.status == RunStatus.RUNNING,
        )
    )


def is_test_lead(lead_id: str) -> bool:
    return lead_id.startswith(PREFIX)


def _test_of(db: Session, agent: Agent, lead_id: str) -> Run:
    run = running_test(db, agent)
    known = {x["lead_id"] for x in (run.test or {}).get("leads", [])} if run else set()
    if run is None or lead_id not in known:
        raise ApiError(404, "not_found", "That lead doesn't exist.")
    return run


def save_result(db: Session, agent: Agent, lead_id: str, result: dict[str, Any]) -> None:
    run = _test_of(db, agent, lead_id)
    assert run.test is not None
    run.test["results"][lead_id] = result
    flag_modified(run, "test")


def save_file(
    db: Session, agent: Agent, lead_id: str, name: str, content_type: str, content: bytes
) -> None:
    run = _test_of(db, agent, lead_id)
    assert run.test is not None
    if len(content) > MAX_FILE:
        raise ApiError(413, "too_large", "A test keeps files up to 2 MB.")
    run.test["files"].setdefault(lead_id, {})[name] = {
        "content_type": content_type,
        "data": base64.b64encode(content).decode(),
    }
    flag_modified(run, "test")
