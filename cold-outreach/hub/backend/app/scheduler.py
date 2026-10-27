"""Scheduler process (`python -m app.scheduler`), SPEC section 6.3.

Every 30 seconds: queue the scheduled runs that are due, and give up on runs an agent
stopped reporting on or never picked up. Alerts are added in build step 8.
"""

import logging
import signal
import threading
from types import FrameType

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.db.session import get_engine
from app.runs import service

log = logging.getLogger("scheduler")

TICK_SECONDS = 30.0


def tick() -> bool:
    """One pass of the scheduler. Returns whether the database could be reached."""
    try:
        with Session(get_engine()) as db:
            for run in service.queue_due_runs(db):
                log.info("queued the scheduled run %s", run.id)
            for run in service.expire_stale_runs(db):
                log.warning("run %s timed out: %s", run.id, run.stop_reason)
    except SQLAlchemyError:
        log.warning("database unreachable, retrying in %.0fs", TICK_SECONDS)
        return False
    return True


def run(stop: threading.Event) -> None:
    log.info("scheduler started")
    while not stop.is_set():
        tick()
        stop.wait(TICK_SECONDS)
    log.info("scheduler stopped")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    stop = threading.Event()

    def _stop(_signum: int, _frame: FrameType | None) -> None:
        stop.set()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    run(stop)


if __name__ == "__main__":
    main()
