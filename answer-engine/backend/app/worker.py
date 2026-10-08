"""Background worker process (`python -m app.worker`, SPEC section 6.12)."""

import logging
import signal
import socket
import threading
import uuid
from datetime import timedelta
from types import FrameType

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.auth.tokens import now
from app.db.session import get_engine
from app.jobs import handlers  # noqa: F401  (registers every job type)
from app.jobs.queue import reclaim_stale, run_next
from app.jobs.schedules import enqueue_due
from app.kb import sync
from app.kb.store import get_store

log = logging.getLogger("worker")

IDLE_SECONDS = 2.0
HOUSEKEEPING_EVERY = timedelta(minutes=1)
SYNC_EVERY = timedelta(seconds=10)


def run(stop: threading.Event) -> None:
    factory: sessionmaker[Session] = sessionmaker(bind=get_engine(), expire_on_commit=False)
    worker_id = f"{socket.gethostname()}:{uuid.uuid4().hex[:6]}"
    next_housekeeping = next_sync = now()
    log.info("worker %s started", worker_id)
    while not stop.is_set():
        try:
            if now() >= next_housekeeping:
                with factory() as db:
                    enqueue_due(db, now())
                reclaim_stale(factory)
                next_housekeeping = now() + HOUSEKEEPING_EVERY
            worked = run_next(factory, worker_id)
            if now() >= next_sync:
                sync.process(factory, get_store())
                next_sync = now() + SYNC_EVERY
        except SQLAlchemyError:
            log.warning("database unreachable, retrying in %.0fs", IDLE_SECONDS, exc_info=True)
            worked = False
        if not worked:
            stop.wait(IDLE_SECONDS)
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
