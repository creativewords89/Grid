"""Queue Pinecone changes in the same transaction as the change itself (SPEC section 6.4)."""

import uuid
from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Chunk, KbOp, KbOpKind
from app.kb.store import DOCS

IDS_PER_OP = 1000


def _add(
    db: Session, op: KbOpKind, namespace: str, ids: Iterable[str], file_id: uuid.UUID | None
) -> None:
    unique = sorted(set(ids))
    for start in range(0, len(unique), IDS_PER_OP):
        db.add(
            KbOp(
                op=op,
                namespace=namespace,
                record_ids=unique[start : start + IDS_PER_OP],
                file_id=file_id,
            )
        )


def upsert(
    db: Session, namespace: str, ids: Iterable[str], file_id: uuid.UUID | None = None
) -> None:
    _add(db, KbOpKind.UPSERT, namespace, ids, file_id)


def delete(
    db: Session, namespace: str, ids: Iterable[str], file_id: uuid.UUID | None = None
) -> None:
    _add(db, KbOpKind.DELETE, namespace, ids, file_id)


def file_chunk_ids(db: Session, file_id: uuid.UUID) -> list[str]:
    return list(db.scalars(select(Chunk.id).where(Chunk.file_id == file_id)).all())


def file_searchable(db: Session, file_id: uuid.UUID) -> None:
    upsert(db, DOCS, file_chunk_ids(db, file_id), file_id)


def file_removed(db: Session, file_id: uuid.UUID) -> None:
    delete(db, DOCS, file_chunk_ids(db, file_id), file_id)
