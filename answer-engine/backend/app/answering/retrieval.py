"""Find what answers a question (SPEC section 6.5, step 3): team-verified answers first,
then document chunks. Postgres decides what may be used and supplies the text."""

from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import settings_store
from app.answering.prompts import ContextItem
from app.db.models import Chunk, StoredFile
from app.kb.live import live_chunk_ids
from app.kb.store import DOCS, VERIFIED, VectorStore
from app.verified import service as verified


@dataclass
class Retrieval:
    items: list[ContextItem] = field(default_factory=list)
    verified_hit: bool = False  # the best verified answer matched at or above verified_match


def retrieve(db: Session, store: VectorStore, query: str) -> Retrieval:
    top_n = settings_store.get_int(db, "rerank_top_n")
    minimum = settings_store.get_float(db, "min_relevance")
    model = str(settings_store.get(db, "rerank_model"))
    found = Retrieval()

    # Verified answers: top 3. Only active, unexpired, undeleted ones count.
    top_v = settings_store.get_int(db, "verified_top_k")
    v_hits = store.search(VERIFIED, query, top_v, model, top_v)
    live_v = verified.live_by_record(db, [hit.id for hit in v_hits])
    kept_v = [h for h in v_hits if h.id in live_v and h.score >= minimum]
    if kept_v and kept_v[0].score >= settings_store.get_float(db, "verified_match"):
        found.verified_hit = True
    for hit in kept_v:
        va = live_v[hit.id]
        found.items.append(
            ContextItem(
                n=len(found.items) + 1,
                chunk_id=hit.id,
                file_id="",
                file_name="",
                heading=None,
                page_from=None,
                page_to=None,
                sheet=None,
                text=verified.search_text(va),
                score=round(hit.score, 4),
                kind="verified",
            )
        )

    # Documents: top 20 by vector search, reranked to the top 8.
    hits = store.search(DOCS, query, settings_store.get_int(db, "docs_top_k"), model, top_n)
    # Deleted, failed or replaced files are dropped even if Pinecone hasn't caught up yet.
    live = live_chunk_ids(db, [hit.id for hit in hits])
    kept = [hit for hit in hits if hit.id in live and hit.score >= minimum][:top_n]
    if not kept:
        return found
    rows = {
        chunk.id: (chunk, file_name)
        for chunk, file_name in db.execute(
            select(Chunk, StoredFile.name)
            .join(StoredFile, StoredFile.id == Chunk.file_id)
            .where(Chunk.id.in_([hit.id for hit in kept]))
        ).all()
    }
    for hit in kept:
        chunk, file_name = rows[hit.id]
        found.items.append(
            ContextItem(
                n=len(found.items) + 1,
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
    return found
