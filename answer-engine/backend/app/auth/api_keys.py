"""API keys for scripts and assistants (SPEC section 4, step 28).

A key acts as the Owner who made it, but only on the routes its scopes allow. Only its
SHA-256 and first 8 characters are stored; the key itself is shown once, when it is made.
"""

import re
import secrets
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import audit
from app.auth.tokens import hash_secret, now
from app.db.models import ApiKey, Role, User
from app.errors import ApiError

PREFIX = "ae_"
EXPIRY_DAYS = (30, 90, 365)
USED_EVERY = timedelta(minutes=1)  # last_used_at is written at most this often

# What each scope may reach. Nothing else is reachable with a key.
SCOPES: dict[str, re.Pattern[str]] = {
    "question_bank": re.compile(r"^/api/qb(/|$)"),
    "verified_import": re.compile(r"^/api/verified/import$"),
}
SCOPE_LABELS = {
    "question_bank": "Question Bank: manage sets, upload questions, read and save threads, "
    "Polish and Fit",
    "verified_import": "Import verified answers from a file",
}


def new_token() -> str:
    return PREFIX + secrets.token_urlsafe(32)


def create(
    db: Session, owner: User, name: str, scopes: list[str], expires_days: int | None
) -> tuple[ApiKey, str]:
    name = name.strip()
    if not name:
        raise ApiError(422, "invalid", "Give the key a name, e.g. “Claude data sync”.")
    chosen = sorted(set(scopes))
    if not chosen or any(s not in SCOPES for s in chosen):
        raise ApiError(422, "invalid", "Choose at least one of the listed scopes.")
    if expires_days is not None and expires_days not in EXPIRY_DAYS:
        raise ApiError(422, "invalid", "Choose an expiry of 30, 90 or 365 days, or never.")
    token = new_token()
    key = ApiKey(
        user_id=owner.id,
        name=name[:100],
        prefix=token[:8],
        token_hash=hash_secret(token),
        scopes=chosen,
        expires_at=now() + timedelta(days=expires_days) if expires_days else None,
    )
    db.add(key)
    db.flush()
    audit.record(db, owner, "create", "api_key", key.id, key.name)
    return key, token


def revoke(db: Session, key: ApiKey, by: User) -> None:
    if key.revoked_at is None:
        key.revoked_at = now()
        audit.record(db, by, "revoke", "api_key", key.id, key.name)


def authenticate(db: Session, token: str, path: str, ip: str) -> User:
    """The Owner a key acts as, if the key is live and its scopes allow this route."""
    key = db.scalar(select(ApiKey).where(ApiKey.token_hash == hash_secret(token)))
    at = now()
    user = key.user if key is not None else None
    if (
        key is None
        or user is None
        or key.revoked_at is not None
        or (key.expires_at is not None and key.expires_at <= at)
        or not user.active
        or user.invited
        or user.role != Role.OWNER
    ):
        raise ApiError(
            401, "unauthenticated", "This API key isn't valid. Make a new one in Settings."
        )
    if not any(SCOPES[s].match(path) for s in key.scopes if s in SCOPES):
        raise ApiError(403, "scope", "This API key isn't allowed to do that.")
    if key.last_used_at is None or at - key.last_used_at >= USED_EVERY:
        key.last_used_at = at
        key.last_used_ip = ip[:45]
        db.commit()
    return user
