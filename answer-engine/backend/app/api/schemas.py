"""Request and response bodies shared by the auth, users and profile routes."""

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, EmailStr, Field, StringConstraints

from app.db.models import Role, User


def _lower(value: str) -> str:
    return value.strip().lower()


Email = Annotated[EmailStr, AfterValidator(_lower)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
Password = Annotated[str, Field(min_length=1, max_length=1024)]
Secret = Annotated[str, Field(min_length=10, max_length=200)]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    name: str
    role: Role
    active: bool
    invited: bool
    telegram_linked: bool
    last_login_at: datetime | None
    created_at: datetime

    @classmethod
    def of(cls, user: User) -> "UserOut":
        return cls(
            id=user.id,
            email=user.email,
            name=user.name,
            role=user.role,
            active=user.active,
            invited=user.invited,
            telegram_linked=user.telegram_user_id is not None,
            last_login_at=user.last_login_at,
            created_at=user.created_at,
        )


class MeOut(BaseModel):
    user: UserOut
    csrf_token: str


class MessageOut(BaseModel):
    message: str


class LinkOut(BaseModel):
    """Result of sending an invite or reset link. The link itself is only returned to the
    Owner when email is not configured, so they can pass it on another way."""

    email_sent: bool
    link: str | None = None


class LoginIn(Strict):
    email: Email
    password: Password


class EmailIn(Strict):
    email: Email


class TokenCheckIn(Strict):
    token: Secret
    kind: Literal["invite", "reset"]


class TokenInfoOut(BaseModel):
    name: str
    email: str


class SetPasswordIn(Strict):
    token: Secret
    password: Password


class InviteIn(Strict):
    name: Name
    email: Email
    role: Role


class InviteOut(LinkOut):
    user: UserOut


class UserPatchIn(Strict):
    name: Name | None = None
    role: Role | None = None
    active: bool | None = None


class ProfilePatchIn(Strict):
    name: Name


class ChangePasswordIn(Strict):
    current_password: Password
    new_password: Password
