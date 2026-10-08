"""The job queue in Postgres (SPEC section 6.12).

Jobs are claimed with `SELECT … FOR UPDATE SKIP LOCKED`, so several workers can run at
once. A job gets 3 attempts with backoff; after the last failure it is `failed` and its
type's `on_failure` runs (e.g. to mark the file Failed with a readable reason).
"""

import logging
import traceback
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.auth.tokens import now
from app.db.models import Job, JobState

log = logging.getLogger(__name__)

MAX_ATTEMPTS = 3
BACKOFF = (timedelta(seconds=10), timedelta(minutes=1))  # before attempts 2 and 3
STALE_AFTER = timedelta(minutes=15)  # a running job this old lost its worker

Payload = dict[str, Any]


@dataclass(frozen=True)
class JobType:
    run: Callable[[Session, Payload], None]
    # Called once, in its own transaction, after the final failed attempt.
    on_failure: Callable[[Session, Payload, str], None] | None = None


REGISTRY: dict[str, JobType] = {}


def job(
    kind: str, on_failure: Callable[[Session, Payload, str], None] | None = None
) -> Callable[[Callable[[Session, Payload], None]], Callable[[Session, Payload], None]]:
    """Register a job handler: `@job("ingest_file")`."""

    def register(run: Callable[[Session, Payload], None]) -> Callable[[Session, Payload], None]:
        REGISTRY[kind] = JobType(run, on_failure)
        return run

    return register


class UserFacingError(Exception):
    """A failure whose message can be shown as is (e.g. as a file's error)."""


def enqueue(
    db: Session,
    kind: str,
    payload: Payload | None = None,
    run_after: datetime | None = None,
    dedupe_key: str | None = None,
) -> None:
    """Add a job in the current transaction. With dedupe_key, a second copy is ignored."""
    stmt = insert(Job).values(
        kind=kind,
        payload=payload or {},
        state=JobState.QUEUED,
        run_after=run_after or now(),
        dedupe_key=dedupe_key,
    )
    if dedupe_key is not None:
        stmt = stmt.on_conflict_do_nothing(index_elements=[Job.dedupe_key])
    db.execute(stmt)


def claim(db: Session, worker_id: str) -> Job | None:
    found = db.scalar(
        select(Job)
        .where(Job.state == JobState.QUEUED, Job.run_after <= now())
        .order_by(Job.run_after)
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    if found is None:
        return None
    found.state = JobState.RUNNING
    found.attempts += 1
    found.locked_by = worker_id
    found.locked_at = now()
    db.commit()
    return found


def _settle_failure(db: Session, found: Job, error: str) -> bool:
    """Requeue with backoff, or mark failed. Returns True when this was the last attempt."""
    found.last_error = error[-4000:]
    found.locked_by = None
    found.locked_at = None
    if found.attempts >= MAX_ATTEMPTS:
        found.state = JobState.FAILED
        return True
    found.state = JobState.QUEUED
    found.run_after = now() + BACKOFF[min(found.attempts, len(BACKOFF)) - 1]
    return False


def _final_failure(session_factory: Callable[[], Session], found: Job, message: str) -> None:
    job_type = REGISTRY.get(found.kind)
    if job_type is None or job_type.on_failure is None:
        return
    with session_factory() as db:
        try:
            job_type.on_failure(db, found.payload, message)
            db.commit()
        except Exception:
            log.exception("on_failure for %s job %s failed", found.kind, found.id)


def run_next(session_factory: Callable[[], Session], worker_id: str) -> bool:
    """Run one due job. Returns False when there was nothing to do."""
    with session_factory() as db:
        found = claim(db, worker_id)
        if found is None:
            return False
        job_id, kind, payload = found.id, found.kind, dict(found.payload)

    job_type = REGISTRY.get(kind)
    error: str | None = None
    message = "Something went wrong. Try again, or ask the Owner to check the server."
    with session_factory() as db:
        try:
            if job_type is None:
                raise UserFacingError(f"Unknown job type {kind!r}.")
            job_type.run(db, payload)
            db.commit()
        except Exception as exc:
            db.rollback()
            error = traceback.format_exc()
            if isinstance(exc, UserFacingError):
                message = str(exc)
            log.warning("%s job %s failed: %s", kind, job_id, exc)

    with session_factory() as db:
        found = db.get(Job, job_id, with_for_update=True)
        assert found is not None
        if error is None:
            found.state = JobState.DONE
            found.locked_by = None
            found.locked_at = None
            found.last_error = None
            db.commit()
            return True
        final = _settle_failure(db, found, error)
        db.commit()
    if final:
        _final_failure(session_factory, found, message)
    return True


def reclaim_stale(session_factory: Callable[[], Session]) -> int:
    """Jobs left `running` by a worker that died count as a failed attempt."""
    count = 0
    with session_factory() as db:
        stale = db.scalars(
            select(Job)
            .where(Job.state == JobState.RUNNING, Job.locked_at < now() - STALE_AFTER)
            .with_for_update(skip_locked=True)
        ).all()
        finals = []
        for found in stale:
            if _settle_failure(db, found, "The worker stopped while running this job."):
                finals.append(found)
            count += 1
        db.commit()
    for found in finals:
        _final_failure(session_factory, found, "The server restarted while working on this.")
    return count
