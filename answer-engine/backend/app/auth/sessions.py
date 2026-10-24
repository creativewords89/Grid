"""Signed-in sessions: a random token in an HttpOnly cookie, stored hashed (SPEC section 4)."""

import uuid
from datetime import timedelta

from fastapi import Response
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.auth.tokens import hash_secret, new_secret, now
from app.db.models import AuthSession, User

COOKIE_NAME = "ae_session"
SESSION_TTL = timedelta(days=30)
# Sliding expiry: extend at most once a day, so not every request writes to the database.
REFRESH_AFTER = timedelta(days=1)


def create(
    db: Session, user: User, ip: str | None, user_agent: str | None
) -> tuple[str, AuthSession]:
    secret = new_secret()
    session = AuthSession(
        user_id=user.id,
        token_hash=hash_secret(secret),
        csrf_token=new_secret(),
        expires_at=now() + SESSION_TTL,
        ip=ip,
        user_agent=(user_agent or "")[:512] or None,
    )
    db.add(session)
    return secret, session


def lookup(db: Session, secret: str) -> AuthSession | None:
    session = db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_secret(secret)))
    if session is None or session.expires_at <= now():
        return None
    user = session.user
    if not user.active or user.invited:
        return None
    return session


def refresh_if_due(session: AuthSession) -> bool:
    """Push the expiry 30 days ahead when it was last set over a day ago."""
    if session.expires_at - now() < SESSION_TTL - REFRESH_AFTER:
        session.expires_at = now() + SESSION_TTL
        return True
    return False


def revoke_all(db: Session, user_id: uuid.UUID, keep: uuid.UUID | None = None) -> None:
    stmt = delete(AuthSession).where(AuthSession.user_id == user_id)
    if keep is not None:
        stmt = stmt.where(AuthSession.id != keep)
    db.execute(stmt)


def set_cookie(response: Response, secret: str) -> None:
    response.set_cookie(
        COOKIE_NAME,
        secret,
        max_age=int(SESSION_TTL.total_seconds()),
        path="/",
        secure=True,
        httponly=True,
        samesite="lax",
    )


def clear_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/", secure=True, httponly=True, samesite="lax")
