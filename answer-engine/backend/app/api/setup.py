"""`/api/setup`: create the first Owner from the browser (SPEC section 13.4).

Only while nobody has an account. A setup code proves the person is the server's
administrator, so a stranger who opens the new site first can't claim it. The code is
derived from SECRET_KEY and shown by `python -m app.cli setup-code` (and in the API's log
at start-up).
"""

import base64
import hashlib
import hmac
import logging

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit, limits
from app.api.auth import _start_session
from app.api.schemas import Email, MeOut, Name, Password, Strict
from app.auth import lockout, passwords
from app.auth.deps import Db, client_ip
from app.config import get_settings
from app.db.models import Role, User
from app.errors import ApiError

log = logging.getLogger(__name__)

router = APIRouter(prefix="/setup", tags=["setup"])


def setup_code() -> str:
    """12 letters and digits, shown as ABCD-EFGH-JKLM."""
    digest = hmac.new(get_settings().signing_key, b"first-owner", hashlib.sha256).digest()
    code = base64.b32encode(digest).decode()[:12]
    return f"{code[:4]}-{code[4:8]}-{code[8:]}"


def _same_code(given: str) -> bool:
    def clean(text: str) -> str:
        return "".join(ch for ch in text.upper() if ch.isalnum())

    return hmac.compare_digest(clean(given), clean(setup_code()))


def needed(db: Session) -> bool:
    return not db.scalar(select(func.count()).select_from(User))


class SetupState(BaseModel):
    needed: bool


class SetupIn(Strict):
    code: Name
    name: Name
    email: Email
    password: Password


@router.get("", response_model=SetupState)
def state(db: Db) -> SetupState:
    return SetupState(needed=needed(db))


@router.post("", response_model=MeOut, status_code=201)
def create_first_owner(body: SetupIn, request: Request, response: Response, db: Db) -> MeOut:
    ip = client_ip(request)
    limits.check_login(db, ip)
    if not needed(db):
        raise ApiError(409, "done", "The Owner account already exists. Sign in instead.")
    if not _same_code(body.code):
        lockout.record(db, "setup", ip, False)
        db.commit()
        raise ApiError(
            403, "bad_code", "That setup code isn't right.", {"code": "Check the setup code."}
        )
    problem = passwords.password_problem(body.password, body.email)
    if problem:
        raise ApiError(422, "invalid", problem, {"password": problem})
    owner = User(
        email=body.email,
        name=body.name,
        role=Role.OWNER,
        password_hash=passwords.hash_password(body.password),
    )
    db.add(owner)
    db.flush()
    audit.record(db, owner, "create", "user", owner.id, owner.name, [])
    log.info("the first Owner was created from the setup page")
    return _start_session(db, owner, request, response)


def announce(db: Session) -> None:
    """At start-up, while there's no account yet, say where to get the setup code."""
    if needed(db):
        log.warning(
            "No account yet: open the site to create the Owner. Setup code: %s", setup_code()
        )
