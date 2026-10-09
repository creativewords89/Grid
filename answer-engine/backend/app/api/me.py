"""`/api/me`: a person's own profile and password (SPEC section 7.9)."""

from datetime import datetime

from fastapi import APIRouter
from pydantic import BaseModel

from app import settings_store
from app.api.schemas import ChangePasswordIn, MessageOut, ProfilePatchIn, UserOut
from app.auth import passwords, sessions, tokens
from app.auth.deps import CurrentSession, Db
from app.db.models import TokenKind
from app.errors import ApiError
from app.permissions import Action, ensure
from app.reviews.telegram import get_telegram

router = APIRouter(prefix="/me", tags=["me"])


@router.patch("", response_model=UserOut)
def update_profile(body: ProfilePatchIn, session: CurrentSession, db: Db) -> UserOut:
    user = session.user
    ensure(user, Action.EDIT_OWN_PROFILE)
    user.name = body.name
    db.commit()
    db.refresh(user)
    return UserOut.of(user)


@router.post("/password", response_model=MessageOut)
def change_password(body: ChangePasswordIn, session: CurrentSession, db: Db) -> MessageOut:
    user = session.user
    ensure(user, Action.EDIT_OWN_PROFILE)
    if not passwords.verify_password(user.password_hash, body.current_password):
        message = "Your current password is incorrect."
        raise ApiError(422, "invalid", message, {"current_password": message})
    problem = passwords.password_problem(body.new_password, user.email)
    if problem:
        raise ApiError(422, "invalid", problem, {"new_password": problem})
    user.password_hash = passwords.hash_password(body.new_password)
    # Sign out every other device; this one stays signed in.
    sessions.revoke_all(db, user.id, keep=session.id)
    db.commit()
    return MessageOut(message="Your password has been changed.")


class TelegramCodeOut(BaseModel):
    code: str
    expires_at: datetime
    bot_username: str


@router.post("/telegram-link", response_model=TelegramCodeOut)
def telegram_code(session: CurrentSession, db: Db) -> TelegramCodeOut:
    """A one-time code (10 minutes) to send to the bot as `/link CODE` (SPEC 6.7)."""
    user = session.user
    ensure(user, Action.EDIT_OWN_PROFILE)
    if get_telegram() is None:
        raise ApiError(409, "not_configured", "Telegram isn't set up yet. Ask the Owner.")
    code = tokens.new_code()
    tokens.issue(db, user, TokenKind.TELEGRAM_LINK, secret=code)
    db.commit()
    return TelegramCodeOut(
        code=code,
        expires_at=tokens.now() + tokens.TOKEN_TTL[TokenKind.TELEGRAM_LINK],
        bot_username=str(settings_store.get(db, "telegram_bot_username") or ""),
    )


@router.delete("/telegram-link", status_code=204)
def telegram_unlink(session: CurrentSession, db: Db) -> None:
    user = session.user
    ensure(user, Action.EDIT_OWN_PROFILE)
    user.telegram_user_id = None
    db.commit()
