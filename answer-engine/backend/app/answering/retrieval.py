"""Find the chunks that answer a question (SPEC section 6.5, step 3)."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import settings_store
from app.answering.prompts import ContextItem
from app.db.models import Chunk, StoredFile
from app.kb.live import live_chunk_ids
from app.kb.store import DOCS, VectorStore


def retrieve(db: Session, store: VectorStore, query: str) -> list[ContextItem]:
    top_k = settings_store.get_int(db, "docs_top_k")
    top_n = settings_store.get_int(db, "rerank_top_n")
    minimum = settings_store.get_float(db, "min_relevance")
    model = str(settings_store.get(db, "rerank_model"))

    hits = store.search(DOCS, query, top_k, model, top_n)
    # Postgres decides what may be used: deleted, failed or replaced files are dropped
    # even if Pinecone hasn't caught up yet.
    live = live_chunk_ids(db, [hit.id for hit in hits])
    kept = [hit for hit in hits if hit.id in live and hit.score >= minimum][:top_n]
    if not kept:
        return []
    rows = {
        chunk.id: (chunk, file_name)
        for chunk, file_name in db.execute(
            select(Chunk, StoredFile.name)
            .join(StoredFile, StoredFile.id == Chunk.file_id)
            .where(Chunk.id.in_([hit.id for hit in kept]))
        ).all()
    }
    items: list[ContextItem] = []
    for hit in kept:
        chunk, file_name = rows[hit.id]
        items.append(
            ContextItem(
                n=len(items) + 1,
                chunk_id=chunk.id,
                file_id=str(chunk.file_id),
                file_name=file_name,
                heading=chunk.heading,
                page_from=chunk.page_from,
                page_to=chunk.page_to,
                sheet=chunk.sheet,
                text=chunk.text,  # the master copy, not Pinecone's
                score=round(hit.score, 4),
            )
        )
    return items
