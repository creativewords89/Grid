"""Verified answers and delivering reviewed answers (SPEC sections 6.8 and 6.9)."""

from collections.abc import Callable
from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.auth.tokens import now
from app.db.models import (
    Answer,
    AnswerStatus,
    KbOp,
    KbOpState,
    Review,
    ReviewReason,
    Role,
    Setting,
    TrashItem,
    User,
    VerifiedAnswer,
    VerifiedOrigin,
    VerifiedStatus,
)
from app.kb import sync
from app.kb.reconcile import reconcile
from app.kb.store import VERIFIED
from tests.asking import add_doc, ask, data_of, new_chat
from tests.conftest import RunJobs, UserFactory, sign_in
from tests.fakes import FakeAnswerer, FakeStore, FakeTelegram

PRICING = "The Pro plan costs $900 per month and includes weekly posts."
QUESTION = "What does the Pro plan cost per month?"


@pytest.fixture
def web(ask_client: Callable[[], TestClient]) -> Callable[[User], TestClient]:
    def make(user: User) -> TestClient:
        c = ask_client()
        sign_in(c, user.email)
        return c

    return make


@pytest.fixture
def reviewer(make_user: UserFactory) -> User:
    return make_user(Role.REVIEWER, name="Ali")


@pytest.fixture
def owner(make_user: UserFactory) -> User:
    return make_user(Role.OWNER, name="Olivia")


def low(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    question: str = QUESTION,
    doc: bool = True,
) -> tuple[Answer, Review]:
    client, user = me
    answerer.verdict = "partial"
    if doc:
        add_doc(db, store, user, "Pricing.pdf", [PRICING])
    ask(client, new_chat(client), question)
    db.expire_all()
    answer = db.scalars(select(Answer).order_by(Answer.created_at.desc())).first()
    assert answer is not None
    review = db.scalars(select(Review).where(Review.answer_id == answer.id)).one()
    return answer, review


def ops(db: Session, namespace: str = VERIFIED) -> list[tuple[str, list[str]]]:
    rows = db.scalars(select(KbOp).where(KbOp.namespace == namespace).order_by(KbOp.seq))
    return [(op.op.value, op.record_ids) for op in rows]


def send(clean_engine: Engine, store: FakeStore) -> None:
    sync.process(sessionmaker(bind=clean_engine, expire_on_commit=False), store)


def decide(client: TestClient, review: Review, **body: Any) -> Any:
    return client.post(f"/api/reviews/{review.id}/decide", json=body)


# --- creating verified answers ------------------------------------------------------------


def test_approve_creates_a_verified_answer_and_queues_it_for_search(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    reviewer: User,
    web: Callable[[User], TestClient],
    clean_engine: Engine,
) -> None:
    answer, review = low(me, db, store, answerer)

    assert decide(web(reviewer), review, action="approve").status_code == 200

    va = db.scalars(select(VerifiedAnswer)).one()
    assert (va.question, va.answer) == (QUESTION, "The Pro plan costs $900 a month.")
    assert (va.origin, va.origin_answer_id, va.approved_by) == (
        VerifiedOrigin.REVIEW,
        answer.id,
        reviewer.id,
    )
    assert [str(i) for i in va.source_file_ids] == [answer.sources[0]["file_id"]]
    assert ops(db) == [("upsert", [f"va_{va.id}"])]
    send(clean_engine, store)
    assert store.data[VERIFIED][f"va_{va.id}"] == {
        "_id": f"va_{va.id}",
        "text": f"Q: {QUESTION}\nA: The Pro plan costs $900 a month.",
        "verified_answer_id": str(va.id),
    }


def test_a_correction_is_what_gets_verified(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    reviewer: User,
    web: Callable[[User], TestClient],
) -> None:
    _, review = low(me, db, store, answerer)
    decide(web(reviewer), review, action="edit", text="Pro is $950 a month from November.")
    va = db.scalars(select(VerifiedAnswer)).one()
    assert va.answer == "Pro is $950 a month from November."


def test_no_answer_known_verifies_nothing(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    reviewer: User,
    web: Callable[[User], TestClient],
) -> None:
    _, review = low(me, db, store, answerer)
    decide(web(reviewer), review, action="reject")  # no text: refused
    decide(web(reviewer), review, action="no_answer")
    assert db.scalars(select(VerifiedAnswer)).all() == []


def test_a_follow_up_is_verified_as_its_standalone_question(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    reviewer: User,
    web: Callable[[User], TestClient],
) -> None:
    client, user = me
    add_doc(db, store, user, "Pricing.pdf", [PRICING])
    chat = new_chat(client)
    ask(client, chat, QUESTION)
    answerer.verdict = "partial"
    answerer.rewritten = "How much does the Pro plan cost per year?"
    ask(client, chat, "and per year?")
    review = db.scalars(select(Review)).one()

    decide(web(reviewer), review, action="approve")

    assert db.scalars(select(VerifiedAnswer)).one().question == (
        "How much does the Pro plan cost per year?"
    )


# --- near-duplicates ------------------------------------------------------------------------


def existing_verified(db: Session, store: FakeStore, question: str = QUESTION) -> VerifiedAnswer:
    va = VerifiedAnswer(
        question=question,
        answer="Pro is $900 a month.",
        origin=VerifiedOrigin.REVIEW,
        source_file_ids=[],
    )
    db.add(va)
    db.commit()
    store.data.setdefault(VERIFIED, {})[va.record_id] = {
        "_id": va.record_id,
        "text": f"Q: {question}\nA: Pro is $900 a month.",
    }
    return va


def test_the_web_asks_before_adding_a_duplicate(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    reviewer: User,
    web: Callable[[User], TestClient],
) -> None:
    _, review = low(me, db, store, answerer)
    old = existing_verified(db, store)
    ali = web(reviewer)

    asked = decide(ali, review, action="edit", text="Pro is $950 a month.")

    assert asked.status_code == 409
    error = asked.json()["error"]
    assert (error["code"], error["details"]["id"]) == ("duplicate", str(old.id))
    db.refresh(review)
    assert review.state.value == "open"  # nothing changed while asking

    done = decide(
        ali, review, action="edit", text="Pro is $950 a month.", verified_choice=f"update:{old.id}"
    )
    assert done.status_code == 200
    db.refresh(old)
    assert (old.answer, old.version) == ("Pro is $950 a month.", 2)
    assert len(db.scalars(select(VerifiedAnswer)).all()) == 1


def test_choosing_new_adds_a_second_one(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    reviewer: User,
    web: Callable[[User], TestClient],
) -> None:
    _, review = low(me, db, store, answerer)
    existing_verified(db, store)
    decide(web(reviewer), review, action="approve", verified_choice="new")
    assert len(db.scalars(select(VerifiedAnswer)).all()) == 2


def test_telegram_updates_the_duplicate_and_says_so(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    telegram: FakeTelegram,
    run_jobs: RunJobs,
    client: TestClient,
    make_user: UserFactory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from tests.test_reviews import ALI_TG, GROUP, press

    db.add(Setting(key="telegram_group_chat_id", value=GROUP))
    ali = make_user(Role.REVIEWER, name="Ali")
    ali.telegram_user_id = ALI_TG
    db.commit()
    monkeypatch.setattr("app.reviews.bot.get_store", lambda: store)
    _, review = low(me, db, store, answerer)
    old = existing_verified(db, store)
    run_jobs()
    db.refresh(review)

    press(client, ALI_TG, review, "approve")

    db.refresh(old)
    assert old.version == 2
    assert len(db.scalars(select(VerifiedAnswer)).all()) == 1
    assert "I updated it instead of adding another" in telegram.sent[-1]["text"]


# --- verified answers in answering -----------------------------------------------------------


def test_a_verified_answer_is_used_first_and_marked(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
) -> None:
    client, user = me
    add_doc(db, store, user, "Pricing.pdf", [PRICING])
    va = existing_verified(db, store, question="What does the Pro plan cost per month?")
    answerer.reply = "Pro costs $900 a month [1]."

    evs = ask(client, new_chat(client), QUESTION)

    prompt = answerer.prompts[0]
    assert '<document index="1" source="Team-verified answer" verified="true">' in prompt
    assert f"Q: {QUESTION}\nA: Pro is $900 a month." in prompt
    assert '<document index="2" source="Pricing.pdf · p.1' in prompt
    [source] = data_of(evs, "sources")["sources"]
    assert (source["kind"], source["ref_id"], source["label"]) == (
        "verified",
        va.record_id,
        "✔ Verified answer",
    )
    answer = db.scalars(select(Answer)).one()
    # The verified answer matched at 1.0 (≥ 0.90) and the check found full support: 95.
    assert answer.confidence == 95
    assert answer.confidence_parts is not None and answer.confidence_parts["verified_hit"]


@pytest.mark.parametrize("state", ["disabled", "expired", "deleted"])
def test_inactive_verified_answers_are_never_used(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    state: str,
) -> None:
    client, user = me
    add_doc(db, store, user, "Pricing.pdf", [PRICING])
    va = existing_verified(db, store)
    if state == "disabled":
        va.status = VerifiedStatus.DISABLED
    elif state == "expired":
        va.expires_at = now() - timedelta(minutes=1)  # not yet marked by the nightly job
    else:
        va.deleted_at = now()
    db.commit()

    ask(client, new_chat(client), QUESTION)

    assert "verified" not in answerer.prompts[0]


# --- managing them ------------------------------------------------------------------------------


@pytest.fixture
def va(db: Session, store: FakeStore) -> VerifiedAnswer:
    return existing_verified(db, store)


def test_lifecycle_sync_ops(
    va: VerifiedAnswer,
    db: Session,
    owner: User,
    web: Callable[[User], TestClient],
    run_jobs: RunJobs,
) -> None:
    client = web(owner)
    rid, va_id = va.record_id, va.id
    base = f"/api/verified/{va_id}"

    client.patch(base, json={"answer": "Pro is $950 a month."})
    client.post(f"{base}/disable")
    client.post(f"{base}/enable")
    client.patch(base, json={"expires_at": (now() - timedelta(days=1)).isoformat()})
    assert client.get(base).json()["status"] == "expired"
    assert client.post(f"{base}/enable").status_code == 422  # change the date first
    client.patch(base, json={"clear_expiry": True})
    assert client.delete(base).status_code == 204
    item = db.scalars(select(TrashItem)).one()
    client.post(f"/api/trash/{item.id}/restore")
    client.delete(base)
    db.expire_all()
    item = db.scalars(select(TrashItem)).one()
    client.delete(f"/api/trash/{item.id}")

    assert ops(db) == [
        ("upsert", [rid]),  # edited
        ("delete", [rid]),  # disabled
        ("upsert", [rid]),  # enabled
        ("delete", [rid]),  # expiry date passed
        ("upsert", [rid]),  # expiry cleared
        ("delete", [rid]),  # deleted (to trash)
        ("upsert", [rid]),  # restored
        ("delete", [rid]),  # deleted again
        ("delete", [rid]),  # purged
    ]
    db.expire_all()
    assert db.get(VerifiedAnswer, va_id) is None


def test_expiry_job(va: VerifiedAnswer, db: Session, run_jobs: RunJobs) -> None:
    from app.jobs.queue import enqueue

    va.expires_at = now() - timedelta(hours=1)
    db.commit()
    enqueue(db, "verified_expiry")
    db.commit()
    run_jobs()
    db.refresh(va)
    assert va.status == VerifiedStatus.EXPIRED
    assert ops(db) == [("delete", [va.record_id])]


def test_history_and_restoring_a_version(
    va: VerifiedAnswer, owner: User, web: Callable[[User], TestClient], db: Session
) -> None:
    client = web(owner)
    base = f"/api/verified/{va.id}"
    client.patch(base, json={"answer": "Second answer."})
    client.patch(base, json={"question": "Pro price per month?", "answer": "Third answer."})

    history = client.get(f"{base}/history").json()
    assert [(v["version"], v["answer"]) for v in history] == [
        (3, "Third answer."),
        (2, "Second answer."),
    ]
    assert history[0]["changed_by"]["name"] == "Olivia"

    restored = client.post(f"{base}/restore-version", json={"version": 2}).json()
    assert (restored["answer"], restored["version"]) == ("Second answer.", 4)
    assert client.post(f"{base}/restore-version", json={"version": 9}).status_code == 404


@pytest.mark.parametrize(("role", "manage"), [(Role.USER, False), (Role.REVIEWER, True)])
def test_who_can_manage(
    va: VerifiedAnswer,
    make_user: UserFactory,
    web: Callable[[User], TestClient],
    role: Role,
    manage: bool,
) -> None:
    client = web(make_user(role))
    base = f"/api/verified/{va.id}"

    page = client.get("/api/verified").json()
    assert [r["question"] for r in page["items"]] == [QUESTION]
    assert page["can_manage"] is manage
    assert client.get(base).status_code == 200
    expected = 200 if manage else 403
    assert client.patch(base, json={"answer": "x y z"}).status_code == expected
    assert client.post(f"{base}/disable").status_code == expected
    assert client.get(f"{base}/history").status_code == 200
    assert client.delete(base).status_code == (204 if manage else 403)


def test_filters_and_search(
    db: Session, store: FakeStore, owner: User, web: Callable[[User], TestClient]
) -> None:
    a = existing_verified(db, store, "How long does GBP verification take?")
    b = existing_verified(db, store, "What is the Pro plan price?")
    b.status = VerifiedStatus.DISABLED
    c = existing_verified(db, store, "Do we offer refunds?")
    c.needs_check = True
    db.commit()
    client = web(owner)

    def questions(**params: str) -> list[str]:
        return sorted(
            r["question"] for r in client.get("/api/verified", params=params).json()["items"]
        )

    assert questions() == sorted([a.question, c.question])
    assert questions(show="disabled") == [b.question]
    assert questions(show="needs_check") == [c.question]
    assert questions(q="gbp") == [a.question]
    assert client.get("/api/verified").json()["counts"] == {
        "active": 2,
        "disabled": 1,
        "expired": 0,
        "needs_check": 1,
        "all": 3,
    }


def test_a_deleted_source_flags_the_answer_for_checking(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    reviewer: User,
    owner: User,
    web: Callable[[User], TestClient],
) -> None:
    _, review = low(me, db, store, answerer)
    decide(web(reviewer), review, action="approve")
    va = db.scalars(select(VerifiedAnswer)).one()
    file_id = va.source_file_ids[0]
    client = web(owner)

    assert client.delete(f"/api/files/{file_id}").status_code == 204

    db.refresh(va)
    assert (va.needs_check, va.needs_check_reason, va.status) == (
        True,
        "Source deleted: Pricing.pdf",
        VerifiedStatus.ACTIVE,
    )
    detail = client.get(f"/api/verified/{va.id}").json()
    assert detail["sources"] == [
        {"file_id": str(file_id), "name": "Pricing.pdf", "available": False}
    ]
    client.patch(f"/api/verified/{va.id}", json={"checked": True})
    db.refresh(va)
    assert (va.needs_check, va.needs_check_reason) == (False, None)


def test_reconcile_covers_verified_answers(
    va: VerifiedAnswer, db: Session, store: FakeStore
) -> None:
    store.data[VERIFIED] = {"va_stray": {"_id": "va_stray"}}
    reconcile(db, store, rebuild=False, by=None)
    assert ops(db) == [("upsert", [va.record_id]), ("delete", ["va_stray"])]


# --- delivering reviewed answers ---------------------------------------------------------------


def test_the_asker_sees_the_correction_once_with_the_original(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    reviewer: User,
    owner: User,
    web: Callable[[User], TestClient],
) -> None:
    asker, _ = me
    answer, review = low(me, db, store, answerer)
    chat_id = str(answer.conversation_id)
    asker.post(f"/api/conversations/{chat_id}/ask", json={"question": "Thanks, and setup?"})
    assert asker.get("/api/conversations").json()[0]["updated"] is False

    decide(web(reviewer), review, action="edit", text="Pro is $950 a month.")
    # The Owner looking doesn't count as the asker seeing it.
    assert web(owner).get(f"/api/conversations/{chat_id}").status_code == 200

    [row] = asker.get("/api/conversations").json()
    assert row["updated"] is True
    first = asker.get(f"/api/conversations/{chat_id}").json()
    assert first["updated_answer_ids"] == [str(answer.id)]
    corrected = next(
        m for m in first["messages"] if m["answer"] and m["answer"]["id"] == str(answer.id)
    )
    assert corrected["body"] == "Pro is $950 a month."
    assert corrected["answer"]["original_text"] == "The Pro plan costs $900 a month [1]."
    assert corrected["answer"]["reviewed_at"] is not None
    second = asker.get(f"/api/conversations/{chat_id}").json()
    assert (second["updated"], second["updated_answer_ids"]) == (False, [])
    assert asker.get("/api/conversations").json()[0]["updated"] is False


def test_follow_ups_use_the_corrected_answer(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    reviewer: User,
    web: Callable[[User], TestClient],
) -> None:
    asker, _ = me
    answer, review = low(me, db, store, answerer)
    decide(web(reviewer), review, action="edit", text="Pro is $950 a month [1].")

    ask(asker, str(answer.conversation_id), "and per year?")

    assert answerer.histories[-1][-1] == {"role": "assistant", "content": "Pro is $950 a month."}


# --- the Owner's review from the Answer Log ----------------------------------------------------


def test_the_owner_corrects_a_high_answer(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    owner: User,
    web: Callable[[User], TestClient],
    telegram: FakeTelegram,
    run_jobs: RunJobs,
) -> None:
    client, user = me
    add_doc(db, store, user, "Pricing.pdf", [PRICING])
    ask(client, new_chat(client), QUESTION)  # high: no review
    answer = db.scalars(select(Answer)).one()
    assert db.scalars(select(Review)).all() == []

    response = web(owner).post(
        f"/api/answers/{answer.id}/admin-review",
        json={"action": "edit", "text": "Pro is $950 now.", "note": "price rise"},
    )
    run_jobs()

    assert response.json()["status"] == "corrected"
    review = db.scalars(select(Review)).one()
    assert (review.reason, review.decided_by, review.note) == (
        ReviewReason.ADMIN,
        owner.id,
        "price rise",
    )
    assert telegram.sent == []  # Owner reviews never go to Telegram
    va = db.scalars(select(VerifiedAnswer)).one()
    assert (va.origin, va.answer) == (VerifiedOrigin.ADMIN, "Pro is $950 now.")
    db.refresh(answer)
    assert answer.delivered_at is not None


def test_correcting_again_updates_the_same_verified_answer(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    reviewer: User,
    owner: User,
    web: Callable[[User], TestClient],
) -> None:
    answer, review = low(me, db, store, answerer)
    decide(web(reviewer), review, action="approve")
    boss = web(owner)

    boss.post(f"/api/answers/{answer.id}/admin-review", json={"action": "edit", "text": "New."})
    [va] = db.scalars(select(VerifiedAnswer)).all()
    db.refresh(va)
    assert (va.answer, va.version) == ("New.", 2)

    boss.post(f"/api/answers/{answer.id}/admin-review", json={"action": "no_answer"})
    db.refresh(va)
    db.refresh(answer)
    assert va.status == VerifiedStatus.DISABLED
    assert answer.status == AnswerStatus.WRONG_NO_ANSWER


def test_the_owner_takes_over_a_waiting_review(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    reviewer: User,
    owner: User,
    web: Callable[[User], TestClient],
) -> None:
    answer, review = low(me, db, store, answerer)
    web(reviewer).post(f"/api/reviews/{review.id}/claim")

    web(owner).post(f"/api/answers/{answer.id}/admin-review", json={"action": "approve"})

    db.refresh(review)
    assert (review.state.value, review.decided_by) == ("approved", owner.id)
    assert len(db.scalars(select(Review)).all()) == 1


@pytest.mark.parametrize("role", [Role.USER, Role.REVIEWER])
def test_only_owners_review_from_the_log(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    make_user: UserFactory,
    web: Callable[[User], TestClient],
    role: Role,
) -> None:
    answer, _ = low(me, db, store, answerer)
    response = web(make_user(role)).post(
        f"/api/answers/{answer.id}/admin-review", json={"action": "approve"}
    )
    assert response.status_code == 403


def test_kb_ops_are_written_in_the_same_transaction(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    reviewer: User,
    web: Callable[[User], TestClient],
) -> None:
    _, review = low(me, db, store, answerer)
    # A refused decision leaves no op behind.
    decide(web(reviewer), review, action="edit", text="")
    assert ops(db) == []
    decide(web(reviewer), review, action="approve")
    assert [
        state for (state,) in db.execute(select(KbOp.state).where(KbOp.namespace == VERIFIED))
    ] == [KbOpState.PENDING]
