"""`/api/kb`: knowledge base status and Rebuild (Owner, SPEC sections 6.4 and 7.8)."""

from datetime import datetime
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import func, select

from app import audit
from app.auth.deps import CurrentUser, Db
from app.config import get_settings
from app.db.models import Chunk, FileStatus, KbOp, KbOpState, Setting, StoredFile
from app.jobs.queue import enqueue
from app.kb.reconcile import LAST_CHECK
from app.permissions import Action, ensure

router = APIRouter(prefix="/kb", tags=["knowledge base"])


class KbStatus(BaseModel):
    configured: bool
    index: str
    files_ready: int
    chunks: int
    pending_ops: int
    pending_records: int
    oldest_pending_at: datetime | None
    retrying: bool
    last_error: str | None
    last_check: dict[str, Any] | None


@router.get("/status", response_model=KbStatus)
def status(me: CurrentUser, db: Db) -> KbStatus:
    ensure(me, Action.MANAGE_KB)
    settings = get_settings()
    pending = KbOp.state == KbOpState.PENDING
    ops, records, oldest, retrying = db.execute(
        select(
            func.count(),
            func.coalesce(func.sum(func.cardinality(KbOp.record_ids)), 0),
            func.min(KbOp.created_at),
            func.coalesce(func.bool_or(KbOp.attempts > 0), False),
        ).where(pending)
    ).one()
    last_error = db.scalar(
        select(KbOp.last_error).where(pending, KbOp.last_error.isnot(None)).order_by(KbOp.seq)
    )
    live = (StoredFile.deleted_at.is_(None)) & (StoredFile.status == FileStatus.READY)
    files_ready = db.scalar(select(func.count()).select_from(StoredFile).where(live)) or 0
    chunks = db.scalar(select(func.count()).select_from(Chunk).join(StoredFile).where(live)) or 0
    check = db.get(Setting, LAST_CHECK)
    return KbStatus(
        configured=bool(settings.pinecone_api_key),
        index=settings.pinecone_index,
        files_ready=files_ready,
        chunks=chunks,
        pending_ops=ops,
        pending_records=records,
        oldest_pending_at=oldest,
        retrying=retrying,
        last_error=last_error,
        last_check=check.value if check else None,
    )


@router.post("/rebuild", status_code=202)
def rebuild(me: CurrentUser, db: Db) -> dict[str, str]:
    ensure(me, Action.MANAGE_KB)
    enqueue(db, "kb_rebuild", {"user_id": str(me.id)})
    audit.record(db, me, "rebuild_requested", "knowledge_base", "docs", "Pinecone")
    db.commit()
    return {"message": "Rebuild started. Answers keep working while it runs."}
