"""Confidence on real answers, 👍/👎, and the Answer Log (SPEC sections 6.6, 6.7 and 7.5)."""

from collections.abc import Callable
from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.tokens import now
from app.db.models import (
    Answer,
    AnswerKind,
    AnswerOutcome,
    AnswerStatus,
    Role,
    Setting,
    User,
)
from tests.asking import add_doc, ask, data_of, new_chat
from tests.conftest import UserFactory, sign_in
from tests.fakes import FakeAnswerer, FakeStore

PRICING = "The Pro plan costs $900 per month and includes weekly posts."
QUESTION = "What does the Pro plan cost per month?"


def asked(me: tuple[TestClient, User], db: Session, store: FakeStore) -> tuple[Any, Answer]:
    client, user = me
    add_doc(db, store, user, "Pricing.pdf", [PRICING])
    evs = ask(client, new_chat(client), QUESTION)
    db.expire_all()
    return evs, db.scalars(select(Answer)).one()


# --- confidence on real answers ----------------------------------------------------------


def test_a_well_supported_answer_is_high_and_needs_no_review(
    me: tuple[TestClient, User], db: Session, store: FakeStore, answerer: FakeAnswerer
) -> None:
    evs, answer = asked(me, db, store)

    assert answer.outcome == AnswerOutcome.HIGH
    assert answer.status == AnswerStatus.AUTO
    assert answer.confidence_parts is not None
    assert answer.confidence_parts["support"] == "full"
    [check] = answerer.checks
    assert "<answer>\nThe Pro plan costs $900 a month [1].\n</answer>" in check
    assert '<document index="1"' in check
    assert data_of(evs, "done")["outcome"] == "high"


def test_a_partly_supported_answer_is_low_and_goes_to_review(
    me: tuple[TestClient, User], db: Session, store: FakeStore, answerer: FakeAnswerer
) -> None:
    answerer.verdict = "partial"
    answerer.unsupported = ["$900 a month"]

    evs, answer = asked(me, db, store)

    assert answer.outcome == AnswerOutcome.LOW
    assert answer.status == AnswerStatus.IN_REVIEW
    assert answer.confidence is not None and answer.confidence < 75
    assert answer.confidence_parts is not None
    assert answer.confidence_parts["unsupported_claims"] == ["$900 a month"]
    assert data_of(evs, "confidence") == {
        "confidence": answer.confidence,
        "outcome": "low",
        "status": "in_review",
    }


@pytest.mark.parametrize("stop_reason", ["refusal", "max_tokens"])
def test_refused_or_cut_off_answers_score_zero_without_a_check(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    stop_reason: str,
) -> None:
    answerer.stop_reason = stop_reason

    _, answer = asked(me, db, store)

    assert (answer.confidence, answer.outcome, answer.status) == (
        0,
        AnswerOutcome.LOW,
        AnswerStatus.IN_REVIEW,
    )
    assert answer.confidence_parts is not None
    assert answer.confidence_parts["reason"] == stop_reason
    assert answerer.checks == []  # nothing worth checking


def test_a_failed_check_still_delivers_the_answer_but_as_low(
    me: tuple[TestClient, User], db: Session, store: FakeStore, answerer: FakeAnswerer
) -> None:
    answerer.verdict = None  # the check call raises

    evs, answer = asked(me, db, store)

    assert [name for name, _ in evs][-3:] == ["sources", "confidence", "done"]
    assert answer.outcome == AnswerOutcome.LOW
    assert answer.confidence_parts is not None
    assert answer.confidence_parts["reason"] == "check_failed"


def test_no_answer_is_never_scored(
    me: tuple[TestClient, User], db: Session, answerer: FakeAnswerer
) -> None:
    client, _ = me
    evs = ask(client, new_chat(client), "Who won the 1998 world cup?")

    answer = db.scalars(select(Answer)).one()
    assert (answer.outcome, answer.confidence) == (AnswerOutcome.NO_ANSWER, None)
    assert "confidence" not in [name for name, _ in evs]
    assert answerer.checks == []


def test_the_threshold_is_a_setting(
    me: tuple[TestClient, User], db: Session, store: FakeStore, answerer: FakeAnswerer
) -> None:
    db.add(Setting(key="confidence_threshold", value=95))
    db.commit()

    _, answer = asked(me, db, store)

    assert answer.confidence is not None and answer.confidence < 95
    assert answer.outcome == AnswerOutcome.LOW


def test_the_check_cost_is_added_to_the_answer(
    me: tuple[TestClient, User], db: Session, store: FakeStore
) -> None:
    _, answer = asked(me, db, store)

    assert answer.usage["check"]["requests"] == 1
    assert answer.usage["cost_usd"] > answer.usage["check"]["cost_usd"] > 0


# --- 👍 / 👎 -----------------------------------------------------------------------------


def test_thumbs_down_flags_the_answer_with_a_note(
    me: tuple[TestClient, User], db: Session, store: FakeStore
) -> None:
    client, _ = me
    _, answer = asked(me, db, store)

    response = client.post(
        f"/api/answers/{answer.id}/feedback", json={"value": "down", "note": " Wrong price "}
    )

    assert response.json() == {"feedback": "down", "flagged": True}
    db.refresh(answer)
    assert (answer.flagged, answer.flag_note) == (True, "Wrong price")
    # Changing your mind clears the flag and the note.
    client.post(f"/api/answers/{answer.id}/feedback", json={"value": "up"})
    db.refresh(answer)
    assert (answer.feedback, answer.flagged, answer.flag_note) == ("up", False, None)
    client.post(f"/api/answers/{answer.id}/feedback", json={"value": "none"})
    db.refresh(answer)
    assert answer.feedback is None


@pytest.mark.parametrize("role", list(Role))
def test_only_the_asker_can_give_feedback(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    ask_client: Callable[[], TestClient],
    make_user: UserFactory,
    role: Role,
) -> None:
    _, answer = asked(me, db, store)
    other = ask_client()
    sign_in(other, make_user(role).email)

    response = other.post(f"/api/answers/{answer.id}/feedback", json={"value": "down"})

    assert response.status_code == 404
    db.refresh(answer)
    assert answer.flagged is False


def test_feedback_validates_its_input(
    me: tuple[TestClient, User], db: Session, store: FakeStore
) -> None:
    client, _ = me
    _, answer = asked(me, db, store)
    assert (
        client.post(f"/api/answers/{answer.id}/feedback", json={"value": "meh"}).status_code == 422
    )


# --- the Answer Log ------------------------------------------------------------------------


def add_answer(db: Session, user: User | None, question: str, **fields: Any) -> Answer:
    answer = Answer(
        kind=fields.pop("kind", AnswerKind.CHAT),
        asked_by=user.id if user else None,
        question=question,
        retrieval_query=question,
        original_text=fields.pop("text", "An answer [1]."),
        current_text=fields.pop("current", fields.get("original_text", "An answer [1].")),
        **fields,
    )
    db.add(answer)
    db.commit()
    return answer


@pytest.fixture
def staff(
    ask_client: Callable[[], TestClient], make_user: UserFactory
) -> Callable[[Role], tuple[TestClient, User]]:
    def make(role: Role) -> tuple[TestClient, User]:
        client = ask_client()
        user = make_user(role, name=role.value.title())
        sign_in(client, user.email)
        return client, user

    return make


@pytest.mark.parametrize(
    ("role", "status", "can_review"),
    [(Role.OWNER, 200, True), (Role.REVIEWER, 200, False), (Role.USER, 403, None)],
)
def test_who_can_see_the_answer_log(
    staff: Callable[[Role], tuple[TestClient, User]],
    db: Session,
    role: Role,
    status: int,
    can_review: bool | None,
) -> None:
    client, user = staff(role)
    answer = add_answer(db, user, "How long does verification take?")

    for path in ("/api/answer-log", "/api/answer-log/gaps", f"/api/answer-log/{answer.id}"):
        assert client.get(path).status_code == status, path
    if can_review is not None:
        assert client.get("/api/answer-log").json()["can_review"] is can_review
        assert client.get(f"/api/answer-log/{answer.id}").json()["can_review"] is can_review


def test_filters_and_paging(
    staff: Callable[[Role], tuple[TestClient, User]], db: Session, make_user: UserFactory
) -> None:
    client, owner = staff(Role.OWNER)
    sara = make_user(Role.USER, name="Sara")
    add_answer(db, sara, "Price of Pro?", outcome=AnswerOutcome.HIGH, confidence=90)
    add_answer(
        db,
        sara,
        "GBP verification time?",
        outcome=AnswerOutcome.LOW,
        confidence=50,
        status=AnswerStatus.IN_REVIEW,
        flagged=True,
    )
    add_answer(db, owner, "Office dog's name?", outcome=AnswerOutcome.NO_ANSWER)
    add_answer(db, owner, "Old question", outcome=AnswerOutcome.HIGH, confidence=80).created_at = (
        now() - timedelta(days=40)
    )
    db.commit()

    def questions(**params: Any) -> list[str]:
        body = client.get("/api/answer-log", params=params).json()
        return [row["question"] for row in body["items"]]

    assert len(questions()) == 4
    assert questions(outcome="high") == ["Price of Pro?", "Old question"]
    assert questions(outcome="no_answer") == ["Office dog's name?"]
    assert questions(status="in_review") == ["GBP verification time?"]
    assert questions(flagged="true") == ["GBP verification time?"]
    assert sorted(questions(person=str(sara.id))) == ["GBP verification time?", "Price of Pro?"]
    assert questions(q="pro") == ["Price of Pro?"]
    assert questions(q="%") == []  # the search is literal text, not a pattern
    since = (now() - timedelta(days=7)).date().isoformat()
    assert "Old question" not in questions(date_from=since)
    assert client.get("/api/answer-log", params={"outcome": "bogus"}).status_code == 422

    body = client.get("/api/answer-log").json()
    assert body["total"] == 4
    assert [p["name"] for p in body["people"]] == ["Owner", "Sara"]
    row = body["items"][0]
    assert set(row) == {
        "id",
        "created_at",
        "asked_by",
        "kind",
        "question",
        "confidence",
        "outcome",
        "status",
        "flagged",
        "feedback",
        "source_count",
    }


def test_pages_hold_fifty_rows(
    staff: Callable[[Role], tuple[TestClient, User]], db: Session
) -> None:
    client, owner = staff(Role.OWNER)
    for n in range(53):
        db.add(
            Answer(
                kind=AnswerKind.CHAT,
                asked_by=owner.id,
                question=f"Q{n}",
                retrieval_query="q",
                original_text="a",
                current_text="a",
            )
        )
    db.commit()

    second = client.get("/api/answer-log", params={"page": 2}).json()
    assert (second["total"], len(second["items"]), second["page_size"]) == (53, 3, 50)


def test_stats_cover_this_month(
    staff: Callable[[Role], tuple[TestClient, User]], db: Session
) -> None:
    client, owner = staff(Role.OWNER)
    add_answer(db, owner, "a", outcome=AnswerOutcome.HIGH)
    add_answer(db, owner, "b", outcome=AnswerOutcome.HIGH)
    add_answer(db, owner, "c", outcome=AnswerOutcome.LOW, status=AnswerStatus.CORRECTED)
    add_answer(db, owner, "d", outcome=AnswerOutcome.NO_ANSWER)
    old = add_answer(db, owner, "e", outcome=AnswerOutcome.LOW)
    old.created_at = now() - timedelta(days=62)
    db.commit()

    stats = client.get("/api/answer-log").json()["stats"]
    assert stats == {
        "answers_this_month": 4,
        "high_pct": 67,  # 2 of the 3 scored answers
        "corrected_pct": 25,
        "avg_review_minutes": None,
    }


def test_detail_explains_the_score(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    staff: Callable[[Role], tuple[TestClient, User]],
    answerer: FakeAnswerer,
) -> None:
    answerer.verdict = "partial"
    _, answer = asked(me, db, store)
    client, _ = staff(Role.REVIEWER)

    body = client.get(f"/api/answer-log/{answer.id}").json()

    assert body["explanation"].startswith("Search match ")
    assert body["explanation"].endswith(" · Support: partial")
    assert body["asked_by"]["name"] == "Sara"
    assert body["sources"][0]["file_name"] == "Pricing.pdf"
    assert body["original_text"] == body["current_text"]
    assert body["cost_usd"] > 0
    assert client.get("/api/answer-log/00000000-0000-0000-0000-000000000000").status_code == 404


def test_knowledge_gaps_group_similar_questions(
    staff: Callable[[Role], tuple[TestClient, User]], db: Session
) -> None:
    client, owner = staff(Role.OWNER)
    for question in (
        "What is the office wifi password?",
        "office wifi password?",
        "What's the wifi password at the office",
        "Who is our accountant?",
    ):
        add_answer(db, owner, question, outcome=AnswerOutcome.NO_ANSWER)
    add_answer(db, owner, "Is GBP free?", status=AnswerStatus.WRONG_NO_ANSWER)
    add_answer(db, owner, "Pro price?", outcome=AnswerOutcome.HIGH)  # answered: not a gap
    add_answer(db, owner, "Ancient", outcome=AnswerOutcome.NO_ANSWER).created_at = (
        now() - timedelta(days=120)
    )
    db.commit()

    gaps = client.get("/api/answer-log/gaps").json()

    assert [(g["count"], len(g["answer_ids"])) for g in gaps] == [(3, 3), (1, 1), (1, 1)]
    assert {g["question"] for g in gaps[1:]} == {"Who is our accountant?", "Is GBP free?"}
    assert len(gaps[0]["examples"]) == 3
