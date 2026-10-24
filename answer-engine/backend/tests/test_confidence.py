"""The confidence formula (SPEC section 6.6) as a table, and parsing the support check."""

import pytest

from app.answering.claude_answer import Completion, parse_check
from app.answering.confidence import explain, score
from app.db.models import AnswerOutcome

WEIGHTS = {"retrieval": 0.4, "support": 0.6}


@pytest.mark.parametrize(
    ("best_doc", "verdict", "stop_reason", "verified", "expected", "outcome"),
    [
        (0.81, "full", "end_turn", False, 92, AnswerOutcome.HIGH),  # 32.4 + 60
        (0.81, "partial", "end_turn", False, 62, AnswerOutcome.LOW),  # 32.4 + 30
        (0.81, "none", "end_turn", False, 32, AnswerOutcome.LOW),
        (0.375, "full", "end_turn", False, 75, AnswerOutcome.HIGH),  # 15 + 60: on the line
        (0.36, "full", "end_turn", False, 74, AnswerOutcome.LOW),  # 14.4 + 60
        (1.0, "partial", "end_turn", False, 70, AnswerOutcome.LOW),
        (1.0, "full", "end_turn", False, 100, AnswerOutcome.HIGH),
        (0.0, "full", "end_turn", False, 60, AnswerOutcome.LOW),
        (None, "full", "end_turn", False, 60, AnswerOutcome.LOW),
        (0.9, None, "end_turn", False, 36, AnswerOutcome.LOW),  # check failed: no support
        (0.99, "full", "refusal", False, 0, AnswerOutcome.LOW),
        (0.99, "full", "max_tokens", False, 0, AnswerOutcome.LOW),
        (0.3, "full", "end_turn", True, 95, AnswerOutcome.HIGH),  # verified hit, fully supported
        (0.3, "partial", "end_turn", True, 42, AnswerOutcome.LOW),  # not full: the formula
        (0.99, "full", "refusal", True, 0, AnswerOutcome.LOW),
    ],
)
def test_score_table(
    best_doc: float | None,
    verdict: str | None,
    stop_reason: str,
    verified: bool,
    expected: int,
    outcome: AnswerOutcome,
) -> None:
    result = score(
        best_doc=best_doc,
        verdict=verdict,
        stop_reason=stop_reason,
        threshold=75,
        weights=WEIGHTS,
        verified_hit=verified,
    )
    assert (result.value, result.outcome) == (expected, outcome)


def test_half_points_round_up() -> None:
    # 0.4 * 56.25 rounds to 56 for retrieval; 0.4 * 56 + 0.6 * 50 = 52.4 -> 52.
    assert (
        score(
            best_doc=0.5625, verdict="partial", stop_reason=None, threshold=75, weights=WEIGHTS
        ).value
        == 52
    )
    # 0.5 * 25 + 0.5 * 100 = 62.5 -> 63 (Python's round() would give 62).
    half = {"retrieval": 0.5, "support": 0.5}
    assert (
        score(best_doc=0.25, verdict="full", stop_reason=None, threshold=75, weights=half).value
        == 63
    )


def test_threshold_and_weights_are_settings() -> None:
    result = score(
        best_doc=0.5,
        verdict="partial",
        stop_reason="end_turn",
        threshold=50,
        weights={"retrieval": 0.5, "support": 0.5},
    )
    assert (result.value, result.outcome) == (50, AnswerOutcome.HIGH)


def test_parts_explain_the_score() -> None:
    result = score(
        best_doc=0.81,
        verdict="partial",
        stop_reason="end_turn",
        threshold=75,
        weights=WEIGHTS,
        unsupported_claims=["It takes 3 days"],
    )
    assert result.parts == {
        "retrieval": 81,
        "support": "partial",
        "support_points": 50,
        "weights": WEIGHTS,
        "threshold": 75,
        "verified_hit": False,
        "unsupported_claims": ["It takes 3 days"],
        "reason": None,
    }
    assert explain(result.parts) == "Search match 81 · Support: partial"


@pytest.mark.parametrize(
    ("stop_reason", "verdict", "verified", "text"),
    [
        ("refusal", "full", False, "Claude declined to answer · score 0"),
        ("max_tokens", "full", False, "The answer was cut off · score 0"),
        ("end_turn", None, False, "Search match 50 · Support: check failed"),
        ("end_turn", "full", True, "Matched a team-verified answer · Support: full"),
    ],
)
def test_explanations(stop_reason: str, verdict: str | None, verified: bool, text: str) -> None:
    parts = score(
        best_doc=0.5,
        verdict=verdict,
        stop_reason=stop_reason,
        threshold=75,
        weights=WEIGHTS,
        verified_hit=verified,
    ).parts
    assert explain(parts) == text
    assert explain(None) == ""


def done(text: str, stop_reason: str = "end_turn") -> Completion:
    return Completion(text, stop_reason, "claude-opus-5-5", 100, 10)


def test_parse_check() -> None:
    ok = parse_check(done('{"verdict": "partial", "unsupported_claims": ["Costs $5"]}'))
    assert (ok.verdict, ok.unsupported_claims) == ("partial", ["Costs $5"])
    for bad in (
        done("not json"),
        done('{"verdict": "maybe", "unsupported_claims": []}'),
        done("{}"),
        done('{"verdict": "full", "unsupported_claims": []}', stop_reason="refusal"),
        done('{"verdict": "full"', stop_reason="max_tokens"),
    ):
        assert parse_check(bad).verdict is None
