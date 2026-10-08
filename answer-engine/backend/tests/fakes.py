"""A stand-in for Claude's OCR so tests never call the real API."""

import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field

from app.ai.ocr_client import Transcript

Answer = Callable[[int], Transcript | Exception]


def page_text(n: int) -> str:
    return f"# Scanned page {n}\n\nThis is the text Claude read on page {n}."


@dataclass
class FakeOcr:
    """Answers each call in order with `answer(call_number)`; by default a transcript."""

    answer: Answer = field(
        default=lambda n: Transcript(page_text(n), "ok", "claude-opus-5-5", 1500, 300)
    )
    calls: list[tuple[int, str]] = field(default_factory=list)  # (bytes, media type)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def transcribe(self, image: bytes, media_type: str) -> Transcript:
        with self._lock:
            self.calls.append((len(image), media_type))
            number = len(self.calls)
        result = self.answer(number)
        if isinstance(result, Exception):
            raise result
        return result


@dataclass
class FakeStore:
    """An in-memory Pinecone. Set `fail` to make the next N calls raise."""

    data: dict[str, dict[str, dict[str, object]]] = field(default_factory=dict)
    calls: list[tuple[str, str, int]] = field(default_factory=list)  # (call, namespace, size)
    fail: int = 0

    def _maybe_fail(self) -> None:
        if self.fail:
            self.fail -= 1
            raise ConnectionError("Pinecone is unreachable")

    def upsert(self, namespace: str, records: list[dict[str, object]]) -> None:
        self._maybe_fail()
        self.calls.append(("upsert", namespace, len(records)))
        space = self.data.setdefault(namespace, {})
        for record in records:
            space[str(record["_id"])] = record

    def delete(self, namespace: str, ids: list[str]) -> None:
        self._maybe_fail()
        self.calls.append(("delete", namespace, len(ids)))
        for record_id in ids:
            self.data.get(namespace, {}).pop(record_id, None)

    def list_ids(self, namespace: str) -> Iterator[str]:
        self._maybe_fail()
        yield from list(self.data.get(namespace, {}))

    def ids(self, namespace: str = "docs") -> set[str]:
        return set(self.data.get(namespace, {}))
