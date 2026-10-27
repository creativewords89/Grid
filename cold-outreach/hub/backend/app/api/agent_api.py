"""`/api/agent/v1`: what agents call (SPEC section 6.2). An agent signs in with its token
(`Authorization: Bearer …`) and can only see and change its own runs."""

import uuid
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request, Response, status
from pydantic import BaseModel, Field, StringConstraints, ValidationError

from app.agents import service
from app.agents.manifest import Manifest
from app.api.schemas import Strict
from app.auth.deps import Db
from app.auth.tokens import now
from app.db.models import Agent, Run, RunStatus
from app.errors import ApiError
from app.runs import service as runs

router = APIRouter(prefix="/agent/v1", tags=["agent api"])


def current_agent(request: Request, db: Db) -> Agent:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    agent = service.find_by_token(db, token.strip()) if scheme.lower() == "bearer" else None
    if agent is None:
        raise ApiError(401, "bad_token", "Unknown agent token.")
    agent.last_seen_at = now()
    return agent


CurrentAgent = Annotated[Agent, Depends(current_agent)]


@router.put("/manifest")
def put_manifest(body: dict[str, Any], agent: CurrentAgent, db: Db) -> dict[str, Any]:
    try:
        manifest = Manifest.model_validate(body)
    except ValidationError as error:
        first = error.errors()[0]
        where = ".".join(str(part) for part in first.get("loc", ()))
        raise ApiError(
            422, "bad_manifest", f"Manifest: {where} {first.get('msg')}".strip()
        ) from None
    agent.manifest = manifest.model_dump(mode="json")
    db.commit()
    return {"ok": True, "config": service.config_of(agent)}


class RunOut(BaseModel):
    run_id: str
    trigger: str
    config: dict[str, Any]
    daily_limit: int
    # What is left today: items under the daily limit, and money under both budgets.
    items_left: int
    budget_left_usd: Decimal
    connections: dict[str, dict[str, str]]


@router.get("/next-run", response_model=RunOut, responses={204: {"description": "Nothing to do"}})
def next_run(agent: CurrentAgent, db: Db, response: Response) -> RunOut | Response:
    if agent.manifest is None:
        raise ApiError(409, "no_manifest", "Send the manifest first (PUT /api/agent/v1/manifest).")
    run = service.start_next(db, agent)
    if run is not None:
        budget = runs.budget(db, agent)
        reason = budget.stop_reason(runs.cost_per_item(agent))
        if reason:  # nothing can be spent today: the run ends before it starts
            run.status = RunStatus.STOPPED
            run.stop_reason = reason
            run.finished_at = now()
            run = None
    db.commit()
    if run is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    return RunOut(
        run_id=str(run.id),
        trigger=run.trigger.value,
        config=service.config_of(agent),
        daily_limit=agent.daily_limit,
        items_left=max(0, agent.daily_limit - runs.items_today(db, agent)),
        budget_left_usd=budget.left,
        connections=service.run_connections(agent),
    )


Count = Annotated[int, Field(ge=0, le=10_000_000)]
Cost = Annotated[Decimal, Field(ge=0, le=100_000, max_digits=12, decimal_places=4)]


class ProgressIn(Strict):
    done: Count = 0
    failed: Count = 0
    skipped: Count = 0
    cost_usd: Cost = Decimal("0")


class ProgressOut(BaseModel):
    action: Literal["continue", "stop"]
    reason: str | None = None


class FinishIn(ProgressIn):
    status: Literal["succeeded", "failed", "stopped"]
    stop_reason: Annotated[str, StringConstraints(max_length=255)] | None = None
    summary: dict[str, Any] = Field(default_factory=dict)


def _own_running_run(db: Db, agent: Agent, run_id: str) -> Run:
    try:
        run = db.get(Run, uuid.UUID(run_id))
    except ValueError:
        run = None
    if run is None or run.agent_id != agent.id:
        raise ApiError(404, "not_found", "That run doesn't exist.")
    if run.status != RunStatus.RUNNING:
        raise ApiError(409, "not_running", f"That run is {run.status.value}.")
    return run


def _record(run: Run, body: ProgressIn) -> None:
    run.done, run.failed, run.skipped = body.done, body.failed, body.skipped
    run.cost_usd = body.cost_usd
    run.heartbeat_at = now()


@router.post("/runs/{run_id}/progress", response_model=ProgressOut)
def progress(run_id: str, body: ProgressIn, agent: CurrentAgent, db: Db) -> ProgressOut:
    run = _own_running_run(db, agent, run_id)
    _record(run, body)
    db.commit()
    if run.stop_requested_at is not None:
        return ProgressOut(action="stop", reason=runs.stop_message(run))
    if not agent.enabled:
        return ProgressOut(action="stop", reason="The agent was switched off in the Hub.")
    reason = runs.budget(db, agent).stop_reason(runs.cost_per_item(agent))
    if reason:
        return ProgressOut(action="stop", reason=reason)
    return ProgressOut(action="continue")


@router.post("/runs/{run_id}/finish", status_code=status.HTTP_204_NO_CONTENT)
def finish(run_id: str, body: FinishIn, agent: CurrentAgent, db: Db) -> None:
    run = _own_running_run(db, agent, run_id)
    _record(run, body)
    run.status = RunStatus(body.status)
    run.stop_reason = body.stop_reason
    run.summary = body.summary
    run.finished_at = now()
    db.commit()
