"""Sign-in lockout: 5 failed attempts per email+IP lock that pair for 15 min (SPEC section 4)."""

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.tokens import now
from app.db.models import LoginAttempt

MAX_FAILURES = 5
LOCK_FOR = timedelta(minutes=15)


def locked_until(db: Session, email: str, ip: str) -> datetime | None:
    """When the lock ends, or None if not locked.

    Locked when the last 5 attempts all failed within 15 minutes of each other; the lock
    lasts 15 minutes from the fifth failure. A successful sign-in clears the count.
    """
    recent = db.scalars(
        select(LoginAttempt)
        .where(LoginAttempt.email == email, LoginAttempt.ip == ip)
        .order_by(LoginAttempt.at.desc())
        .limit(MAX_FAILURES)
    ).all()
    if len(recent) < MAX_FAILURES or any(attempt.ok for attempt in recent):
        return None
    newest, oldest = recent[0].at, recent[-1].at
    if newest - oldest > LOCK_FOR:
        return None
    until = newest + LOCK_FOR
    return until if until > now() else None


def record(db: Session, email: str, ip: str, ok: bool) -> None:
    db.add(LoginAttempt(email=email, ip=ip, ok=ok, at=now()))
