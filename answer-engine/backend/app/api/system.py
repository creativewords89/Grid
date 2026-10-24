"""`/api/system`: version, the job queue and backups (Owner, Settings → System, SPEC 7.8).

`ops/backup.sh` writes `last-backup.json` to BACKUP_DIR after every run, so the status here
is what the last nightly backup actually did.
"""

import json
import logging
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import func, select

from app import __version__
from app.auth.deps import CurrentUser, Db
from app.auth.tokens import now
from app.config import get_settings
from app.db.models import Job, JobState
from app.permissions import Action, ensure

log = logging.getLogger(__name__)

router = APIRouter(prefix="/system", tags=["system"])

STATUS_FILE = "last-backup.json"
FAILED_WINDOW = timedelta(days=7)
BACKUP_LATE = timedelta(hours=36)  # nightly, so older than this means one was missed


class FailedJob(BaseModel):
    id: uuid.UUID
    kind: str
    attempts: int
    error: str
    at: datetime


class Backup(BaseModel):
    found: bool
    ok: bool | None = None
    at: datetime | None = None
    size_bytes: int | None = None
    off_server: bool | None = None
    message: str | None = None
    late: bool = False


class SystemOut(BaseModel):
    version: str
    environment: str
    queued_jobs: int
    oldest_queued_at: datetime | None
    failed_jobs_7d: int
    failed_jobs: list[FailedJob]
    backup: Backup


def backup_status(directory: str) -> Backup:
    path = Path(directory) / STATUS_FILE
    try:
        data: dict[str, Any] = json.loads(path.read_text())
    except FileNotFoundError:
        return Backup(found=False, message="No backup has run yet.")
    except (OSError, ValueError):
        log.warning("couldn't read the backup status file")
        return Backup(found=False, message="The backup status file can't be read.")
    try:
        at = datetime.fromisoformat(str(data["at"]))
    except (KeyError, ValueError):
        return Backup(found=False, message="The backup status file can't be read.")
    return Backup(
        found=True,
        ok=bool(data.get("ok")),
        at=at,
        size_bytes=int(data["size_bytes"]) if data.get("size_bytes") is not None else None,
        off_server=bool(data.get("off_server")),
        message=str(data.get("message") or "") or None,
        late=now() - at > BACKUP_LATE,
    )


@router.get("", response_model=SystemOut)
def system(me: CurrentUser, db: Db) -> SystemOut:
    ensure(me, Action.MANAGE_SETTINGS)
    settings = get_settings()
    queued, oldest = db.execute(
        select(func.count(), func.min(Job.run_after)).where(
            Job.state == JobState.QUEUED, Job.run_after <= now()
        )
    ).one()
    recent = (Job.state == JobState.FAILED, Job.updated_at > now() - FAILED_WINDOW)
    failed_count = db.scalar(select(func.count()).select_from(Job).where(*recent))
    failed = db.scalars(select(Job).where(*recent).order_by(Job.updated_at.desc()).limit(20))
    return SystemOut(
        version=__version__,
        environment=settings.app_env,
        queued_jobs=queued,
        oldest_queued_at=oldest,
        failed_jobs_7d=failed_count or 0,
        failed_jobs=[
            FailedJob(
                id=j.id,
                kind=j.kind,
                attempts=j.attempts,
                # The last line of the traceback says what went wrong.
                error=(j.last_error or "").strip().splitlines()[-1][:300] if j.last_error else "",
                at=j.updated_at,
            )
            for j in failed
        ],
        backup=backup_status(settings.backup_dir),
    )
