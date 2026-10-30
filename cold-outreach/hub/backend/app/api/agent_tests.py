"""`/api/agents/{key}/tests`: an agent's test runs (SPEC step 50). Owners and Admins start a
test on up to 10 leads, from a batch or pasted GBP links; anyone in the Hub reads its
report. A test's results never reach the leads."""

import base64
import binascii
import uuid
from collections import Counter
from typing import Annotated, Any

from fastapi import APIRouter, Response
from pydantic import BaseModel, Field, StringConstraints

from app import audit
from app.agents import trials
from app.api.agents import RunOut, _get
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.db.models import Run, RunTrigger
from app.errors import ApiError
from app.permissions import Action, ensure

router = APIRouter(prefix="/agents", tags=["agents"])

LeadId = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=12)]
Link = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]


class TestIn(Strict):
    batch_id: uuid.UUID | None = None
    count: Annotated[int, Field(ge=1, le=trials.MAX_LEADS)] = 5
    lead_ids: list[LeadId] = Field(default_factory=list, max_length=trials.MAX_LEADS)
    links: list[Link] = Field(default_factory=list, max_length=trials.MAX_LEADS)


class TestOut(RunOut):
    what: str  # "5 leads from Construction", "2 pasted GBP links" …
    statuses: dict[str, int]  # how many leads got each status so far


class TestLead(BaseModel):
    key: str  # T-1 …
    lead_id: str  # the real lead, or "" for a pasted link
    business_name: str
    city: str
    gbp_link: str
    result: dict[str, Any] | None
    files: list[str]


class TestReport(TestOut):
    leads: list[TestLead]


def _out(run: Run) -> TestOut:
    test = run.test or {}
    statuses = Counter(str(r.get("status")) for r in test.get("results", {}).values())
    return TestOut(
        **RunOut.of(run).model_dump(), what=str(test.get("what", "")), statuses=dict(statuses)
    )


def _test(db: Db, key: str, run_id: uuid.UUID) -> Run:
    agent = _get(db, key)
    run = db.get(Run, run_id)
    if run is None or run.agent_id != agent.id or run.trigger != RunTrigger.TEST or not run.test:
        raise ApiError(404, "not_found", "That test doesn't exist.")
    return run


@router.post("/{key}/tests", response_model=TestOut, status_code=201)
def start_test(key: str, body: TestIn, me: CurrentUser, db: Db) -> TestOut:
    """Test the agent now on a few leads: a batch's first ones, the Lead IDs given, or pasted
    GBP links."""
    ensure(me, Action.OPERATE_AGENTS)
    agent = _get(db, key)
    run = trials.start(db, agent, me, body.batch_id, body.count, body.lead_ids, body.links)
    audit.record(db, me, "test", "agent", agent.key, agent.name, [])
    db.commit()
    db.refresh(run)
    return _out(run)


@router.get("/{key}/tests", response_model=list[TestOut])
def list_tests(key: str, me: CurrentUser, db: Db) -> list[TestOut]:
    """The agent's last tests, newest first."""
    ensure(me, Action.VIEW_HUB)
    agent = _get(db, key)
    tests = db.query(Run).filter(
        Run.agent_id == agent.id, Run.trigger == RunTrigger.TEST, Run.test.is_not(None)
    )
    return [_out(run) for run in tests.order_by(Run.queued_at.desc()).limit(trials.KEEP)]


@router.get("/{key}/tests/{run_id}", response_model=TestReport)
def get_test(key: str, run_id: uuid.UUID, me: CurrentUser, db: Db) -> TestReport:
    ensure(me, Action.VIEW_HUB)
    run = _test(db, key, run_id)
    test = run.test or {}
    leads = [
        TestLead(
            key=lead["lead_id"],
            lead_id=lead.get("source_lead_id") or "",
            business_name=lead.get("business_name") or "",
            city=lead.get("city") or "",
            gbp_link=lead.get("gbp_link") or "",
            result=test.get("results", {}).get(lead["lead_id"]),
            files=sorted(test.get("files", {}).get(lead["lead_id"], {})),
        )
        for lead in test.get("leads", [])
    ]
    return TestReport(**_out(run).model_dump(), leads=leads)


@router.get("/{key}/tests/{run_id}/files/{lead_key}/{name}")
def test_file(
    key: str, run_id: uuid.UUID, lead_key: str, name: str, me: CurrentUser, db: Db
) -> Response:
    """A file the agent saved for a test lead, e.g. gbp.json."""
    ensure(me, Action.VIEW_HUB)
    run = _test(db, key, run_id)
    found = (run.test or {}).get("files", {}).get(lead_key, {}).get(name)
    if found is None:
        raise ApiError(404, "not_found", "That file doesn't exist.")
    try:
        content = base64.b64decode(found["data"])
    except (binascii.Error, KeyError, TypeError):
        raise ApiError(404, "not_found", "That file doesn't exist.") from None
    return Response(
        content,
        media_type=str(found.get("content_type") or "application/octet-stream"),
        headers={
            "Content-Disposition": f'attachment; filename="{lead_key}-{name}"',
            "X-Content-Type-Options": "nosniff",
        },
    )
