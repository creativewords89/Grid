"""Scheduler process (`python -m app.scheduler`), SPEC section 6.3.

Every 30 seconds: queue the scheduled runs that are due, give up on runs an agent stopped
reporting on or never picked up, run the once-a-day jobs (DataForSEO balance, the backup,
the daily summary) and send the alerts waiting (SPEC sections 6.3 and 6.6). Next to it, the
file checker checks the files handed in on Files every couple of seconds (step 33).
"""

import logging
import signal
import threading
from types import FrameType

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app import logs
from app.alerts import service as alerts
from app.config import get_settings
from app.db.session import get_engine
from app.imports import file_checker
from app.runs import service

log = logging.getLogger("scheduler")

TICK_SECONDS = 30.0
FILES_SECONDS = 2.0


def tick() -> bool:
    """One pass of the scheduler. Returns whether the database could be reached."""
    try:
        with Session(get_engine()) as db:
            for run in service.queue_due_runs(db):
                log.info("queued the scheduled run %s", run.id)
            for run in service.expire_stale_runs(db):
                log.warning("run %s timed out: %s", run.id, run.stop_reason)
            file_checker.send_due(db)  # files whose Final check is over (step 36)
            alerts.check_balance(db)
            alerts.check_backup(db)
            alerts.daily_summary(db)
            db.commit()
            alerts.deliver_pending(db)
    except SQLAlchemyError:
        log.warning("database unreachable, retrying in %.0fs", TICK_SECONDS)
        return False
    return True


def check_files(stop: threading.Event) -> None:
    """The file checker's loop (step 33)."""
    while not stop.is_set():
        try:
            file_checker.run_pending(get_engine())
        except SQLAlchemyError:
            log.warning("database unreachable for the file checker")
        stop.wait(FILES_SECONDS)


def run(stop: threading.Event) -> None:
    log.info("scheduler started")
    threading.Thread(target=check_files, args=(stop,), name="file-checker", daemon=True).start()
    while not stop.is_set():
        tick()
        stop.wait(TICK_SECONDS)
    log.info("scheduler stopped")


def main() -> None:
    logs.setup(json_logs=get_settings().json_logs)
    stop = threading.Event()

    def _stop(_signum: int, _frame: FrameType | None) -> None:
        stop.set()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    run(stop)


if __name__ == "__main__":
    main()
