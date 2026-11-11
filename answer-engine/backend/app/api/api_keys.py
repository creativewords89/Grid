"""`/api/api-keys`: Settings → API keys (SPEC sections 4 and 7.8, step 28). Owners only, and
only from a signed-in session: a key can't make or revoke keys."""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import select

from app.api.answer_log import Person
from app.api.schemas import Strict
from app.auth import api_keys
from app.auth.deps import CurrentSession, Db
from app.db.models import ApiKey
from app.errors import ApiError
from app.permissions import Action, ensure

router = APIRouter(prefix="/api-keys", tags=["api-keys"])


class KeyOut(BaseModel):
    id: uuid.UUID
    name: str
    prefix: str
    scopes: list[str]
    made_by: Person
    created_at: datetime
    expires_at: datetime | None
    last_used_at: datetime | None
    revoked_at: datetime | None


class KeyList(BaseModel):
    items: list[KeyOut]
    scopes: dict[str, str]


class CreateIn(Strict):
    name: Annotated[str, StringConstraints(max_length=100)]
    scopes: list[str] = Field(max_length=10)
    expires_days: int | None = 90


class Created(BaseModel):
    key: KeyOut
    token: str  # shown once


def _out(key: ApiKey) -> KeyOut:
    return KeyOut(
        id=key.id,
        name=key.name,
        prefix=key.prefix,
        scopes=key.scopes,
        made_by=Person(id=key.user.id, name=key.user.name),
        created_at=key.created_at,
        expires_at=key.expires_at,
        last_used_at=key.last_used_at,
        revoked_at=key.revoked_at,
    )


@router.get("", response_model=KeyList)
def list_keys(session: CurrentSession, db: Db) -> KeyList:
    ensure(session.user, Action.MANAGE_API_KEYS)
    keys = db.scalars(select(ApiKey).order_by(ApiKey.created_at.desc())).all()
    return KeyList(items=[_out(k) for k in keys], scopes=api_keys.SCOPE_LABELS)


@router.post("", response_model=Created, status_code=201)
def create_key(body: CreateIn, session: CurrentSession, db: Db) -> Created:
    ensure(session.user, Action.MANAGE_API_KEYS)
    key, token = api_keys.create(db, session.user, body.name, body.scopes, body.expires_days)
    db.commit()
    db.refresh(key)
    return Created(key=_out(key), token=token)


@router.delete("/{key_id}", status_code=204)
def revoke_key(key_id: uuid.UUID, session: CurrentSession, db: Db) -> None:
    ensure(session.user, Action.MANAGE_API_KEYS)
    key = db.get(ApiKey, key_id)
    if key is None:
        raise ApiError(404, "not_found", "That key doesn't exist.")
    api_keys.revoke(db, key, session.user)
    db.commit()
