"""`GET /api/health` — reachability of the services the app depends on (SPEC section 8).

Pinecone and Claude checks are added with build steps 7 and 8.
"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Response, status
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app import __version__
from app.db.session import get_session

router = APIRouter()

CheckResult = Literal["ok", "error"]


class HealthOut(BaseModel):
    status: CheckResult
    version: str
    checks: dict[str, CheckResult]


@router.get("/health", response_model=HealthOut)
def health(response: Response, session: Annotated[Session, Depends(get_session)]) -> HealthOut:
    checks: dict[str, CheckResult] = {"database": _check_database(session)}
    ok = all(result == "ok" for result in checks.values())
    if not ok:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return HealthOut(status="ok" if ok else "error", version=__version__, checks=checks)


def _check_database(session: Session) -> CheckResult:
    try:
        session.execute(text("SELECT 1"))
    except SQLAlchemyError:
        return "error"
    return "ok"
