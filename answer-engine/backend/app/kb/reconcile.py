"""Nightly check and Rebuild (SPEC section 6.4): make Pinecone match Postgres again."""

from dataclasses import asdict, dataclass

from sqlalchemy.orm import Session

from app import audit
from app.auth.tokens import now
from app.db.models import Setting, User
from app.kb import outbox
from app.kb.live import all_live_chunk_ids
from app.kb.store import DOCS, VectorStore

LAST_CHECK = "kb_last_check"


@dataclass
class CheckResult:
    at: str
    expected: int
    in_pinecone: int
    missing: int
    extra: int
    rebuild: bool
    error: str | None = None


def reconcile(
    db: Session, store: VectorStore | None, rebuild: bool, by: User | None
) -> CheckResult:
    """Queue upserts for records Pinecone lacks (all of them on a rebuild) and deletes for
    records it shouldn't have. The sync worker then sends them."""
    expected = all_live_chunk_ids(db)
    if store is None:
        result = CheckResult(
            now().isoformat(), len(expected), 0, 0, 0, rebuild, "Pinecone is not set up."
        )
    else:
        actual = set(store.list_ids(DOCS))
        missing = expected - actual
        extra = actual - expected
        outbox.upsert(db, DOCS, expected if rebuild else missing)
        outbox.delete(db, DOCS, extra)
        result = CheckResult(
            now().isoformat(), len(expected), len(actual), len(missing), len(extra), rebuild
        )
    row = db.get(Setting, LAST_CHECK)
    if row is None:
        db.add(Setting(key=LAST_CHECK, value=asdict(result)))
    else:
        row.value = asdict(result)
    audit.record(
        db,
        by,
        "rebuild" if rebuild else "check",
        "knowledge_base",
        DOCS,
        "Pinecone",
        [
            {"field": key, "from": None, "to": value}
            for key, value in asdict(result).items()
            if key != "at"
        ],
    )
    return result
