"""Uploading, deleting and replacing documents (SPEC section 6.1)."""

import re
import uuid
from pathlib import PurePath
from typing import BinaryIO

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import audit, settings_store
from app.auth.tokens import now
from app.db.models import FileStatus, StoredFile, TrashItem, TrashKind, User
from app.errors import ApiError
from app.files import sniff, storage
from app.jobs.queue import enqueue
from app.kb import outbox

INGEST = "ingest_file"


def clean_name(raw: str | None) -> str:
    """A display name: no folders, no control characters, at most 255 characters."""
    name = PurePath((raw or "").replace("\\", "/")).name
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip()
    if not name:
        return "Untitled"
    if len(name) > 255:
        suffix = PurePath(name).suffix[:20]
        name = name[: 255 - len(suffix)] + suffix
    return name


def live(db: Session, file_id: uuid.UUID) -> StoredFile:
    found = db.get(StoredFile, file_id)
    if found is None or found.deleted_at is not None:
        raise ApiError(404, "not_found", "That file doesn't exist or was deleted.")
    return found


def _duplicate_of(db: Session, sha256: str) -> StoredFile | None:
    return db.scalar(
        select(StoredFile).where(StoredFile.sha256 == sha256, StoredFile.deleted_at.is_(None))
    )


def _duplicate_error(existing: StoredFile) -> ApiError:
    return ApiError(
        409, "duplicate", f"This file is already in the knowledge base: {existing.name}"
    )


def add(
    db: Session,
    user: User,
    stream: BinaryIO,
    filename: str | None,
    previous: StoredFile | None = None,
) -> StoredFile:
    """Store one upload and queue it for reading. Raises ApiError with a readable reason."""
    name = clean_name(filename)
    max_mb = settings_store.get_int(db, "max_upload_mb")
    try:
        received = storage.receive(stream, max_mb * 1024 * 1024)
    except storage.TooLarge:
        raise ApiError(413, "too_large", f"This file is bigger than {max_mb} MB.") from None
    stored_path: str | None = None
    try:
        try:
            file_type = sniff.detect(received.temp_path, name)
        except sniff.SniffError as exc:
            raise ApiError(415, "unsupported", str(exc)) from None
        existing = _duplicate_of(db, received.sha256)
        if existing is not None:
            raise _duplicate_error(existing)

        stored_path = storage.keep(received)
        record = StoredFile(
            name=name,
            mime=file_type.mime,
            size=received.size,
            sha256=received.sha256,
            storage_path=stored_path,
            status=FileStatus.QUEUED,
            uploaded_by=user.id,
            version=previous.version + 1 if previous else 1,
            previous_file_id=previous.id if previous else None,
        )
        db.add(record)
        db.flush()
        enqueue(db, INGEST, {"file_id": str(record.id)})
        audit.record(
            db,
            user,
            "new_version" if previous else "add",
            "file",
            record.id,
            name,
            [{"field": "version", "from": previous.version, "to": record.version}]
            if previous
            else None,
        )
        db.commit()
        return record
    except IntegrityError:
        # Someone uploaded the same file at the same moment.
        db.rollback()
        if stored_path:
            storage.remove(stored_path)
        existing = _duplicate_of(db, received.sha256)
        raise (
            _duplicate_error(existing)
            if existing
            else ApiError(409, "duplicate", "This file was just uploaded by someone else.")
        ) from None
    except BaseException:
        db.rollback()
        if stored_path:
            storage.remove(stored_path)
        raise
    finally:
        received.temp_path.unlink(missing_ok=True)


def pending_version(db: Session, current: StoredFile) -> StoredFile | None:
    return db.scalar(
        select(StoredFile).where(
            StoredFile.previous_file_id == current.id,
            StoredFile.deleted_at.is_(None),
            StoredFile.status != FileStatus.READY,
        )
    )


def to_trash(db: Session, record: StoredFile, by: User | None, reason: str = "delete") -> None:
    """Soft-delete: it stops being used at once and can be restored for 30 days."""
    record.deleted_at = now()
    outbox.file_removed(db, record.id)
    db.add(
        TrashItem(
            kind=TrashKind.FILE,
            ref_id=record.id,
            title=record.name,
            data={"size": record.size, "version": record.version, "reason": reason},
            deleted_by=by.id if by else None,
            deleted_at=record.deleted_at,
        )
    )
    audit.record(db, by, reason, "file", record.id, record.name)


def restore(db: Session, record: StoredFile, by: User) -> None:
    existing = _duplicate_of(db, record.sha256)
    if existing is not None:
        raise ApiError(
            409,
            "duplicate",
            f"A copy of this file is already in the knowledge base: {existing.name}",
        )
    record.deleted_at = None
    if record.status == FileStatus.READY:
        outbox.file_searchable(db, record.id)
    if record.status in (FileStatus.QUEUED, FileStatus.PROCESSING):
        # It was deleted before it finished: read it again.
        record.status = FileStatus.QUEUED
        enqueue(db, INGEST, {"file_id": str(record.id)})
    audit.record(db, by, "restore", "file", record.id, record.name)


def purge(db: Session, record: StoredFile, by: User | None) -> None:
    """Delete forever, including the original on disk."""
    audit.record(db, by, "purge", "file", record.id, record.name)
    outbox.file_removed(db, record.id)  # normally already gone; makes sure
    path = record.storage_path
    db.delete(record)
    db.flush()
    storage.remove(path)
