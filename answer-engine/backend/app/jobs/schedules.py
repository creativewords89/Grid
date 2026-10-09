"""Daily jobs (SPEC section 6.12), in server time (UTC in the containers).

Each run is a job with a dedupe key per day, so it runs once per day however many workers
there are, and a worker started after the time still runs that day's job.
"""

from datetime import datetime, time, timedelta

from sqlalchemy.orm import Session

from app.jobs.queue import enqueue

DAILY: dict[str, time] = {
    "verified_expiry": time(2, 0),
    "kb_check": time(3, 0),
    "trash_purge": time(4, 0),
    "session_cleanup": time(5, 0),
}


# Jobs that run every few minutes: one per time slot, whichever worker gets there first.
EVERY: dict[str, timedelta] = {
    "review_reminders": timedelta(minutes=5),
}


def enqueue_due(db: Session, at: datetime) -> None:
    for kind, interval in EVERY.items():
        seconds = int(interval.total_seconds())
        start = at.replace(microsecond=0)
        slot = start - timedelta(seconds=int(start.timestamp()) % seconds)
        enqueue(db, kind, dedupe_key=f"{kind}:{slot:%Y-%m-%dT%H:%M}")
    for kind, when in DAILY.items():
        slot = at.replace(hour=when.hour, minute=when.minute, second=0, microsecond=0)
        if at >= slot:
            enqueue(db, kind, dedupe_key=f"{kind}:{slot:%Y-%m-%d}")
    db.commit()
