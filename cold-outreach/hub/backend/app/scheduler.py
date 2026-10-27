"""Scheduler process (`python -m app.scheduler`).

Deciding which agent runs are due, marking stale runs and sending alerts arrive in build
steps 5 and 8 (SPEC sections 6.3 and 6.6). For now the scheduler only proves it can reach
the database and stops cleanly on SIGTERM.
"""

import logging
import signal
import threading
from types import FrameType

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.db.session import get_engine

log = logging.getLogger("scheduler")

TICK_SECONDS = 30.0


def tick() -> bool:
    """One pass of the scheduler. Returns whether the database could be reached."""
    try:
        with get_engine().connect() as conn:
            conn.execute(text("SELECT 1"))
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
