"""`/api/auth/*`: sign in, sign out, invites and password resets (SPEC section 4)."""

from fastapi import APIRouter, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import (
    EmailIn,
    LoginIn,
    MeOut,
    MessageOut,
    SetPasswordIn,
    TokenCheckIn,
    TokenInfoOut,
    UserOut,
)
from app.auth import lockout, passwords, sessions, tokens
from app.auth.deps import CurrentSession, Db, client_ip
from app.config import get_settings
from app.db.models import AuthSession, TokenKind, User
from app.errors import ApiError
from app.mail import MailerDep, invite_email, reset_email

router = APIRouter(prefix="/auth", tags=["auth"])

BAD_LOGIN = "Email or password is incorrect."
BAD_LINK = "This link has expired or was already used. Ask for a new one."
FORGOT_REPLY = "If that email exists, we've sent a link."


def me_out(session: AuthSession) -> MeOut:
    return MeOut(user=UserOut.of(session.user), csrf_token=session.csrf_token)


def _start_session(db: Session, user: User, request: Request, response: Response) -> MeOut:
    secret, session = sessions.create(
        db, user, client_ip(request), request.headers.get("user-agent")
    )
    user.last_login_at = tokens.now()
    db.commit()
    sessions.set_cookie(response, secret)
    return me_out(session)


def _check_password(password: str, email: str) -> None:
    problem = passwords.password_problem(password, email)
    if problem:
        raise ApiError(422, "invalid", problem, {"password": problem})


@router.post("/login", response_model=MeOut)
def login(body: LoginIn, request: Request, response: Response, db: Db) -> MeOut:
    ip = client_ip(request)
    if lockout.locked_until(db, body.email, ip) is not None:
        raise ApiError(429, "locked", "Too many attempts. Wait 15 minutes, then try again.")
    user = db.scalar(select(User).where(User.email == body.email))
    ok = passwords.verify_password(user.password_hash if user else None, body.password)
    ok = ok and user is not None and user.active
    lockout.record(db, body.email, ip, ok)
    if not ok or user is None:
        db.commit()
        raise ApiError(401, "bad_credentials", BAD_LOGIN)
    if user.password_hash and passwords.needs_rehash(user.password_hash):
        user.password_hash = passwords.hash_password(body.password)
    return _start_session(db, user, request, response)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(session: CurrentSession, response: Response, db: Db) -> None:
    db.delete(session)
    db.commit()
    sessions.clear_cookie(response)


@router.get("/me", response_model=MeOut)
def me(session: CurrentSession) -> MeOut:
    return me_out(session)


@router.post("/forgot", response_model=MessageOut)
def forgot(body: EmailIn, db: Db, mailer: MailerDep) -> MessageOut:
    user = db.scalar(select(User).where(User.email == body.email, User.active.is_(True)))
    if user is not None:
        settings = get_settings()
        if user.invited:
            # Never set a password: send a fresh invite rather than a reset link.
            secret = tokens.issue(db, user, TokenKind.INVITE)
            subject, text = invite_email(user.name, "Your team", settings.link(f"/invite#{secret}"))
        else:
            secret = tokens.issue(db, user, TokenKind.RESET)
            subject, text = reset_email(user.name, settings.link(f"/reset#{secret}"))
        db.commit()
        mailer.send(user.email, subject, text)
    return MessageOut(message=FORGOT_REPLY)


@router.post("/check-token", response_model=TokenInfoOut)
def check_token(body: TokenCheckIn, db: Db) -> TokenInfoOut:
    token = tokens.find_valid(db, body.token, TokenKind(body.kind))
    db.rollback()  # release the row lock taken by find_valid
    if token is None:
        raise ApiError(400, "invalid_token", BAD_LINK)
    return TokenInfoOut(name=token.user.name, email=token.user.email)


@router.post("/accept-invite", response_model=MeOut)
def accept_invite(body: SetPasswordIn, request: Request, response: Response, db: Db) -> MeOut:
    token = tokens.find_valid(db, body.token, TokenKind.INVITE)
    if token is None:
        raise ApiError(400, "invalid_token", BAD_LINK)
    user = token.user
    _check_password(body.password, user.email)
    token.used_at = tokens.now()
    user.password_hash = passwords.hash_password(body.password)
    return _start_session(db, user, request, response)


@router.post("/reset", response_model=MessageOut)
def reset(body: SetPasswordIn, db: Db) -> MessageOut:
    token = tokens.find_valid(db, body.token, TokenKind.RESET)
    if token is None:
        raise ApiError(400, "invalid_token", BAD_LINK)
    user = token.user
    _check_password(body.password, user.email)
    token.used_at = tokens.now()
    user.password_hash = passwords.hash_password(body.password)
    sessions.revoke_all(db, user.id)
    db.commit()
    return MessageOut(message="Your password has been changed. Please sign in.")
