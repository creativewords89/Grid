"""The confidence score (SPEC section 6.6). Pure functions, so the formula is easy to test.

score = round(w_retrieval * best doc rerank score * 100 + w_support * support points), where
the support check's verdict full / partial / none is worth 100 / 50 / 0. A verified hit that
the check fully supports scores 95. An answer that was refused or cut off scores 0.
"""

from dataclasses import dataclass
from typing import Any

from app.db.models import AnswerOutcome

SUPPORT_POINTS = {"full": 100, "partial": 50, "none": 0}
VERIFIED_SCORE = 95
ZERO_STOP_REASONS = {"refusal": "Claude declined to answer", "max_tokens": "The answer was cut off"}


@dataclass(frozen=True)
class Score:
    value: int
    outcome: AnswerOutcome
    parts: dict[str, Any]


def _round(value: float) -> int:
    """Round half up (Python's round() rounds 62.5 to 62)."""
    return int(value + 0.5)


def score(
    *,
    best_doc: float | None,
    verdict: str | None,
    stop_reason: str | None,
    threshold: int,
    weights: dict[str, float],
    verified_hit: bool = False,
    unsupported_claims: list[str] | None = None,
) -> Score:
    """`verdict` is None when the support check couldn't run; it then counts as no support."""
    retrieval = _round(max(0.0, min(1.0, best_doc or 0.0)) * 100)
    parts: dict[str, Any] = {
        "retrieval": retrieval,
        "support": verdict,
        "support_points": SUPPORT_POINTS.get(verdict or "", 0),
        "weights": {"retrieval": weights["retrieval"], "support": weights["support"]},
        "threshold": threshold,
        "verified_hit": verified_hit,
        "unsupported_claims": list(unsupported_claims or []),
        "reason": None,
    }
    if stop_reason in ZERO_STOP_REASONS:
        parts["reason"] = stop_reason
        value = 0
    elif verified_hit and verdict == "full":
        value = VERIFIED_SCORE
    else:
        if verdict is None:
            parts["reason"] = "check_failed"
        value = _round(
            weights["retrieval"] * retrieval + weights["support"] * parts["support_points"]
        )
    value = max(0, min(100, value))
    outcome = AnswerOutcome.HIGH if value >= threshold else AnswerOutcome.LOW
    return Score(value, outcome, parts)


def explain(parts: dict[str, Any] | None) -> str:
    """One line for the Answer Log: "Search match 81 · Support: partial"."""
    if not parts:
        return ""
    reason = parts.get("reason")
    if reason in ZERO_STOP_REASONS:
        return f"{ZERO_STOP_REASONS[reason]} · score 0"
    if parts.get("verified_hit") and parts.get("support") == "full":
        return "Matched a team-verified answer · Support: full"
    support = parts.get("support") or "check failed"
    return f"Search match {parts.get('retrieval', 0)} · Support: {support}"
