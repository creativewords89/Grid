"""Helpers for tests that ask questions: documents in the fake Pinecone, and the SSE stream."""

import json
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.models import Chunk, FileStatus, StoredFile, User
from app.kb.store import DOCS
from tests.fakes import FakeStore

Events = list[tuple[str, dict[str, Any]]]


def add_doc(
    db: Session,
    store: FakeStore,
    user: User,
    name: str,
    texts: list[str],
    in_pinecone: bool = True,
    **fields: Any,
) -> StoredFile:
    record = StoredFile(
        name=name,
        mime="application/pdf",
        size=1,
        sha256=name.ljust(64, "0")[:64],
        storage_path=name,
        status=fields.pop("status", FileStatus.READY),
        uploaded_by=user.id,
        **fields,
    )
    db.add(record)
    db.flush()
    for n, text in enumerate(texts):
        chunk_id = Chunk.make_id(record.id, n)
        db.add(
            Chunk(
                id=chunk_id,
                file_id=record.id,
                position=n,
                page_from=n + 1,
                page_to=n + 1,
                heading="Plans",
                text=text,
                token_count=10,
            )
        )
        if in_pinecone:
            store.data.setdefault(DOCS, {})[chunk_id] = {"_id": chunk_id, "text": text}
    db.commit()
    return record


def events(response: Any) -> Events:
    out: Events = []
    for block in response.text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        out.append((lines["event"], json.loads(lines["data"])))
    return out


def new_chat(client: TestClient) -> str:
    chat_id: str = client.post("/api/conversations", json={}).json()["id"]
    return chat_id


def ask(client: TestClient, chat_id: str, question: str) -> Events:
    response = client.post(f"/api/conversations/{chat_id}/ask", json={"question": question})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")
    return events(response)


def data_of(evs: Events, name: str) -> dict[str, Any]:
    [data] = [data for event_name, data in evs if event_name == name]
    return data


def streamed_text(evs: Events) -> str:
    text = "".join(data["text"] for name, data in evs if name == "delta")
    replaced = [data["text"] for name, data in evs if name == "replace"]
    return replaced[-1] if replaced else text
