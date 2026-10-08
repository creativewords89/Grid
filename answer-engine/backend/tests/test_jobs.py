"""The job queue, retries, stale jobs and daily schedules (SPEC section 6.12)."""

import threading
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import Engine, func, select, update
from sqlalchemy.orm import Session

from app.auth.tokens import now
from app.db.models import (
    AuthSession,
    AuthToken,
    Job,
    JobState,
    LoginAttempt,
    StoredFile,
    TokenKind,
    TrashItem,
    TrashKind,
)
from app.jobs import queue
from app.jobs.queue import REGISTRY, JobType, UserFacingError, enqueue, reclaim_stale, run_next
from app.jobs.schedules import enqueue_due
from tests.conftest import RunJobs, UserFactory

Calls = list[tuple[str, Any]]


@pytest.fixture
def calls() -> Iterator[Calls]:
    """Test job types: `ok`, `boom` (unexpected error) and `nope` (readable error)."""
    seen: Calls = []

    def ok(_db: Session, payload: dict[str, Any]) -> None:
        seen.append(("run", payload))

    def boom(_db: Session, payload: dict[str, Any]) -> None:
        seen.append(("run", payload))
        raise RuntimeError("kaboom")

    def nope(_db: Session, payload: dict[str, Any]) -> None:
        seen.append(("run", payload))
        raise UserFacingError("The file is broken.")

    def failed(_db: Session, payload: dict[str, Any], message: str) -> None:
        seen.append(("on_failure", message))

    REGISTRY.update(
        {
            "t_ok": JobType(ok, failed),
            "t_boom": JobType(boom, failed),
            "t_nope": JobType(nope, failed),
        }
    )
    yield seen
    for kind in ("t_ok", "t_boom", "t_nope"):
        REGISTRY.pop(kind)


def jobs(db: Session) -> list[Job]:
    return list(db.scalars(select(Job).execution_options(populate_existing=True)).all())


def make_due(db: Session) -> None:
    db.execute(update(Job).values(run_after=now() - timedelta(seconds=1)))
    db.commit()


def test_a_job_runs_once_and_is_done(db: Session, run_jobs: RunJobs, calls: Calls) -> None:
    enqueue(db, "t_ok", {"n": 1})
    db.commit()

    assert run_jobs() == 1

    assert calls == [("run", {"n": 1})]
    [job] = jobs(db)
    assert (job.state, job.attempts, job.last_error) == (JobState.DONE, 1, None)
    assert run_jobs() == 0


def test_a_failing_job_is_retried_with_backoff_then_failed(
    db: Session, run_jobs: RunJobs, calls: Calls
) -> None:
    enqueue(db, "t_boom")
    db.commit()

    run_jobs()
    [job] = jobs(db)
    assert (job.state, job.attempts) == (JobState.QUEUED, 1)
    assert timedelta(seconds=8) < job.run_after - now() <= timedelta(seconds=10)
    assert "kaboom" in (job.last_error or "")
    assert run_jobs() == 0  # not due yet

    make_due(db)
    run_jobs()
    [job] = jobs(db)
    assert job.attempts == 2
    assert timedelta(seconds=58) < job.run_after - now() <= timedelta(minutes=1)

    make_due(db)
    run_jobs()
    [job] = jobs(db)
    assert (job.state, job.attempts) == (JobState.FAILED, 3)
    assert calls.count(("run", {})) == 3
    assert calls[-1] == (
        "on_failure",
        "Something went wrong. Try again, or ask the Owner to check the server.",
    )


def test_a_readable_error_reaches_on_failure(db: Session, run_jobs: RunJobs, calls: Calls) -> None:
    enqueue(db, "t_nope")
    db.commit()
    for _ in range(3):
        make_due(db)
        run_jobs()

    assert calls[-1] == ("on_failure", "The file is broken.")
    assert [c for c in calls if c[0] == "on_failure"] == [("on_failure", "The file is broken.")]


def test_an_unknown_job_type_fails(db: Session, run_jobs: RunJobs) -> None:
    enqueue(db, "no_such_job")
    db.commit()
    for _ in range(3):
        make_due(db)
        run_jobs()

    [job] = jobs(db)
    assert job.state == JobState.FAILED
    assert "Unknown job type" in (job.last_error or "")


def test_a_dedupe_key_keeps_one_copy(db: Session) -> None:
    for _ in range(3):
        enqueue(db, "t_ok", dedupe_key="daily:2026-10-08")
    db.commit()

    assert len(jobs(db)) == 1


def test_two_workers_never_claim_the_same_job(clean_engine: Engine, calls: Calls) -> None:
    with Session(clean_engine) as db:
        for n in range(20):
            enqueue(db, "t_ok", {"n": n})
        db.commit()

    def worker(name: str) -> None:
        while run_next(lambda: Session(clean_engine, expire_on_commit=False), name):
            pass

    threads = [threading.Thread(target=worker, args=(f"w{i}",)) for i in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert sorted(payload["n"] for _, payload in calls) == list(range(20))


def test_a_job_left_running_by_a_dead_worker_is_retried(
    db: Session, clean_engine: Engine, calls: Calls
) -> None:
    enqueue(db, "t_ok")
    db.commit()
    db.execute(
        update(Job).values(
            state=JobState.RUNNING, attempts=1, locked_at=now() - timedelta(minutes=16)
        )
    )
    db.commit()

    assert reclaim_stale(lambda: Session(clean_engine, expire_on_commit=False)) == 1

    [job] = jobs(db)
    assert (job.state, job.attempts) == (JobState.QUEUED, 1)


def test_a_recently_started_job_is_left_alone(db: Session, clean_engine: Engine) -> None:
    enqueue(db, "t_ok")
    db.commit()
    db.execute(update(Job).values(state=JobState.RUNNING, attempts=1, locked_at=now()))
    db.commit()

    assert reclaim_stale(lambda: Session(clean_engine, expire_on_commit=False)) == 0


def test_a_stale_job_on_its_last_attempt_fails(
    db: Session, clean_engine: Engine, calls: Calls
) -> None:
    enqueue(db, "t_ok")
    db.commit()
    db.execute(
        update(Job).values(
            state=JobState.RUNNING,
            attempts=queue.MAX_ATTEMPTS,
            locked_at=now() - timedelta(hours=1),
        )
    )
    db.commit()

    reclaim_stale(lambda: Session(clean_engine, expire_on_commit=False))

    assert jobs(db)[0].state == JobState.FAILED
    assert calls == [("on_failure", "The server restarted while working on this.")]


# --- daily schedules ----------------------------------------------------------------------


def test_daily_jobs_are_queued_once_per_day_after_their_time(db: Session) -> None:
    def kinds() -> list[str]:
        return sorted(job.dedupe_key or "" for job in jobs(db))

    enqueue_due(db, datetime(2026, 10, 8, 2, 59, tzinfo=UTC))
    assert kinds() == []

    enqueue_due(db, datetime(2026, 10, 8, 3, 0, tzinfo=UTC))
    enqueue_due(db, datetime(2026, 10, 8, 4, 0, tzinfo=UTC))
    enqueue_due(db, datetime(2026, 10, 8, 4, 30, tzinfo=UTC))
    assert kinds() == ["kb_check:2026-10-08", "trash_purge:2026-10-08"]

    enqueue_due(db, datetime(2026, 10, 8, 23, 0, tzinfo=UTC))
    enqueue_due(db, datetime(2026, 10, 9, 5, 0, tzinfo=UTC))
    assert kinds() == [
        "kb_check:2026-10-08",
        "kb_check:2026-10-09",
        "session_cleanup:2026-10-08",
        "session_cleanup:2026-10-09",
        "trash_purge:2026-10-08",
        "trash_purge:2026-10-09",
    ]


def test_trash_purge_deletes_files_older_than_30_days(
    db: Session, run_jobs: RunJobs, make_user: UserFactory, upload_dir: Path
) -> None:
    owner = make_user()
    (upload_dir / "old").parent.mkdir(parents=True, exist_ok=True)
    for name, age in (("old", 31), ("new", 29)):
        (upload_dir / name).write_bytes(b"x")
        record = StoredFile(
            name=name,
            mime="application/pdf",
            size=1,
            sha256=name * 4,
            storage_path=name,
            uploaded_by=owner.id,
            deleted_at=now() - timedelta(days=age),
        )
        db.add(record)
        db.flush()
        db.add(
            TrashItem(
                kind=TrashKind.FILE, ref_id=record.id, title=name, deleted_at=record.deleted_at
            )
        )
    db.commit()

    enqueue(db, "trash_purge")
    db.commit()
    run_jobs()

    assert db.scalars(select(StoredFile.name)).all() == ["new"]
    assert db.scalars(select(TrashItem.title)).all() == ["new"]
    assert not (upload_dir / "old").exists()
    assert (upload_dir / "new").exists()


def test_session_cleanup_removes_only_what_is_old(
    db: Session, run_jobs: RunJobs, make_user: UserFactory
) -> None:
    user = make_user()
    current = now()
    db.add_all(
        [
            AuthSession(
                user_id=user.id,
                token_hash="a" * 64,
                csrf_token="x",
                expires_at=current - timedelta(seconds=1),
            ),
            AuthSession(
                user_id=user.id,
                token_hash="b" * 64,
                csrf_token="x",
                expires_at=current + timedelta(days=1),
            ),
            AuthToken(
                user_id=user.id,
                kind=TokenKind.RESET,
                token_hash="c" * 64,
                expires_at=current + timedelta(hours=1),
                used_at=current,
            ),
            AuthToken(
                user_id=user.id,
                kind=TokenKind.RESET,
                token_hash="d" * 64,
                expires_at=current + timedelta(hours=1),
            ),
            LoginAttempt(email="x", ip="1", ok=False, at=current - timedelta(days=31)),
            LoginAttempt(email="x", ip="1", ok=False, at=current),
        ]
    )
    db.commit()
    enqueue(db, "session_cleanup")
    db.commit()

    run_jobs()

    assert db.scalars(select(AuthSession.token_hash)).all() == ["b" * 64]
    assert db.scalars(select(AuthToken.token_hash)).all() == ["d" * 64]
    assert db.scalar(select(func.count()).select_from(LoginAttempt)) == 1
