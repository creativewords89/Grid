"""Request dependencies: the signed-in user, CSRF check and the database session."""

import hmac
from typing import Annotated

from fastapi import Depends, Request, Response
from sqlalchemy.orm import Session

from app.auth import api_keys, sessions
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


def current_user(request: Request, response: Response, db: Db) -> User:
    """The signed-in person, or the Owner an API key acts as (step 28). A key needs no CSRF
    token: it isn't a cookie, so another site can't make the browser send it."""
    authorization = request.headers.get("Authorization", "")
    if authorization[:7].lower() == "bearer ":
        return api_keys.authenticate(
            db, authorization[7:].strip(), request.url.path, client_ip(request)
        )
    return current_session(request, response, db).user


CurrentUser = Annotated[User, Depends(current_user)]
