"""Send the outbox to Pinecone, strictly in order (SPEC section 6.4).

Ops run oldest first. When one fails it is retried with backoff and everything after it
waits, so a later delete can never overtake an earlier upsert of the same record. An upsert
reads the records from Postgres when it runs: anything deleted since is skipped.
"""

import logging
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.auth.tokens import now
from app.chunking import context_line
from app.db.models import Chunk, KbOp, KbOpKind, KbOpState, StoredFile
from app.kb.live import live_chunk_ids
from app.kb.store import DELETE_BATCH, DOCS, UPSERT_BATCH, Record, VectorStore

log = logging.getLogger(__name__)

BACKOFF = (
    timedelta(seconds=10),
    timedelta(minutes=1),
    timedelta(minutes=5),
    timedelta(minutes=30),
)
MAX_BACKOFF = timedelta(hours=1)
BATCH_OPS = 50


def backoff(attempts: int) -> timedelta:
    return BACKOFF[attempts - 1] if attempts <= len(BACKOFF) else MAX_BACKOFF


def doc_records(db: Session, ids: list[str]) -> list[Record]:
    """Pinecone records for the chunks that are still live. Metadata can't hold nulls."""
    live = live_chunk_ids(db, ids)
    rows = db.execute(
        select(Chunk, StoredFile.name)
        .join(StoredFile, StoredFile.id == Chunk.file_id)
        .where(Chunk.id.in_(live))
        .order_by(Chunk.id)
    ).all()
    records: list[Record] = []
    for chunk, file_name in rows:
        # Spreadsheet chunks already start with "File: … — Sheet: …".
        text = (
            chunk.text
            if chunk.sheet
            else f"{context_line(file_name, chunk.heading)}\n\n{chunk.text}"
        )
        record: Record = {
            "_id": chunk.id,
            "text": text,
            "file_id": str(chunk.file_id),
            "file_name": file_name,
        }
        for key in ("page_from", "page_to", "sheet"):
            value = getattr(chunk, key)
            if value is not None:
                record[key] = value
        records.append(record)
    return records


def _run(db: Session, store: VectorStore, op: KbOp) -> None:
    if op.op == KbOpKind.DELETE:
        for start in range(0, len(op.record_ids), DELETE_BATCH):
            store.delete(op.namespace, op.record_ids[start : start + DELETE_BATCH])
        return
    if op.namespace != DOCS:
        raise ValueError(f"no records for namespace {op.namespace!r} yet")
    records = doc_records(db, op.record_ids)
    for start in range(0, len(records), UPSERT_BATCH):
        store.upsert(op.namespace, records[start : start + UPSERT_BATCH])


def process(factory: sessionmaker[Session], store: VectorStore | None) -> int:
    """Send due ops. Returns how many were sent; stops at the first failure."""
    if store is None:
        return 0  # not configured: ops wait
    sent = 0
    with factory() as db:
        ops = db.scalars(
            select(KbOp)
            .where(KbOp.state == KbOpState.PENDING)
            .order_by(KbOp.seq)
            .limit(BATCH_OPS)
            .with_for_update(skip_locked=True)
        ).all()
        for op in ops:
            if op.next_attempt_at > now():
                break  # the oldest is waiting to retry: keep the order
            try:
                _run(db, store, op)
            except Exception as exc:
                op.attempts += 1
                op.next_attempt_at = now() + backoff(op.attempts)
                op.last_error = f"{type(exc).__name__}: {exc}"[:2000]
                log.warning("Pinecone sync failed (attempt %s): %s", op.attempts, exc)
                db.commit()
                break
            op.state = KbOpState.DONE
            op.last_error = None
            sent += 1
        db.commit()
    return sent
