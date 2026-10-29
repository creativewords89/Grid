"""Jobs, agents and a batch's pipeline (SPEC section 6.7).

Each agent does one job. A batch has tasks, each of one job, with what it needs first in
that batch, done by one or more agents of that job. Every business moves on by itself: a
lead is ready for an agent once each task it needs is done for that lead. A task's agents
either all check every lead (`all`) or split the leads between them (`split`).
"""

import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import delete, func, select, true
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.db.models import (
    Agent,
    Batch,
    BatchStatus,
    BatchTask,
    BatchTaskBot,
    Lead,
    LeadBotShare,
    LeadList,
    ShareMode,
    Task,
)
from app.imports.lead_check import held_leads

FINISHED = ("done", "skipped")


def job_name(key: str) -> str:
    """A job's name from its key when the manifest gives none: "gbp-audit" → "Gbp Audit"."""
    return " ".join(part.capitalize() for part in key.split("-"))[:80]


def task_for_key(db: Session, key: str, name: str = "") -> Task:
    """The job with this key, made when it is new; the manifest's name wins when given."""
    task = db.scalar(select(Task).where(Task.key == key))
    if task is None:
        task = Task(key=key, name=name[:80] or job_name(key))
        db.add(task)
        db.flush()
    elif name and task.name != name[:80]:
        task.name = name[:80]
    return task


def set_agent_task(db: Session, agent: Agent, task: Task) -> None:
    """Point the agent at its manifest's task. Batches that had it for another task lose it
    there (its finished work stays)."""
    if agent.task_id == task.id:
        return
    agent.task_id = task.id
    for bot in db.scalars(
        select(BatchTaskBot)
        .join(BatchTask, BatchTask.id == BatchTaskBot.batch_task_id)
        .where(BatchTaskBot.agent_id == agent.id, BatchTask.task_id != task.id)
    ):
        remove_bot(db, db.get_one(BatchTask, bot.batch_task_id), agent)


def remove_bot(db: Session, slot: BatchTask, agent: Agent) -> None:
    """Take a bot off a batch's task. Leads it was given (split) but hasn't finished go to
    the task's other bots."""
    unfinished = [
        lead_id
        for lead_id, results in db.execute(
            select(Lead.lead_id, Lead.results)
            .join(LeadBotShare, LeadBotShare.lead_id == Lead.lead_id)
            .where(LeadBotShare.batch_task_id == slot.id, LeadBotShare.agent_id == agent.id)
        )
        if not _finished((results or {}).get(agent.key), None)
    ]
    if unfinished:
        db.execute(
            delete(LeadBotShare).where(
                LeadBotShare.batch_task_id == slot.id, LeadBotShare.lead_id.in_(unfinished)
            )
        )
    db.execute(
        delete(BatchTaskBot).where(
            BatchTaskBot.batch_task_id == slot.id, BatchTaskBot.agent_id == agent.id
        )
    )
    db.expire(slot, ["bots"])


def creates_circle(slots: list[BatchTask], key: str, needs: Iterable[str]) -> bool:
    """Whether giving the batch's task of job `key` these needs makes it wait for itself."""
    graph = {slot.task.key: list(slot.needs or []) for slot in slots}
    graph[key] = list(needs)
    seen: set[str] = set()
    todo = list(needs)
    while todo:
        current = todo.pop()
        if current == key:
            return True
        if current in seen:
            continue
        seen.add(current)
        todo.extend(graph.get(current, []))
    return False


def steps(slots: list[BatchTask]) -> dict[str, int]:
    """Each task's step in a batch (by job key): 1 for tasks needing only the lead file,
    then one more than the latest step among the tasks it needs."""
    needs_of = {slot.task.key: list(slot.needs or []) for slot in slots}
    out: dict[str, int] = {}

    def step(key: str, path: frozenset[str]) -> int:
        if key in out:
            return out[key]
        needs = [n for n in needs_of[key] if n in needs_of and n not in path]
        value = 1 + max((step(n, path | {key}) for n in needs), default=0)
        out[key] = value
        return value

    for key in needs_of:
        step(key, frozenset())
    return out


def slots_of(db: Session, batch: Batch) -> list[BatchTask]:
    return list(
        db.scalars(
            select(BatchTask).where(BatchTask.batch_id == batch.id).order_by(BatchTask.created_at)
        )
    )


def _finished(result: dict[str, Any] | None, batch: Batch | None) -> bool:
    """A result that counts as finished: done or skipped, made against the batch's current
    benchmark when it says which one it used."""
    if not result or result.get("outcome", "done") not in FINISHED:
        return False
    if batch is None or result.get("benchmark_version") is None:
        return True
    benchmark = batch.benchmark
    if benchmark is None:
        return True
    same_id = result.get("benchmark_id") in (None, str(benchmark.id))
    return same_id and result.get("benchmark_version") == benchmark.version


@dataclass
class BotCount:
    done: int = 0
    failed: int = 0
    ready: int = 0
    waiting: int = 0
    scores: list[float] = field(default_factory=list)

    @property
    def average(self) -> float | None:
        return round(sum(self.scores) / len(self.scores), 1) if self.scores else None


class Pipeline:
    """A batch's tasks and bots, with what is done for each lead."""

    def __init__(self, db: Session, batch: Batch) -> None:
        self.db = db
        self.batch = batch
        self.slots = slots_of(db, batch)
        self.by_key = {slot.task.key: slot for slot in self.slots}
        ids = [slot.id for slot in self.slots]
        self.shares: dict[tuple[uuid.UUID, str], uuid.UUID] = {
            (row.batch_task_id, row.lead_id): row.agent_id
            for row in db.scalars(select(LeadBotShare).where(LeadBotShare.batch_task_id.in_(ids)))
        }
        self.keys: dict[uuid.UUID, str] = {
            bot.agent_id: bot.agent.key for slot in self.slots for bot in slot.bots
        }
        for agent_id in set(self.shares.values()) - set(self.keys):
            agent = db.get(Agent, agent_id)
            if agent is not None:
                self.keys[agent_id] = agent.key

    def leads(self) -> list[Lead]:
        """The batch's leads agents may work on: not Top, in a city switched on, in a ready
        city (one with a Top chosen, SPEC step 20), and not from a file Lead Check holds
        back (a lead of it has an error, step 26)."""
        held = held_leads(self.db, self.batch.id)
        off = select(func.lower(LeadList.city)).where(
            LeadList.batch_id == self.batch.id, LeadList.active.is_(False)
        )
        ready = select(func.lower(Lead.city)).where(
            Lead.batch_id == self.batch.id, Lead.level == "Top"
        )
        return list(
            self.db.scalars(
                select(Lead)
                .where(
                    Lead.batch_id == self.batch.id,
                    Lead.level != "Top",
                    func.lower(Lead.city).not_in(off),
                    func.lower(Lead.city).in_(ready),
                    Lead.lead_id.not_in(held) if held else true(),
                )
                .order_by(Lead.lead_id)
            )
        )

    def finished_by(self, lead: Lead, agent_key: str) -> bool:
        return _finished((lead.results or {}).get(agent_key), self.batch)

    def task_done(self, lead: Lead, slot: BatchTask) -> bool:
        if slot.share == ShareMode.SPLIT:
            owner = self.shares.get((slot.id, lead.lead_id))
            return owner is not None and self.finished_by(lead, self.keys.get(owner, ""))
        return bool(slot.bots) and all(self.finished_by(lead, b.agent.key) for b in slot.bots)

    def needs_done(self, lead: Lead, slot: BatchTask) -> bool:
        return all(
            self.task_done(lead, self.by_key[key]) for key in slot.needs or [] if key in self.by_key
        )

    def slot_of(self, agent: Agent) -> BatchTask | None:
        for slot in self.slots:
            if any(bot.agent_id == agent.id for bot in slot.bots):
                return slot
        return None

    def _owner(self, slot: BatchTask, lead: Lead) -> uuid.UUID | None:
        """The bot a split lead went to, unless it left the task without finishing it."""
        owner = self.shares.get((slot.id, lead.lead_id))
        if owner is None:
            return None
        if any(b.agent_id == owner for b in slot.bots):
            return owner
        return owner if self.finished_by(lead, self.keys.get(owner, "")) else None

    def ready_for(self, agent: Agent) -> list[Lead]:
        """The leads this bot should work on now. Split leads are shared out in turn the
        first time any of the task's bots asks (and saved)."""
        slot = self.slot_of(agent)
        if slot is None or self.batch.status != BatchStatus.RUNNING:
            return []
        counts = {bot.agent_id: 0 for bot in slot.bots}
        for (slot_id, _), holder in self.shares.items():
            if slot_id == slot.id and holder in counts:
                counts[holder] += 1
        candidates = [
            lead
            for lead in self.leads()
            if not self.finished_by(lead, agent.key) and self.needs_done(lead, slot)
        ]
        if slot.share != ShareMode.SPLIT:
            return candidates
        fresh: list[dict[str, Any]] = []
        for lead in candidates:
            if self._owner(slot, lead) is None:
                owner = min(slot.bots, key=lambda b: (counts[b.agent_id], b.position)).agent_id
                counts[owner] += 1
                fresh.append({"batch_task_id": slot.id, "lead_id": lead.lead_id, "agent_id": owner})
        if fresh:
            # Two bots asking at once must not both get a lead: the first share saved wins,
            # unless it went to a bot that has left the task.
            statement = insert(LeadBotShare).values(fresh)
            self.db.execute(
                statement.on_conflict_do_update(
                    index_elements=["batch_task_id", "lead_id"],
                    set_={"agent_id": statement.excluded.agent_id},
                    where=LeadBotShare.agent_id.not_in([b.agent_id for b in slot.bots]),
                )
            )
            self.db.flush()
            for lead_id, owner in self.db.execute(  # columns: the saved rows may have changed
                select(LeadBotShare.lead_id, LeadBotShare.agent_id).where(
                    LeadBotShare.batch_task_id == slot.id,
                    LeadBotShare.lead_id.in_([f["lead_id"] for f in fresh]),
                )
            ):
                self.shares[(slot.id, lead_id)] = owner
        return [lead for lead in candidates if self.shares.get((slot.id, lead.lead_id)) == agent.id]

    def progress(self) -> dict[tuple[uuid.UUID, uuid.UUID], BotCount]:
        """For each (task in the batch, bot): leads finished, failed, ready and waiting for
        the tasks before it, and the scores of its finished leads. Split leads not shared out
        yet are counted as ready, divided in turn between the bots."""
        counts = {(slot.id, bot.agent_id): BotCount() for slot in self.slots for bot in slot.bots}
        unshared = {slot.id: 0 for slot in self.slots}
        for lead in self.leads():
            for slot in self.slots:
                ready = self.needs_done(lead, slot)
                owner = self._owner(slot, lead) if slot.share == ShareMode.SPLIT else None
                if slot.share == ShareMode.SPLIT and owner is None and slot.bots:
                    if ready:
                        unshared[slot.id] += 1
                    else:
                        for bot in slot.bots:
                            counts[(slot.id, bot.agent_id)].waiting += 1
                    continue
                for bot in slot.bots:
                    if owner is not None and owner != bot.agent_id:
                        continue
                    count = counts[(slot.id, bot.agent_id)]
                    result = (lead.results or {}).get(bot.agent.key)
                    if self.finished_by(lead, bot.agent.key):
                        count.done += 1
                        if result and isinstance(result.get("score"), int | float):
                            count.scores.append(float(result["score"]))
                    elif not ready:
                        count.waiting += 1
                    elif result and result.get("outcome") == "failed":
                        count.failed += 1
                    else:
                        count.ready += 1
        for slot in self.slots:
            if slot.bots and unshared[slot.id]:
                share, extra = divmod(unshared[slot.id], len(slot.bots))
                for i, bot in enumerate(slot.bots):
                    counts[(slot.id, bot.agent_id)].ready += share + (1 if i < extra else 0)
        return counts


def running_batches_for(db: Session, agent: Agent) -> list[Batch]:
    """The running batches that chose this bot, in the running order."""
    return list(
        db.scalars(
            select(Batch)
            .join(BatchTask, BatchTask.batch_id == Batch.id)
            .join(BatchTaskBot, BatchTaskBot.batch_task_id == BatchTask.id)
            .where(BatchTaskBot.agent_id == agent.id, Batch.status == BatchStatus.RUNNING)
            .order_by(Batch.position, Batch.created_at)
        )
    )


def tasks_using(db: Session, agent: Agent) -> list[tuple[Batch, str]]:
    """Every batch that chose this agent and the name of its task there, running order."""
    rows = db.execute(
        select(Batch, BatchTask.name, Task.name)
        .join(BatchTask, BatchTask.batch_id == Batch.id)
        .join(Task, Task.id == BatchTask.task_id)
        .join(BatchTaskBot, BatchTaskBot.batch_task_id == BatchTask.id)
        .where(BatchTaskBot.agent_id == agent.id)
        .order_by(Batch.position, Batch.created_at)
    )
    return [(batch, name or job) for batch, name, job in rows]
