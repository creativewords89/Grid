"""Request dependencies: the signed-in user, CSRF check and the database session."""

import hmac
from typing import Annotated

from fastapi import Depends, Request, Response
from sqlalchemy.orm import Session

from app.auth import sessions
from app.db.models import AuthSession, User
from app.db.session import get_session
from app.errors import ApiError

CSRF_HEADER = "X-CSRF-Token"
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

Db = Annotated[Session, Depends(get_session)]


def client_ip(request: Request) -> str:
    # uvicorn runs with --proxy-headers behind Caddy, so this is the visitor's address.
    return request.client.host if request.client else "unknown"


def current_session(request: Request, response: Response, db: Db) -> AuthSession:
    secret = request.cookies.get(sessions.COOKIE_NAME)
    session = sessions.lookup(db, secret) if secret else None
    if session is None:
        raise ApiError(401, "unauthenticated", "Please sign in.")
    if request.method not in _SAFE_METHODS:
        sent = request.headers.get(CSRF_HEADER, "")
        if not hmac.compare_digest(sent.encode(), session.csrf_token.encode()):
            raise ApiError(403, "csrf", "Your session expired. Please reload the page.")
    if sessions.refresh_if_due(session):
        db.commit()
        sessions.set_cookie(response, secret or "")
    return session


CurrentSession = Annotated[AuthSession, Depends(current_session)]


def current_user(session: CurrentSession) -> User:
    return session.user


CurrentUser = Annotated[User, Depends(current_user)]
