"""What may be used in answers right now, according to Postgres (SPEC section 6.4).

Search results from Pinecone are filtered through this, so a deleted file is never used,
even while its delete is still waiting to reach Pinecone.
"""

from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Chunk, FileStatus, StoredFile


def _live_chunks() -> object:
    return (
        select(Chunk.id)
        .join(StoredFile, StoredFile.id == Chunk.file_id)
        .where(StoredFile.deleted_at.is_(None), StoredFile.status == FileStatus.READY)
    )


def live_chunk_ids(db: Session, ids: Iterable[str]) -> set[str]:
    wanted = list(set(ids))
    if not wanted:
        return set()
    stmt = _live_chunks().where(Chunk.id.in_(wanted))  # type: ignore[attr-defined]
    return set(db.scalars(stmt).all())


def all_live_chunk_ids(db: Session) -> set[str]:
    return set(db.scalars(_live_chunks()).all())  # type: ignore[call-overload]
