"""`/api/files`: the Documents screen (SPEC sections 6.1, 7.2 and 8)."""

import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, File, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from app import settings_store
from app.auth.deps import CurrentUser, Db
from app.auth.tokens import now
from app.db.models import FileStatus, StoredFile, User
from app.errors import ApiError
from app.files import service, sniff, storage
from app.jobs.queue import enqueue
from app.permissions import Action, can, ensure

router = APIRouter(prefix="/files", tags=["files"])

TypeFilter = Literal["pdf", "word", "excel", "image"]
_TYPE_MIMES: dict[str, tuple[str, ...]] = {
    "pdf": (sniff.PDF.mime,),
    "word": (sniff.DOCX.mime,),
    "excel": (sniff.XLSX.mime, sniff.CSV.mime),
    "image": tuple(t.mime for t in (sniff.PNG, sniff.JPEG, sniff.WEBP, sniff.TIFF, sniff.HEIC)),
}
_INLINE = {sniff.PDF.mime, sniff.PNG.mime, sniff.JPEG.mime, sniff.WEBP.mime}


class PersonOut(BaseModel):
    id: uuid.UUID
    name: str


class FileOut(BaseModel):
    id: uuid.UUID
    name: str
    type: str
    mime: str
    size: int
    status: FileStatus
    error: str | None
    warning: str | None
    page_count: int | None
    chunk_count: int
    version: int
    previous_file_id: uuid.UUID | None
    uploaded_by: PersonOut | None
    created_at: datetime
    can_delete: bool

    @classmethod
    def of(cls, record: StoredFile, viewer: User) -> "FileOut":
        file_type = sniff.BY_MIME.get(record.mime)
        uploader = record.uploader
        return cls(
            id=record.id,
            name=record.name,
            type=file_type.label if file_type else "File",
            mime=record.mime,
            size=record.size,
            status=record.status,
            error=record.error,
            warning=record.warning,
            page_count=record.page_count,
            chunk_count=record.chunk_count,
            version=record.version,
            previous_file_id=record.previous_file_id,
            uploaded_by=PersonOut(id=uploader.id, name=uploader.name) if uploader else None,
            created_at=record.created_at,
            can_delete=can(viewer, Action.DELETE_FILE, record),
        )


class Totals(BaseModel):
    files: int
    pages: int
    ocr_pages_this_month: int


class FileListOut(BaseModel):
    files: list[FileOut]
    totals: Totals


class UploadError(BaseModel):
    code: str
    message: str


class UploadResult(BaseModel):
    name: str
    file: FileOut | None = None
    error: UploadError | None = None


class UploadOut(BaseModel):
    results: list[UploadResult]


def _with_uploader(db: Session, record: StoredFile) -> StoredFile:
    db.refresh(record, attribute_names=["uploader"])
    return record


@router.get("", response_model=FileListOut)
def list_files(
    me: CurrentUser,
    db: Db,
    q: Annotated[str, Query(max_length=200)] = "",
    type: TypeFilter | None = None,
) -> FileListOut:
    ensure(me, Action.ASK)  # every signed-in person may see the documents
    stmt = (
        select(StoredFile)
        .options(joinedload(StoredFile.uploader))
        .where(StoredFile.deleted_at.is_(None))
        .order_by(StoredFile.created_at.desc())
    )
    if q.strip():
        escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        stmt = stmt.where(StoredFile.name.ilike(f"%{escaped}%", escape="\\"))
    if type is not None:
        stmt = stmt.where(StoredFile.mime.in_(_TYPE_MIMES[type]))
    records = db.scalars(stmt).all()

    live = StoredFile.deleted_at.is_(None)
    month_start = now().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    count, pages = db.execute(
        select(func.count(), func.coalesce(func.sum(StoredFile.page_count), 0)).where(live)
    ).one()
    ocr = db.scalar(
        select(func.coalesce(func.sum(StoredFile.ocr_pages), 0)).where(
            StoredFile.created_at >= month_start
        )
    )
    return FileListOut(
        files=[FileOut.of(record, me) for record in records],
        totals=Totals(files=count, pages=pages, ocr_pages_this_month=ocr or 0),
    )


@router.post("", response_model=UploadOut)
def upload(me: CurrentUser, db: Db, files: Annotated[list[UploadFile], File()]) -> UploadOut:
    ensure(me, Action.UPLOAD_FILE)
    limit = settings_store.get_int(db, "max_batch_files")
    if len(files) > limit:
        raise ApiError(422, "too_many", f"Upload at most {limit} files at a time.")
    results: list[UploadResult] = []
    for upload_file in files:
        name = service.clean_name(upload_file.filename)
        try:
            record = service.add(db, me, upload_file.file, upload_file.filename)
        except ApiError as exc:
            results.append(
                UploadResult(name=name, error=UploadError(code=exc.code, message=exc.message))
            )
            continue
        results.append(UploadResult(name=name, file=FileOut.of(_with_uploader(db, record), me)))
    return UploadOut(results=results)


@router.post("/{file_id}/version", response_model=FileOut, status_code=201)
def new_version(
    file_id: uuid.UUID, me: CurrentUser, db: Db, file: Annotated[UploadFile, File()]
) -> FileOut:
    ensure(me, Action.UPLOAD_FILE)
    current = service.live(db, file_id)
    if service.pending_version(db, current) is not None:
        raise ApiError(409, "version_pending", "A new version of this file is already being read.")
    record = service.add(db, me, file.file, file.filename, previous=current)
    return FileOut.of(_with_uploader(db, record), me)


@router.post("/{file_id}/retry", response_model=FileOut)
def retry(file_id: uuid.UUID, me: CurrentUser, db: Db) -> FileOut:
    ensure(me, Action.UPLOAD_FILE)
    record = service.live(db, file_id)
    if record.status != FileStatus.FAILED:
        raise ApiError(409, "not_failed", "Only a file that failed can be retried.")
    record.status = FileStatus.QUEUED
    record.error = None
    enqueue(db, service.INGEST, {"file_id": str(record.id)})
    db.commit()
    return FileOut.of(_with_uploader(db, record), me)


@router.get("/{file_id}/download")
def download(file_id: uuid.UUID, me: CurrentUser, db: Db, inline: bool = False) -> FileResponse:
    ensure(me, Action.DOWNLOAD_FILE)
    record = service.live(db, file_id)
    path = storage.absolute(record.storage_path)
    if not path.is_file():
        raise ApiError(404, "missing", "The original file is missing from storage.")
    disposition = "inline" if inline and record.mime in _INLINE else "attachment"
    return FileResponse(
        path,
        media_type=record.mime,
        filename=record.name,
        content_disposition_type=disposition,
        headers={"Cache-Control": "private, no-store"},
    )


@router.delete("/{file_id}", status_code=204)
def delete_file(file_id: uuid.UUID, me: CurrentUser, db: Db) -> None:
    record = service.live(db, file_id)
    ensure(me, Action.DELETE_FILE, record)
    service.to_trash(db, record, me)
    db.commit()
