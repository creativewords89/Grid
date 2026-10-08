"""Keeping Pinecone in step with Postgres (SPEC section 6.4). Pinecone is faked."""

import json
import threading
from collections.abc import Callable
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pinecone import Pinecone
from sqlalchemy import Engine, select, update
from sqlalchemy.orm import Session, sessionmaker

from app.auth.tokens import now
from app.db.models import (
    AuditEntry,
    Chunk,
    FileStatus,
    KbOp,
    KbOpKind,
    KbOpState,
    Role,
    Setting,
    StoredFile,
    User,
)
from app.files import service
from app.kb import outbox, sync
from app.kb.live import live_chunk_ids
from app.kb.reconcile import LAST_CHECK, reconcile
from app.kb.store import PineconeStore
from tests.conftest import RunJobs, UserFactory, sign_in
from tests.fakes import FakeStore
from tests.files.build import LOREM, pdf, text

Sync = Callable[[], int]


@pytest.fixture
def store(monkeypatch: pytest.MonkeyPatch) -> FakeStore:
    fake = FakeStore()
    monkeypatch.setattr("app.jobs.handlers.get_store", lambda: fake)
    return fake


@pytest.fixture
def send(clean_engine: Engine, store: FakeStore) -> Sync:
    """Run the sync worker until the outbox is empty or blocked."""
    factory = sessionmaker(bind=clean_engine, expire_on_commit=False)

    def run() -> int:
        total = 0
        while sent := sync.process(factory, store):
            total += sent
        return total

    return run


@pytest.fixture
def owner(client: TestClient, make_user: UserFactory) -> User:
    user = make_user(Role.OWNER, name="Olivia")
    sign_in(client, user.email)
    return user


def make_file(
    db: Session, user: User, name: str = "Pricing.pdf", chunks: int = 3, **fields: Any
) -> StoredFile:
    record = StoredFile(
        name=name,
        mime="application/pdf",
        size=1,
        sha256=f"{name}-{chunks}".ljust(64, "0")[:64],
        storage_path=name,
        status=fields.pop("status", FileStatus.READY),
        uploaded_by=user.id,
        **fields,
    )
    db.add(record)
    db.flush()
    for n in range(chunks):
        db.add(
            Chunk(
                id=Chunk.make_id(record.id, n),
                file_id=record.id,
                position=n,
                page_from=n + 1,
                page_to=n + 1,
                heading="Plans",
                text=f"Chunk {n} of {name}.",
                token_count=5,
            )
        )
    db.commit()
    return record


def ops(db: Session) -> list[KbOp]:
    return list(
        db.scalars(select(KbOp).order_by(KbOp.seq).execution_options(populate_existing=True))
    )


def make_due(db: Session) -> None:
    db.execute(update(KbOp).values(next_attempt_at=now() - timedelta(seconds=1)))
    db.commit()


# --- the outbox -------------------------------------------------------------------------


def test_ops_are_part_of_the_change_and_vanish_with_a_rollback(
    db: Session, make_user: UserFactory
) -> None:
    user = make_user()
    record = make_file(db, user)

    service.to_trash(db, record, user)
    db.rollback()

    assert ops(db) == []
    service.to_trash(db, db.get(StoredFile, record.id), user)  # type: ignore[arg-type]
    db.commit()
    [op] = ops(db)
    assert (op.op, op.namespace, op.file_id) == (KbOpKind.DELETE, "docs", record.id)
    assert sorted(op.record_ids) == sorted(Chunk.make_id(record.id, n) for n in range(3))


def test_large_changes_are_split_into_ops_of_1000_ids(db: Session) -> None:
    outbox.upsert(db, "docs", [f"doc_x_{n}" for n in range(2500)])
    db.commit()

    assert [len(op.record_ids) for op in ops(db)] == [1000, 1000, 500]


# --- sending ------------------------------------------------------------------------------


def test_records_carry_text_with_context_and_no_empty_metadata(
    db: Session, make_user: UserFactory, store: FakeStore, send: Sync
) -> None:
    record = make_file(db, make_user(), chunks=1)
    db.add(
        Chunk(
            id=Chunk.make_id(record.id, 1),
            file_id=record.id,
            position=1,
            sheet="Fees 2026",
            heading="Fees 2026",
            text="File: Pricing.pdf — Sheet: Fees 2026\nColumns: Client\n\nRow 2: Client: Acme",
            token_count=20,
        )
    )
    outbox.file_searchable(db, record.id)
    db.commit()

    assert send() == 1

    doc = store.data["docs"][Chunk.make_id(record.id, 0)]
    assert doc == {
        "_id": Chunk.make_id(record.id, 0),
        "text": "Pricing.pdf › Plans\n\nChunk 0 of Pricing.pdf.",
        "file_id": str(record.id),
        "file_name": "Pricing.pdf",
        "page_from": 1,
        "page_to": 1,
    }
    sheet = store.data["docs"][Chunk.make_id(record.id, 1)]
    assert str(sheet["text"]).startswith("File: Pricing.pdf — Sheet: Fees 2026")  # no 2nd prefix
    assert sheet["sheet"] == "Fees 2026"
    assert "page_from" not in sheet
    assert [op.state for op in ops(db)] == [KbOpState.DONE]


def test_upserts_are_sent_96_at_a_time(
    db: Session, make_user: UserFactory, store: FakeStore, send: Sync
) -> None:
    record = make_file(db, make_user(), chunks=200)
    outbox.file_searchable(db, record.id)
    db.commit()

    send()

    assert store.calls == [("upsert", "docs", 96), ("upsert", "docs", 96), ("upsert", "docs", 8)]


def test_deletes_win_over_a_waiting_upsert(
    db: Session, make_user: UserFactory, store: FakeStore, send: Sync
) -> None:
    user = make_user()
    record = make_file(db, user)
    outbox.file_searchable(db, record.id)
    db.commit()
    # Deleted before the upsert reached Pinecone: the upsert reads Postgres and sends nothing.
    record.deleted_at = now()
    db.commit()

    send()

    assert store.ids() == set()


def test_nothing_is_sent_while_pinecone_is_not_set_up(
    db: Session, make_user: UserFactory, clean_engine: Engine
) -> None:
    record = make_file(db, make_user())
    outbox.file_searchable(db, record.id)
    db.commit()

    assert sync.process(sessionmaker(bind=clean_engine), None) == 0

    assert [op.state for op in ops(db)] == [KbOpState.PENDING]


def test_a_failure_waits_with_backoff_and_holds_back_later_ops(
    db: Session, make_user: UserFactory, store: FakeStore, send: Sync
) -> None:
    user = make_user()
    record = make_file(db, user)
    outbox.file_searchable(db, record.id)  # op 1
    outbox.file_removed(db, record.id)  # op 2: must not overtake op 1
    db.commit()
    store.fail = 1

    assert send() == 0

    first, second = ops(db)
    assert (first.state, first.attempts) == (KbOpState.PENDING, 1)
    assert "Pinecone is unreachable" in (first.last_error or "")
    assert timedelta(seconds=8) < first.next_attempt_at - now() <= timedelta(seconds=10)
    assert second.attempts == 0
    assert send() == 0  # not due yet

    make_due(db)
    assert send() == 2
    assert store.calls[0][0] == "upsert"
    assert store.calls[1][0] == "delete"


def test_a_restore_after_a_failed_delete_ends_with_the_record_in_pinecone(
    db: Session, make_user: UserFactory, store: FakeStore, send: Sync
) -> None:
    user = make_user()
    record = make_file(db, user)
    outbox.file_searchable(db, record.id)
    db.commit()
    send()
    service.to_trash(db, record, user)
    db.commit()
    store.fail = 1
    send()  # the delete fails
    service.restore(db, record, user)  # queues an upsert behind it
    db.commit()

    make_due(db)
    send()

    assert store.ids() == {Chunk.make_id(record.id, n) for n in range(3)}


@pytest.mark.parametrize(
    ("attempts", "wait"),
    [
        (1, timedelta(seconds=10)),
        (2, timedelta(minutes=1)),
        (3, timedelta(minutes=5)),
        (4, timedelta(minutes=30)),
        (5, timedelta(hours=1)),
        (40, timedelta(hours=1)),
    ],
)
def test_backoff(attempts: int, wait: timedelta) -> None:
    assert sync.backoff(attempts) == wait


# --- what search may use ------------------------------------------------------------------


def test_only_ready_files_that_are_not_deleted_are_live(
    db: Session, make_user: UserFactory
) -> None:
    user = make_user()
    ready = make_file(db, user, "a.pdf", chunks=1)
    deleted = make_file(db, user, "b.pdf", chunks=1, deleted_at=now())
    failed = make_file(db, user, "c.pdf", chunks=1, status=FileStatus.FAILED)
    reading = make_file(db, user, "d.pdf", chunks=1, status=FileStatus.PROCESSING)
    ids = [Chunk.make_id(f.id, 0) for f in (ready, deleted, failed, reading)] + ["doc_nope_0"]

    assert live_chunk_ids(db, ids) == {Chunk.make_id(ready.id, 0)}


# --- nightly check and rebuild --------------------------------------------------------------


def test_the_nightly_check_repairs_drift(
    db: Session, make_user: UserFactory, store: FakeStore, send: Sync
) -> None:
    user = make_user()
    record = make_file(db, user)
    outbox.file_searchable(db, record.id)
    db.commit()
    send()
    # Someone removed one record by hand, and a stray one appeared.
    store.data["docs"].pop(Chunk.make_id(record.id, 1))
    store.data["docs"]["doc_stray_0"] = {"_id": "doc_stray_0", "text": "old"}

    result = reconcile(db, store, rebuild=False, by=None)
    db.commit()
    send()

    assert (result.expected, result.in_pinecone, result.missing, result.extra) == (3, 3, 1, 1)
    assert store.ids() == {Chunk.make_id(record.id, n) for n in range(3)}
    assert db.get(Setting, LAST_CHECK).value["missing"] == 1  # type: ignore[union-attr]
    assert (
        db.scalar(select(AuditEntry.action).where(AuditEntry.entity == "knowledge_base")) == "check"
    )


def test_rebuild_sends_everything_again(
    db: Session, make_user: UserFactory, store: FakeStore, send: Sync
) -> None:
    record = make_file(db, make_user())
    outbox.file_searchable(db, record.id)
    db.commit()
    send()
    store.calls.clear()

    reconcile(db, store, rebuild=True, by=None)
    db.commit()
    send()

    assert store.calls == [("upsert", "docs", 3)]


def test_the_check_reports_when_pinecone_is_not_set_up(db: Session, make_user: UserFactory) -> None:
    make_file(db, make_user())

    result = reconcile(db, None, rebuild=False, by=None)

    assert result.error == "Pinecone is not set up."
    assert ops(db) == []


# --- the file lifecycle, through the API -----------------------------------------------------


def upload_pdf(client: TestClient, tmp_path: Path, name: str, pages: int = 1) -> dict[str, Any]:
    def page(n: int):  # type: ignore[no-untyped-def]
        return lambda p: text(p, 60, f"{name} page {n}. " + LOREM * 6)

    path = pdf(tmp_path / name, *(page(n) for n in range(pages)))
    response = client.post("/api/files", files=[("files", (name, path.read_bytes()))])
    file: dict[str, Any] = response.json()["results"][0]["file"]
    return file


def test_files_reach_pinecone_and_leave_it(
    client: TestClient,
    owner: User,
    db: Session,
    run_jobs: RunJobs,
    store: FakeStore,
    send: Sync,
    tmp_path: Path,
) -> None:
    file = upload_pdf(client, tmp_path, "Pricing.pdf", pages=3)
    run_jobs()
    assert client.get("/api/files").json()["files"][0]["sync_pending"] is True
    send()
    assert client.get("/api/files").json()["files"][0]["sync_pending"] is False
    ids = {c.id for c in db.scalars(select(Chunk).where(Chunk.file_id == file["id"]))}
    assert store.ids() == ids

    client.delete(f"/api/files/{file['id']}")
    send()
    assert store.ids() == set()

    [item] = client.get("/api/trash").json()
    client.post(f"/api/trash/{item['id']}/restore")
    send()
    assert store.ids() == ids

    client.delete(f"/api/files/{file['id']}")
    [item] = client.get("/api/trash").json()
    client.delete(f"/api/trash/{item['id']}")
    send()
    assert store.ids() == set()


def test_a_new_version_swaps_records_once_ready(
    client: TestClient,
    owner: User,
    db: Session,
    run_jobs: RunJobs,
    store: FakeStore,
    send: Sync,
    tmp_path: Path,
) -> None:
    v1 = upload_pdf(client, tmp_path, "Pricing.pdf")
    run_jobs()
    send()
    path = pdf(tmp_path / "v2.pdf", lambda p: text(p, 60, "Version two. " + LOREM))
    v2 = client.post(
        f"/api/files/{v1['id']}/version", files={"file": ("Pricing v2.pdf", path.read_bytes())}
    ).json()
    send()
    assert all(i.startswith(f"doc_{v1['id']}") for i in store.ids())  # old still answers

    run_jobs()
    send()

    assert store.ids() and all(i.startswith(f"doc_{v2['id']}") for i in store.ids())


def test_reading_a_file_again_removes_chunks_it_no_longer_has(
    db: Session, make_user: UserFactory, store: FakeStore, send: Sync
) -> None:
    from app.jobs.handlers import ingest_file

    user = make_user()
    record = make_file(db, user, chunks=5)
    outbox.file_searchable(db, record.id)
    db.commit()
    send()
    # The stored "PDF" is now one short page: re-reading gives a single chunk.
    from app.files import storage

    path = storage.root() / record.storage_path
    path.parent.mkdir(parents=True, exist_ok=True)
    pdf(path, lambda p: text(p, 60, "This document is much shorter now: one chunk."))
    record.storage_path = record.storage_path
    db.commit()

    ingest_file(db, {"file_id": str(record.id)})
    db.commit()
    send()

    assert store.ids() == {Chunk.make_id(record.id, 0)}


# --- the Owner's knowledge base screen --------------------------------------------------------


def test_status_and_rebuild(
    client: TestClient,
    owner: User,
    db: Session,
    make_user: UserFactory,
    run_jobs: RunJobs,
    store: FakeStore,
    send: Sync,
) -> None:
    record = make_file(db, owner)
    outbox.file_searchable(db, record.id)
    db.commit()

    status = client.get("/api/kb/status").json()
    assert (status["configured"], status["files_ready"], status["chunks"]) == (False, 1, 3)
    assert (status["pending_ops"], status["pending_records"], status["retrying"]) == (1, 3, False)

    store.fail = 1
    send()
    status = client.get("/api/kb/status").json()
    assert status["retrying"] is True
    assert "Pinecone is unreachable" in status["last_error"]

    assert client.post("/api/kb/rebuild").status_code == 202
    run_jobs()
    make_due(db)
    send()
    status = client.get("/api/kb/status").json()
    assert status["pending_ops"] == 0
    assert status["last_check"]["rebuild"] is True
    assert store.ids() == {Chunk.make_id(record.id, n) for n in range(3)}


@pytest.mark.parametrize("role", [Role.USER, Role.REVIEWER])
def test_only_the_owner_sees_the_knowledge_base(
    app_factory: Callable[[], TestClient], make_user: UserFactory, role: Role
) -> None:
    c = app_factory()
    sign_in(c, make_user(role).email)

    assert c.get("/api/kb/status").status_code == 403
    assert c.post("/api/kb/rebuild").status_code == 403


def test_old_finished_ops_are_cleaned_up(db: Session, run_jobs: RunJobs) -> None:
    from app.jobs.queue import enqueue

    outbox.upsert(db, "docs", ["a"])
    outbox.upsert(db, "docs", ["b"])
    db.commit()
    db.execute(update(KbOp).values(state=KbOpState.DONE))
    db.execute(
        update(KbOp).where(KbOp.record_ids == ["a"]).values(updated_at=now() - timedelta(days=8))
    )
    db.commit()
    enqueue(db, "session_cleanup")
    db.commit()

    run_jobs()

    assert [op.record_ids for op in ops(db)] == [["b"]]


# --- the real Pinecone wrapper, with its client replaced ------------------------------------------


def test_pinecone_store_calls_the_sdk_as_documented() -> None:
    calls: list[tuple[str, dict[str, Any]]] = []

    class Index:
        def upsert_records(self, **kw: Any) -> None:
            calls.append(("upsert_records", kw))

        def delete(self, **kw: Any) -> None:
            calls.append(("delete", kw))

        def list(self, **kw: Any) -> Any:
            calls.append(("list", kw))

            def page(*ids: str) -> SimpleNamespace:
                return SimpleNamespace(vectors=[SimpleNamespace(id=i) for i in ids])

            return iter([page("a", "b"), page("c")])

    store = PineconeStore.__new__(PineconeStore)
    store._index = Index()

    store.upsert("docs", [{"_id": "a", "text": "x"}])
    store.delete("docs", ["a"])
    listed = list(store.list_ids("docs"))

    assert calls[0] == (
        "upsert_records",
        {"namespace": "docs", "records": [{"_id": "a", "text": "x"}]},
    )
    assert calls[1] == ("delete", {"ids": ["a"], "namespace": "docs"})
    assert calls[2] == ("list", {"namespace": "docs", "limit": 100})
    assert listed == ["a", "b", "c"]


def test_ensure_index_creates_it_with_integrated_embedding() -> None:
    created: dict[str, Any] = {}

    class Client:
        def has_index(self, name: str) -> bool:
            return False

        def create_index_for_model(self, **kw: Any) -> None:
            created.update(kw)

        def describe_index(self, name: str) -> Any:
            return SimpleNamespace(host="answer-engine-abc.svc.pinecone.io")

    store = PineconeStore.__new__(PineconeStore)
    store.client = Client()  # type: ignore[assignment]
    store.index_name = "answer-engine"

    summary = store.ensure_index("aws", "us-east-1", "llama-text-embed-v2")

    assert created == {
        "name": "answer-engine",
        "cloud": "aws",
        "region": "us-east-1",
        "embed": {"model": "llama-text-embed-v2", "field_map": {"text": "text"}},
        "timeout": 300,
    }
    assert summary == "Index answer-engine created (host answer-engine-abc.svc.pinecone.io)."


def test_setup_pinecone_needs_a_key(monkeypatch: pytest.MonkeyPatch) -> None:
    from app import cli
    from app.config import get_settings

    monkeypatch.setenv("PINECONE_API_KEY", "")
    get_settings.cache_clear()
    with pytest.raises(SystemExit, match="PINECONE_API_KEY"):
        cli.main(["setup-pinecone"])
    get_settings.cache_clear()


def test_the_real_pinecone_sdk_sends_the_expected_requests() -> None:
    """Through the actual Pinecone SDK against a local HTTP server, so the wire format is
    checked: NDJSON records for upsert, deletes by id, paged listing."""
    seen: list[tuple[str, str, str | None, str]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(length).decode()
            seen.append(("POST", self.path, self.headers.get("content-type"), body))
            self.send_response(201 if "upsert" in self.path else 200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            if "upsert" not in self.path:
                self.wfile.write(b"{}")

        def do_GET(self) -> None:
            seen.append(("GET", self.path, None, ""))
            data = json.dumps(
                {"vectors": [{"id": "doc_a_0"}, {"id": "doc_a_1"}], "namespace": "docs"}
            ).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        store = PineconeStore.__new__(PineconeStore)
        store._index = Pinecone(api_key="pc-test").Index(
            host=f"http://127.0.0.1:{server.server_port}"
        )
        record = {"_id": "doc_a_0", "text": "Pricing.pdf › Plans\n\nHello", "page_from": 1}

        store.upsert("docs", [record])
        store.delete("docs", ["doc_a_0", "doc_a_1"])
        listed = list(store.list_ids("docs"))
    finally:
        server.shutdown()

    upsert, delete, listing = seen
    assert upsert[:3] == ("POST", "/records/namespaces/docs/upsert", "application/x-ndjson")
    assert json.loads(upsert[3]) == record
    assert delete[:2] == ("POST", "/vectors/delete")
    assert json.loads(delete[3]) == {"namespace": "docs", "ids": ["doc_a_0", "doc_a_1"]}
    assert listing[1] == "/vectors/list?namespace=docs&limit=100"
    assert listed == ["doc_a_0", "doc_a_1"]


def test_a_configured_host_is_used_directly() -> None:
    store = PineconeStore("pc-test", "answer-engine", "https://answer-engine-abc.svc.pinecone.io")

    assert "answer-engine-abc.svc.pinecone.io" in store.index.host
