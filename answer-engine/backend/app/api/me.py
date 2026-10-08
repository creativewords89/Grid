"""`/api/me`: a person's own profile and password (SPEC section 7.9)."""

from fastapi import APIRouter

from app.api.schemas import ChangePasswordIn, MessageOut, ProfilePatchIn, UserOut
from app.auth import passwords, sessions
from app.auth.deps import CurrentSession, Db
from app.errors import ApiError
from app.permissions import Action, ensure

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
