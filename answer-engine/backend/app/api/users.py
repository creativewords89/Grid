"""`/api/users`: the Owner manages people (SPEC sections 3, 4 and 7.7)."""

import uuid

from fastapi import APIRouter
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit
from app.api.schemas import InviteIn, InviteOut, LinkOut, UserOut, UserPatchIn
from app.auth import sessions, tokens
from app.auth.deps import CurrentUser, Db
from app.config import get_settings
from app.db.models import Role, TokenKind, User
from app.errors import ApiError
from app.mail import Mailer, MailerDep, invite_email, reset_email
from app.permissions import Action, ensure

router = APIRouter(prefix="/users", tags=["users"])


def _get(db: Session, user_id: uuid.UUID) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise ApiError(404, "not_found", "That person doesn't exist.")
    return user


def _send_invite(db: Session, mailer: Mailer, user: User, invited_by: User) -> LinkOut:
    secret = tokens.issue(db, user, TokenKind.INVITE)
    db.commit()
    link = get_settings().link(f"/invite#{secret}")
    sent = mailer.send(user.email, *invite_email(user.name, invited_by.name, link))
    return LinkOut(email_sent=sent, link=None if sent else link)


@router.get("", response_model=list[UserOut])
def list_users(me: CurrentUser, db: Db) -> list[UserOut]:
    ensure(me, Action.MANAGE_USERS)
    users = db.scalars(select(User).order_by(func.lower(User.name), User.email)).all()
    return [UserOut.of(user) for user in users]


@router.post("/invite", response_model=InviteOut, status_code=201)
def invite(body: InviteIn, me: CurrentUser, db: Db, mailer: MailerDep) -> InviteOut:
    ensure(me, Action.MANAGE_USERS)
    if db.scalar(select(User.id).where(User.email == body.email)) is not None:
        raise ApiError(
            409,
            "email_taken",
            "Someone with that email already has an account.",
            {"email": "Already used."},
        )
    user = User(name=body.name, email=body.email, role=body.role)
    db.add(user)
    db.flush()
    audit.record(
        db,
        me,
        "invite",
        "user",
        user.id,
        user.name,
        [{"field": "role", "from": None, "to": user.role.value}],
    )
    result = _send_invite(db, mailer, user, me)
    return InviteOut(user=UserOut.of(user), **result.model_dump())


@router.post("/{user_id}/resend-invite", response_model=LinkOut)
def resend_invite(user_id: uuid.UUID, me: CurrentUser, db: Db, mailer: MailerDep) -> LinkOut:
    ensure(me, Action.MANAGE_USERS)
    user = _get(db, user_id)
    if not user.invited:
        raise ApiError(409, "not_invited", "This person has already set their password.")
    if not user.active:
        raise ApiError(409, "inactive", "Reactivate this person first.")
    return _send_invite(db, mailer, user, me)


@router.post("/{user_id}/reset-password", response_model=LinkOut)
def send_reset(user_id: uuid.UUID, me: CurrentUser, db: Db, mailer: MailerDep) -> LinkOut:
    ensure(me, Action.MANAGE_USERS)
    user = _get(db, user_id)
    if user.invited:
        raise ApiError(
            409,
            "not_accepted",
            "This person hasn't accepted their invite yet. Resend the invite instead.",
        )
    if not user.active:
        raise ApiError(409, "inactive", "Reactivate this person first.")
    secret = tokens.issue(db, user, TokenKind.RESET)
    db.commit()
    link = get_settings().link(f"/reset#{secret}")
    sent = mailer.send(user.email, *reset_email(user.name, link))
    return LinkOut(email_sent=sent, link=None if sent else link)


@router.patch("/{user_id}", response_model=UserOut)
def update_user(user_id: uuid.UUID, body: UserPatchIn, me: CurrentUser, db: Db) -> UserOut:
    ensure(me, Action.MANAGE_USERS)
    user = _get(db, user_id)
    new_role = body.role if body.role is not None else user.role
    new_active = body.active if body.active is not None else user.active

    if user.id == me.id and not new_active:
        raise ApiError(409, "self_deactivate", "You can't deactivate your own account.")
    loses_owner = (
        user.role == Role.OWNER and user.active and (new_role != Role.OWNER or not new_active)
    )
    if loses_owner:
        # Lock every active Owner row so two changes at once can't remove the last Owner.
        owners = db.scalars(
            select(User.id).where(User.role == Role.OWNER, User.active.is_(True)).with_for_update()
        ).all()
        if len(owners) <= 1:
            raise ApiError(409, "last_owner", "There must always be at least one active Owner.")

    before = {"name": user.name, "role": user.role.value, "active": user.active}
    if body.name is not None:
        user.name = body.name
    user.role = new_role
    if user.active and not new_active:
        sessions.revoke_all(db, user.id)
    user.active = new_active
    changes = audit.diff(
        before, {"name": user.name, "role": user.role.value, "active": user.active}
    )
    if changes:
        audit.record(db, me, "edit", "user", user.id, user.name, changes)
    db.commit()
    db.refresh(user)
    return UserOut.of(user)
