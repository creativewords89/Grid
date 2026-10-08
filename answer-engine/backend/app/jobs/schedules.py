"""Daily jobs (SPEC section 6.12), in server time (UTC in the containers).

Each run is a job with a dedupe key per day, so it runs once per day however many workers
there are, and a worker started after the time still runs that day's job.
"""

from datetime import datetime, time

from sqlalchemy.orm import Session

from app.jobs.queue import enqueue

DAILY: dict[str, time] = {
    "kb_check": time(3, 0),
    "trash_purge": time(4, 0),
    "session_cleanup": time(5, 0),
}


def enqueue_due(db: Session, at: datetime) -> None:
    for kind, when in DAILY.items():
        slot = at.replace(hour=when.hour, minute=when.minute, second=0, microsecond=0)
        if at >= slot:
            enqueue(db, kind, dedupe_key=f"{kind}:{slot:%Y-%m-%d}")
    db.commit()
