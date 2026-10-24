"""Knowledge gaps: unanswered questions grouped by similarity (SPEC section 7.5).

A cheap word-overlap grouping is enough for the volumes here (1-50 people): each question
joins the first group whose first question shares at least half of its words.
"""

import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime

_STOP = frozenset(
    [
        "a",
        "an",
        "and",
        "are",
        "can",
        "do",
        "does",
        "for",
        "from",
        "how",
        "i",
        "in",
        "is",
        "it",
        "me",
        "my",
        "of",
        "on",
        "or",
        "our",
        "the",
        "to",
        "we",
        "what",
        "when",
        "where",
        "which",
        "who",
        "why",
        "will",
        "with",
        "you",
        "your",
    ]
)
SIMILAR = 0.5


def words(text: str) -> frozenset[str]:
    return frozenset(w for w in re.findall(r"[a-z0-9$%]+", text.lower()) if w not in _STOP)


def similarity(a: frozenset[str], b: frozenset[str]) -> float:
    if not a or not b:
        return 1.0 if a == b else 0.0
    return len(a & b) / len(a | b)


@dataclass
class Gap:
    question: str
    count: int = 0
    last_asked_at: datetime | None = None
    answer_ids: list[str] = field(default_factory=list)
    examples: list[str] = field(default_factory=list)
    _words: frozenset[str] = frozenset()


def group(rows: Iterable[tuple[str, str, datetime]]) -> list[Gap]:
    """rows: (answer id, question, asked at), newest first. Biggest groups first."""
    gaps: list[Gap] = []
    for answer_id, question, at in rows:
        mine = words(question)
        gap = next((g for g in gaps if similarity(g._words, mine) >= SIMILAR), None)
        if gap is None:
            gap = Gap(question=question, _words=mine)
            gaps.append(gap)
        gap.count += 1
        gap.answer_ids.append(answer_id)
        if gap.last_asked_at is None or at > gap.last_asked_at:
            gap.last_asked_at = at
        if question not in gap.examples and len(gap.examples) < 5:
            gap.examples.append(question)
    return sorted(
        gaps, key=lambda g: (-g.count, -(g.last_asked_at.timestamp() if g.last_asked_at else 0))
    )
