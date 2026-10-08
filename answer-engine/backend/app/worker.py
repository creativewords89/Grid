"""Background worker process (`python -m app.worker`).

The job queue and its handlers arrive in build step 3 (SPEC section 6.12). For now the
worker only proves it can reach the database and stops cleanly on SIGTERM.
"""

import logging
import signal
import threading
from types import FrameType

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.db.session import get_engine

log = logging.getLogger("worker")

POLL_SECONDS = 10.0


def run(stop: threading.Event) -> None:
    log.info("worker started")
    while not stop.is_set():
        try:
            with get_engine().connect() as conn:
                conn.execute(text("SELECT 1"))
        except SQLAlchemyError:
            log.warning("database unreachable, retrying in %.0fs", POLL_SECONDS)
        stop.wait(POLL_SECONDS)
    log.info("worker stopped")


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
