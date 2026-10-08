"""A stand-in for Claude's OCR so tests never call the real API."""

import threading
from collections.abc import Callable
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
