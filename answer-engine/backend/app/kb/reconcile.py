"""Nightly check and Rebuild (SPEC section 6.4): make Pinecone match Postgres again, for both
namespaces (document chunks and verified answers)."""

from dataclasses import asdict, dataclass

from sqlalchemy.orm import Session

from app import audit
from app.auth.tokens import now
from app.db.models import Setting, User
from app.kb import outbox
from app.kb.live import all_live_chunk_ids
from app.kb.store import DOCS, VERIFIED, VectorStore
from app.verified import service as verified

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
    wanted = {DOCS: all_live_chunk_ids(db), VERIFIED: verified.all_live_records(db)}
    expected = sum(len(ids) for ids in wanted.values())
    if store is None:
        result = CheckResult(
            now().isoformat(), expected, 0, 0, 0, rebuild, "Pinecone is not set up."
        )
    else:
        in_pinecone = missing = extra = 0
        for namespace, ids in wanted.items():
            actual = set(store.list_ids(namespace))
            lacking = ids - actual
            stray = actual - ids
            outbox.upsert(db, namespace, ids if rebuild else lacking)
            outbox.delete(db, namespace, stray)
            in_pinecone += len(actual)
            missing += len(lacking)
            extra += len(stray)
        result = CheckResult(now().isoformat(), expected, in_pinecone, missing, extra, rebuild)
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
