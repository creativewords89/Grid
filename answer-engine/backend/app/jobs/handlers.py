"""Every job type the worker runs. Importing this module registers them."""

import uuid
from datetime import timedelta

from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from app import trash
from app.auth.tokens import now
from app.db.models import (
    AuthSession,
    AuthToken,
    FileStatus,
    Job,
    JobState,
    LoginAttempt,
    StoredFile,
    User,
)
from app.files import service as files
from app.files import storage
from app.jobs.queue import Payload, UserFacingError, job


def _fail_file(db: Session, payload: Payload, message: str) -> None:
    record = db.get(StoredFile, uuid.UUID(payload["file_id"]))
    if record is not None and record.deleted_at is None:
        record.status = FileStatus.FAILED
        record.error = message


@job(files.INGEST, on_failure=_fail_file)
def ingest_file(db: Session, payload: Payload) -> None:
    """Read an uploaded file (SPEC section 6.1).

    Text extraction, OCR, chunking and Pinecone arrive in build steps 4-7; for now the
    file is checked and marked Ready.
    """
    record = db.get(StoredFile, uuid.UUID(payload["file_id"]), with_for_update=True)
    if record is None or record.deleted_at is not None:
        return  # deleted while waiting
    record.status = FileStatus.PROCESSING
    record.error = None
    db.commit()

    if not storage.absolute(record.storage_path).is_file():
        raise UserFacingError("The uploaded file is missing from storage. Upload it again.")

    db.refresh(record, with_for_update=True)
    if record.deleted_at is not None:
        return
    record.status = FileStatus.READY
    if record.previous_file_id is not None:
        previous = db.get(StoredFile, record.previous_file_id)
        if previous is not None and previous.deleted_at is None:
            uploader = db.get(User, record.uploaded_by) if record.uploaded_by else None
            files.to_trash(db, previous, uploader, reason="replaced")


@job("trash_purge")
def trash_purge(db: Session, payload: Payload) -> None:
    trash.purge_expired(db)


@job("session_cleanup")
def session_cleanup(db: Session, payload: Payload) -> None:
    """Remove expired sessions and links, old sign-in attempts and finished jobs."""
    current = now()
    db.execute(delete(AuthSession).where(AuthSession.expires_at < current))
    db.execute(
        delete(AuthToken).where(
            or_(AuthToken.expires_at < current - timedelta(days=1), AuthToken.used_at.isnot(None))
        )
    )
    db.execute(delete(LoginAttempt).where(LoginAttempt.at < current - timedelta(days=30)))
    db.execute(
        delete(Job).where(Job.state == JobState.DONE, Job.updated_at < current - timedelta(days=14))
    )
    # Failed jobs stay for 90 days so the Owner can see them in Settings → System.
    old_failed = select(Job.id).where(
        Job.state == JobState.FAILED, Job.updated_at < current - timedelta(days=90)
    )
    db.execute(delete(Job).where(Job.id.in_(old_failed)))
