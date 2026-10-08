"""Every job type the worker runs. Importing this module registers them."""

import uuid
from datetime import timedelta

from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from app import trash
from app.auth.tokens import now
from app.chunking import chunk_blocks
from app.db.models import (
    AuthSession,
    AuthToken,
    Chunk,
    FileStatus,
    Job,
    JobState,
    LoginAttempt,
    StoredFile,
    User,
)
from app.files import service as files
from app.files import storage
from app.files.extract import extract
from app.jobs.queue import Payload, UserFacingError, job


def _fail_file(db: Session, payload: Payload, message: str) -> None:
    record = db.get(StoredFile, uuid.UUID(payload["file_id"]))
    if record is not None and record.deleted_at is None:
        record.status = FileStatus.FAILED
        record.error = message


@job(files.INGEST, on_failure=_fail_file)
def ingest_file(db: Session, payload: Payload) -> None:
    """Read an uploaded file into chunks (SPEC section 6.1).

    OCR of scanned pages and images (step 6), spreadsheets (step 5) and Pinecone (step 7)
    are added in later build steps.
    """
    record = db.get(StoredFile, uuid.UUID(payload["file_id"]), with_for_update=True)
    if record is None or record.deleted_at is not None:
        return  # deleted while waiting
    record.status = FileStatus.PROCESSING
    record.error = None
    record.warning = None
    db.commit()

    path = storage.absolute(record.storage_path)
    if not path.is_file():
        raise UserFacingError("The uploaded file is missing from storage. Upload it again.")
    result = extract(path, record.mime)
    pieces = chunk_blocks(result.blocks)

    db.refresh(record, with_for_update=True)
    if record.deleted_at is not None:
        return
    db.execute(delete(Chunk).where(Chunk.file_id == record.id))  # a retry starts afresh
    db.add_all(
        Chunk(
            id=Chunk.make_id(record.id, n),
            file_id=record.id,
            position=n,
            page_from=piece.page_from,
            page_to=piece.page_to,
            heading=piece.heading,
            text=piece.text,
            token_count=piece.token_count,
            from_ocr=piece.from_ocr,
        )
        for n, piece in enumerate(pieces)
    )
    record.page_count = result.page_count
    record.chunk_count = len(pieces)
    record.warning = result.warning
    if not pieces and not record.warning:
        record.warning = "No text was found in this file."
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
