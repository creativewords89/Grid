"""A stand-in for Claude's OCR so tests never call the real API."""

import threading
from collections.abc import Callable, Generator, Iterator
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from app.ai.ocr_client import Transcript

if TYPE_CHECKING:
    from app.answering.claude_answer import CheckResult, Completion
    from app.kb.store import Hit

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
    searched: list[str] = field(default_factory=list)

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

    def search(
        self, namespace: str, text: str, top_k: int, rerank_model: str, top_n: int
    ) -> list["Hit"]:
        self._maybe_fail()
        self.calls.append(("search", namespace, top_n))
        self.searched.append(text)
        return keyword_search(self, namespace, text, top_n)

    def ids(self, namespace: str = "docs") -> set[str]:
        return set(self.data.get(namespace, {}))


def _words(text: str) -> set[str]:
    return {w.strip(".,?!:;()[]").lower() for w in text.split() if len(w) > 2}


def keyword_search(store: "FakeStore", namespace: str, text: str, top_n: int) -> list["Hit"]:
    """Score = share of the question's words found in the record (a stand-in for reranking)."""
    from app.kb.store import Hit

    wanted = _words(text)
    hits = []
    for record_id, record in store.data.get(namespace, {}).items():
        found = wanted & _words(str(record.get("text", "")))
        if found:
            hits.append(Hit(record_id, round(len(found) / len(wanted), 4)))
    return sorted(hits, key=lambda h: (-h.score, h.id))[:top_n]


@dataclass
class FakeAnswerer:
    """Streams a scripted answer in small pieces and records what it was given."""

    reply: str = "The Pro plan costs $900 a month [1]."
    stop_reason: str = "end_turn"
    final_text: str | None = None  # the final message, if a fallback changed it
    fail_after: int | None = None  # raise after this many pieces
    rewritten: str = "What does the Pro plan cost per month?"
    prompts: list[str] = field(default_factory=list)
    histories: list[list[dict[str, object]]] = field(default_factory=list)
    rewrites: list[tuple[str, str]] = field(default_factory=list)
    verdict: str | None = "full"  # the support check's verdict; None = it raises
    unsupported: list[str] = field(default_factory=list)
    checks: list[str] = field(default_factory=list)

    def rewrite(self, transcript: str, question: str) -> "Completion":
        from app.answering.claude_answer import Completion

        self.rewrites.append((transcript, question))
        return Completion(self.rewritten, "end_turn", "claude-opus-5-5", 200, 20)

    def stream(self, history: list[Any], prompt: str) -> Generator[str, None, "Completion"]:
        from app.answering.claude_answer import Completion

        self.prompts.append(prompt)
        self.histories.append([dict(turn) for turn in history])
        pieces = [self.reply[i : i + 7] for i in range(0, len(self.reply), 7)]
        for n, piece in enumerate(pieces):
            if self.fail_after is not None and n >= self.fail_after:
                raise ConnectionError("Claude is overloaded")
            yield piece
        text = self.final_text if self.final_text is not None else self.reply
        if self.stop_reason == "refusal":
            text = ""
        return Completion(text, self.stop_reason, "claude-opus-5-5", 3000, 120, 2500)

    def check(self, prompt: str) -> "CheckResult":
        from app.answering.claude_answer import CheckResult, Completion

        self.checks.append(prompt)
        if self.verdict is None:
            raise ConnectionError("Claude is overloaded")
        done = Completion("{}", "end_turn", "claude-opus-5-5", 2000, 40)
        return CheckResult(self.verdict, list(self.unsupported), done)
