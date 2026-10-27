"""Rate limits (SPEC section 4), counted from rows the app writes anyway (sign-in attempts),
so they hold across restarts and however many API processes run."""

from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.tokens import now
from app.db.models import LoginAttempt
from app.errors import ApiError

LOGINS_PER_MINUTE = 10  # per IP address
MINUTE = timedelta(minutes=1)


def check_login(db: Session, ip: str) -> None:
    tries = db.scalar(
        select(func.count())
        .select_from(LoginAttempt)
        .where(LoginAttempt.ip == ip, LoginAttempt.at > now() - MINUTE)
    )
    if (tries or 0) >= LOGINS_PER_MINUTE:
        raise ApiError(429, "rate_limited", "Too many sign-in attempts. Wait a minute.")
