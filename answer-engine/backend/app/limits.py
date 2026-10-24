"""Rate limits and the daily question limit (SPEC sections 9.5 and 11).

Counted from rows the app writes anyway (sign-in attempts, questions), so the limits hold
across restarts and however many API processes run.
"""

from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import settings_store
from app.auth.tokens import now
from app.db.models import (
    Answer,
    AnswerKind,
    Conversation,
    LoginAttempt,
    Message,
    MessageRole,
    User,
)
from app.errors import ApiError

LOGINS_PER_MINUTE = 10  # per IP address
QUESTIONS_PER_MINUTE = 20  # per person
MINUTE = timedelta(minutes=1)


def check_login(db: Session, ip: str) -> None:
    tries = db.scalar(
        select(func.count())
        .select_from(LoginAttempt)
        .where(LoginAttempt.ip == ip, LoginAttempt.at > now() - MINUTE)
    )
    if (tries or 0) >= LOGINS_PER_MINUTE:
        raise ApiError(429, "rate_limited", "Too many sign-in attempts. Wait a minute.")


def questions_today(db: Session, user: User) -> int:
    midnight = now().replace(hour=0, minute=0, second=0, microsecond=0)
    return (
        db.scalar(
            select(func.count())
            .select_from(Answer)
            .where(
                Answer.asked_by == user.id,
                Answer.kind == AnswerKind.CHAT,
                Answer.created_at >= midnight,
            )
        )
        or 0
    )


def check_question(db: Session, user: User) -> None:
    """Before a question is answered: 20 a minute, and the daily limit (default 200)."""
    recent = db.scalar(
        select(func.count())
        .select_from(Message)
        .join(Conversation, Conversation.id == Message.conversation_id)
        .where(
            Conversation.user_id == user.id,
            Message.role == MessageRole.USER,
            Message.created_at > now() - MINUTE,
        )
    )
    if (recent or 0) >= QUESTIONS_PER_MINUTE:
        raise ApiError(429, "rate_limited", "That's a lot of questions at once. Wait a minute.")
    limit = settings_store.get_int(db, "questions_per_user_per_day")
    if questions_today(db, user) >= limit:
        raise ApiError(
            429,
            "daily_limit",
            f"You've asked {limit} question{'' if limit == 1 else 's'} today, the daily limit. "
            "It resets at midnight (UTC). The Owner can raise it in Settings.",
        )
