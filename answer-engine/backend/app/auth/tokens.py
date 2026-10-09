"""Random secrets and single-use links (invite, password reset, Telegram link)."""

import hashlib
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.db.models import AuthToken, TokenKind, User

TOKEN_TTL = {
    TokenKind.INVITE: timedelta(hours=72),
    TokenKind.RESET: timedelta(hours=1),
    TokenKind.TELEGRAM_LINK: timedelta(minutes=10),
}


def new_secret() -> str:
    return secrets.token_urlsafe(32)


def hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def now() -> datetime:
    return datetime.now(UTC)


_CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O or 1/I to mix up


def new_code(length: int = 8) -> str:
    """A short code people type (the Telegram link code); it expires in 10 minutes."""
    return "".join(secrets.choice(_CODE_LETTERS) for _ in range(length))


def issue(db: Session, user: User, kind: TokenKind, secret: str | None = None) -> str:
    """Create a single-use token and cancel any earlier unused one of the same kind."""
    db.execute(
        update(AuthToken)
        .where(AuthToken.user_id == user.id, AuthToken.kind == kind, AuthToken.used_at.is_(None))
        .values(used_at=now())
    )
    secret = secret or new_secret()
    db.add(
        AuthToken(
            user_id=user.id,
            kind=kind,
            token_hash=hash_secret(secret),
            expires_at=now() + TOKEN_TTL[kind],
        )
    )
    return secret


def find_valid(db: Session, secret: str, kind: TokenKind) -> AuthToken | None:
    token = db.scalar(
        select(AuthToken)
        .where(AuthToken.token_hash == hash_secret(secret), AuthToken.kind == kind)
        .with_for_update()
    )
    if token is None or token.used_at is not None or token.expires_at <= now():
        return None
    if not token.user.active:
        return None
    return token
