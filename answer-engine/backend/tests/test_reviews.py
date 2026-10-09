"""Reviews in Telegram and on the web (SPEC section 6.7), with a fake Telegram API."""

import threading
from collections.abc import Callable
from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app import cli
from app.auth.tokens import now
from app.db.models import (
    Answer,
    AnswerStatus,
    AuditEntry,
    Review,
    ReviewReason,
    ReviewState,
    Role,
    Setting,
    User,
)
from app.jobs.queue import enqueue
from app.reviews import service
from app.reviews.bot import NOT_LINKED
from app.reviews.service import ReviewError
from tests.asking import add_doc, ask, new_chat
from tests.conftest import WEBHOOK_SECRET, FakeMailer, RunJobs, UserFactory, sign_in
from tests.fakes import FakeAnswerer, FakeStore, FakeTelegram

GROUP = -1001234567890
PRICING = "The Pro plan costs $900 per month and includes weekly posts."
ALI_TG, BEA_TG, SARA_TG, STRANGER_TG = 5001, 5002, 5003, 5999


@pytest.fixture
def group(db: Session) -> int:
    db.add(Setting(key="telegram_group_chat_id", value=GROUP))
    db.commit()
    return GROUP


@pytest.fixture
def ali(make_user: UserFactory, db: Session) -> User:
    user = make_user(Role.REVIEWER, name="Ali")
    user.telegram_user_id = ALI_TG
    db.commit()
    return user


@pytest.fixture
def bea(make_user: UserFactory, db: Session) -> User:
    user = make_user(Role.OWNER, name="Bea")
    user.telegram_user_id = BEA_TG
    db.commit()
    return user


def low_answer(
    me: tuple[TestClient, User], db: Session, store: FakeStore, answerer: FakeAnswerer
) -> tuple[Answer, Review]:
    client, user = me
    answerer.verdict = "partial"
    add_doc(db, store, user, "Pricing.pdf", [PRICING])
    ask(client, new_chat(client), "What does the Pro plan cost per month?")
    db.expire_all()
    answer = db.scalars(select(Answer)).one()
    review = db.scalars(select(Review)).one()
    return answer, review


def hook(client: TestClient, update: dict[str, Any], secret: str = WEBHOOK_SECRET) -> Any:
    return client.post(
        "/api/telegram/webhook",
        json=update,
        headers={"X-Telegram-Bot-Api-Secret-Token": secret},
    )


def press(client: TestClient, who: int, review: Review, action: str, chat: int = GROUP) -> None:
    update = {
        "update_id": 1,
        "callback_query": {
            "id": f"cb-{who}-{action}",
            "from": {"id": who, "first_name": "x"},
            "message": {"message_id": review.telegram_message_id, "chat": {"id": chat}},
            "data": f"rv:{review.id}:{action}",
        },
    }
    assert hook(client, update).status_code == 200


def reply(client: TestClient, who: int, to: int, text: str, chat: int = GROUP) -> None:
    update = {
        "update_id": 2,
        "message": {
            "message_id": 9000 + to,
            "from": {"id": who, "first_name": "x"},
            "chat": {"id": chat, "type": "supergroup", "title": "Reviewers"},
            "text": text,
            "reply_to_message": {"message_id": to},
        },
    }
    assert hook(client, update).status_code == 200


def private(client: TestClient, who: int, text: str) -> None:
    update = {
        "update_id": 3,
        "message": {
            "message_id": 1,
            "from": {"id": who, "first_name": "x"},
            "chat": {"id": who, "type": "private"},
            "text": text,
        },
    }
    assert hook(client, update).status_code == 200


Asked = tuple[Answer, Review]


@pytest.fixture
def posted(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    telegram: FakeTelegram,
    group: int,
    run_jobs: RunJobs,
) -> Asked:
    """A low-confidence answer whose review has been posted to the group."""
    answer, review = low_answer(me, db, store, answerer)
    run_jobs()
    db.refresh(review)
    return answer, review


# --- creating and posting reviews ------------------------------------------------------------


def test_a_low_answer_is_posted_to_the_group(posted: Asked, telegram: FakeTelegram) -> None:
    answer, review = posted

    assert (review.reason, review.state) == (ReviewReason.LOW_CONFIDENCE, ReviewState.OPEN)
    [card] = telegram.sent
    assert card["chat"] == GROUP
    assert review.telegram_message_id == card["id"]
    assert card["text"].startswith(
        f"🔎 <b>Review needed</b> · #R-{review.number} · Low confidence ({answer.confidence})"
    )
    assert "From: Sara · Chat" in card["text"]
    assert "<b>Q:</b> What does the Pro plan cost per month?" in card["text"]
    assert "<b>A:</b> The Pro plan costs $900 a month [1]." in card["text"]
    assert "Sources: [1] Pricing.pdf · p.1" in card["text"]
    assert telegram.buttons(card) == [
        f"rv:{review.id}:approve",
        f"rv:{review.id}:edit",
        f"rv:{review.id}:reject",
        f"rv:{review.id}:needs_info",
    ]  # no Open button: the test APP_URL isn't https


def test_no_answer_is_posted_with_answer_buttons(
    me: tuple[TestClient, User],
    db: Session,
    telegram: FakeTelegram,
    group: int,
    run_jobs: RunJobs,
) -> None:
    client, _ = me
    ask(client, new_chat(client), "Who is the office dog?")
    run_jobs()

    review = db.scalars(select(Review)).one()
    assert review.reason == ReviewReason.NO_ANSWER
    assert "No answer found" in telegram.sent[0]["text"]
    assert telegram.buttons(telegram.sent[0]) == [
        f"rv:{review.id}:edit",
        f"rv:{review.id}:noanswer",
        f"rv:{review.id}:needs_info",
    ]


def test_people_and_documents_are_escaped_and_long_answers_shortened(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    telegram: FakeTelegram,
    group: int,
    run_jobs: RunJobs,
) -> None:
    client, user = me
    answerer.verdict = "none"
    answerer.reply = "<b>bold</b> & " + "very long " * 1000 + "[1]"
    add_doc(db, store, user, "Pricing.pdf", [PRICING])
    ask(client, new_chat(client), "Pro plan <script>cost</script>?")
    run_jobs()

    text = telegram.sent[0]["text"]
    assert "&lt;script&gt;cost&lt;/script&gt;" in text
    assert "&lt;b&gt;bold&lt;/b&gt; &amp;" in text
    assert len(text) <= 4096
    assert "(shortened: open the review for the full answer)" in text


def test_without_telegram_reviews_wait_in_the_web_queue(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    run_jobs: RunJobs,
) -> None:
    _, review = low_answer(me, db, store, answerer)
    run_jobs()
    db.refresh(review)
    assert (review.state, review.telegram_message_id) == (ReviewState.OPEN, None)


def test_one_undecided_review_per_answer(posted: Asked, db: Session) -> None:
    answer, review = posted
    assert service.create(db, answer, ReviewReason.FLAG).id == review.id


# --- the webhook --------------------------------------------------------------------------


@pytest.mark.parametrize("secret", ["", "wrong-secret"])
def test_the_webhook_needs_the_secret(
    client: TestClient, telegram: FakeTelegram, secret: str
) -> None:
    assert hook(client, {"update_id": 1}, secret=secret).status_code == 403


def test_the_webhook_is_closed_until_a_secret_is_set(client: TestClient) -> None:
    assert hook(client, {"update_id": 1}, secret="").status_code == 403


# --- buttons --------------------------------------------------------------------------------


def test_approve_in_one_tap(
    posted: Asked,
    ali: User,
    client: TestClient,
    db: Session,
    telegram: FakeTelegram,
    run_jobs: RunJobs,
) -> None:
    answer, review = posted
    press(client, ALI_TG, review, "approve")
    run_jobs()

    db.refresh(review)
    db.refresh(answer)
    assert (review.state, review.decided_by, review.claimed_by) == (
        ReviewState.APPROVED,
        ali.id,
        ali.id,
    )
    assert answer.status == AnswerStatus.VERIFIED
    assert telegram.toasts[-1] == (f"cb-{ALI_TG}-approve", "✅ Approved")
    [edit] = telegram.edits
    assert edit["id"] == review.telegram_message_id
    assert "\n\n✅ Approved by Ali · " in edit["text"]
    assert edit["markup"] is None  # the buttons are removed
    entry = db.scalars(select(AuditEntry).where(AuditEntry.action == "review_approve")).one()
    assert entry.actor_id == ali.id


def test_a_second_reviewer_is_told_who_has_it(
    posted: Asked, ali: User, bea: User, client: TestClient, db: Session, telegram: FakeTelegram
) -> None:
    _, review = posted
    press(client, ALI_TG, review, "edit")
    press(client, BEA_TG, review, "approve")

    db.refresh(review)
    assert (review.state, review.claimed_by) == (ReviewState.CLAIMED, ali.id)
    assert telegram.toasts[-1] == (f"cb-{BEA_TG}-approve", "Ali is handling this.")


def test_claiming_is_atomic(
    posted: Asked, ali: User, bea: User, clean_engine: Engine, db: Session
) -> None:
    _, review = posted
    barrier = threading.Barrier(2)
    results: dict[str, str] = {}

    def grab(user: User) -> None:
        with Session(clean_engine) as session:
            person = session.get(User, user.id)
            assert person is not None
            barrier.wait()
            try:
                service.claim(session, review.id, person)
                session.commit()
                results[user.name] = "won"
            except ReviewError as error:
                session.rollback()
                results[user.name] = error.code

    threads = [threading.Thread(target=grab, args=(u,)) for u in (ali, bea)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert sorted(results.values()) == ["taken", "won"]
    db.refresh(review)
    winner = ali if results["Ali"] == "won" else bea
    assert review.claimed_by == winner.id


@pytest.mark.parametrize("who", ["stranger", "user", "deactivated"])
def test_unlinked_or_non_reviewer_presses_are_ignored(
    posted: Asked,
    client: TestClient,
    db: Session,
    telegram: FakeTelegram,
    make_user: UserFactory,
    who: str,
) -> None:
    _, review = posted
    if who == "user":
        make_user(Role.USER).telegram_user_id = STRANGER_TG
    elif who == "deactivated":
        make_user(Role.REVIEWER, active=False).telegram_user_id = STRANGER_TG
    db.commit()

    press(client, STRANGER_TG, review, "approve")

    db.refresh(review)
    assert review.state == ReviewState.OPEN
    assert telegram.toasts[-1][1] == NOT_LINKED


def test_buttons_only_work_in_the_review_group(
    posted: Asked, ali: User, client: TestClient, db: Session, telegram: FakeTelegram
) -> None:
    _, review = posted
    press(client, ALI_TG, review, "approve", chat=-1009999)
    db.refresh(review)
    assert review.state == ReviewState.OPEN
    assert telegram.toasts[-1][1] == "This isn't the review group."


def test_a_decided_review_says_so(
    posted: Asked, ali: User, bea: User, client: TestClient, telegram: FakeTelegram
) -> None:
    _, review = posted
    press(client, ALI_TG, review, "approve")
    press(client, BEA_TG, review, "approve")
    assert telegram.toasts[-1][1] == f"#R-{review.number} has already been decided."


# --- replies --------------------------------------------------------------------------------


def test_edit_by_replying_to_the_bot(
    posted: Asked,
    ali: User,
    client: TestClient,
    me: tuple[TestClient, User],
    db: Session,
    telegram: FakeTelegram,
    run_jobs: RunJobs,
) -> None:
    answer, review = posted
    press(client, ALI_TG, review, "edit")
    prompt = telegram.sent[-1]
    assert (
        prompt["text"]
        == f"✏️ Ali: reply to this message with the corrected answer for #R-{review.number}."
    )
    assert prompt["reply_to"] == review.telegram_message_id
    assert prompt["markup"]["force_reply"] is True

    reply(client, ALI_TG, prompt["id"], "The Pro plan costs $950 a month from November.")
    run_jobs()

    db.refresh(answer)
    db.refresh(review)
    assert answer.current_text == "The Pro plan costs $950 a month from November."
    assert answer.original_text == "The Pro plan costs $900 a month [1]."
    assert answer.status == AnswerStatus.CORRECTED
    assert (review.state, review.final_text) == (
        ReviewState.EDITED,
        "The Pro plan costs $950 a month from November.",
    )
    assert "✏️ Corrected by Ali" in telegram.edits[-1]["text"]
    # The asker's chat shows the corrected text.
    asker, _ = me
    chat = asker.get(f"/api/conversations/{answer.conversation_id}").json()
    reply_msg = chat["messages"][-1]
    assert reply_msg["body"] == "The Pro plan costs $950 a month from November."
    assert reply_msg["answer"]["corrected"] is True
    assert reply_msg["answer"]["status"] == "corrected"


def test_only_the_claimer_can_answer_the_prompt(
    posted: Asked, ali: User, bea: User, client: TestClient, db: Session, telegram: FakeTelegram
) -> None:
    answer, review = posted
    press(client, ALI_TG, review, "edit")
    prompt = telegram.sent[-1]

    reply(client, BEA_TG, prompt["id"], "Bea's text")
    reply(client, STRANGER_TG, prompt["id"], "A stranger's text")

    db.refresh(answer)
    assert answer.status == AnswerStatus.IN_REVIEW
    assert telegram.sent[-1]["text"] == "Ali is handling this."  # to Bea; the stranger is ignored


def test_reject_with_no_answer_known(
    posted: Asked, ali: User, client: TestClient, db: Session, telegram: FakeTelegram
) -> None:
    answer, review = posted
    press(client, ALI_TG, review, "reject")
    prompt = telegram.sent[-1]
    assert telegram.buttons(prompt) == [f"rv:{review.id}:noanswer"]

    press(client, ALI_TG, review, "noanswer")

    db.refresh(answer)
    db.refresh(review)
    assert answer.status == AnswerStatus.WRONG_NO_ANSWER
    assert answer.current_text == answer.original_text
    assert review.state == ReviewState.REJECTED


def test_reject_with_the_right_answer(
    posted: Asked, ali: User, client: TestClient, db: Session, telegram: FakeTelegram
) -> None:
    answer, review = posted
    press(client, ALI_TG, review, "reject")
    reply(client, ALI_TG, telegram.sent[-1]["id"], "Pro is $1,200 a month.")

    db.refresh(answer)
    db.refresh(review)
    assert (answer.status, answer.current_text) == (
        AnswerStatus.CORRECTED,
        "Pro is $1,200 a month.",
    )
    assert review.state == ReviewState.REJECTED


def test_needs_info_round_trip(
    posted: Asked,
    ali: User,
    client: TestClient,
    me: tuple[TestClient, User],
    db: Session,
    telegram: FakeTelegram,
    run_jobs: RunJobs,
) -> None:
    answer, review = posted
    asker, _ = me
    press(client, ALI_TG, review, "needs_info")
    assert telegram.sent[-1]["text"].startswith(
        "❓ Ali: reply to this message with your question for Sara"
    )

    reply(client, ALI_TG, telegram.sent[-1]["id"], "Is this for a dental client?")

    db.refresh(answer)
    assert answer.status == AnswerStatus.NEEDS_INFO
    assert telegram.sent[-1]["text"] == "Sent. I'll post their reply here."
    chat = asker.get(f"/api/conversations/{answer.conversation_id}").json()
    assert chat["messages"][-1]["answer"]["needs_info"] == {
        "question": "Is this for a dental client?",
        "asked_by": "Ali",
    }

    response = asker.post(
        f"/api/answers/{answer.id}/needs-info-reply", json={"text": "Yes, a dentist in Leeds."}
    )
    assert response.json() == {"status": "in_review"}
    run_jobs()

    db.refresh(review)
    assert (review.state, review.claimed_by) == (ReviewState.CLAIMED, ali.id)
    note = telegram.sent[-1]
    assert note["text"] == (
        f"💬 Sara replied to #R-{review.number} (Ali, it's back with you):\n"
        "Yes, a dentist in Leeds."
    )
    assert note["reply_to"] == review.telegram_message_id
    # Nothing is waiting any more.
    again = asker.post(f"/api/answers/{answer.id}/needs-info-reply", json={"text": "Hello?"})
    assert again.status_code == 409


def test_only_the_asker_answers_needs_info(
    posted: Asked,
    ali: User,
    client: TestClient,
    db: Session,
    telegram: FakeTelegram,
    ask_client: Callable[[], TestClient],
    make_user: UserFactory,
) -> None:
    answer, review = posted
    press(client, ALI_TG, review, "needs_info")
    reply(client, ALI_TG, telegram.sent[-1]["id"], "Which client?")
    other = ask_client()
    sign_in(other, make_user(Role.USER).email)

    response = other.post(f"/api/answers/{answer.id}/needs-info-reply", json={"text": "Me!"})

    assert response.status_code == 404


# --- linking Telegram --------------------------------------------------------------------------


def test_linking_with_a_one_time_code(
    me: tuple[TestClient, User], client: TestClient, db: Session, telegram: FakeTelegram
) -> None:
    asker, sara = me
    db.add(Setting(key="telegram_bot_username", value="gr_answers_bot"))
    db.commit()
    body = asker.post("/api/me/telegram-link").json()
    assert len(body["code"]) == 8 and body["bot_username"] == "gr_answers_bot"

    private(client, SARA_TG, f"/link {body['code'].lower()}")

    db.refresh(sara)
    assert sara.telegram_user_id == SARA_TG
    assert telegram.sent[-1]["text"] == "✅ Linked to Sara. You can now get messages here."
    assert asker.get("/api/auth/me").json()["user"]["telegram_linked"] is True
    # A code works once.
    private(client, 6000, f"/link {body['code']}")
    assert telegram.sent[-1]["text"].startswith("That code is wrong or has expired.")


def test_a_reviewer_links_with_start_and_takes_the_account_over(
    ask_client: Callable[[], TestClient],
    client: TestClient,
    make_user: UserFactory,
    db: Session,
    telegram: FakeTelegram,
) -> None:
    old = make_user(Role.USER)
    old.telegram_user_id = ALI_TG
    db.commit()
    reviewer = make_user(Role.REVIEWER, name="Ali")
    web = ask_client()
    sign_in(web, reviewer.email)
    code = web.post("/api/me/telegram-link").json()["code"]

    private(client, ALI_TG, f"/start {code}")

    db.expire_all()
    linked = {u.id: u.telegram_user_id for u in db.scalars(select(User))}
    assert (linked[old.id], linked[reviewer.id]) == (None, ALI_TG)
    assert telegram.sent[-1]["text"].endswith("You can now review answers in the group here.")


def test_expired_codes_and_other_messages(
    me: tuple[TestClient, User], client: TestClient, db: Session, telegram: FakeTelegram
) -> None:
    asker, sara = me
    code = asker.post("/api/me/telegram-link").json()["code"]
    from app.db.models import AuthToken

    for token in db.scalars(select(AuthToken)):
        token.expires_at = now() - timedelta(seconds=1)
    db.commit()

    private(client, SARA_TG, f"/link {code}")
    private(client, SARA_TG, "hello")

    db.refresh(sara)
    assert sara.telegram_user_id is None
    assert telegram.sent[-2]["text"].startswith("That code is wrong or has expired.")
    assert "/link ABCD2345" in telegram.sent[-1]["text"]


def test_unlinking_and_no_bot(me: tuple[TestClient, User], db: Session) -> None:
    asker, sara = me
    assert asker.post("/api/me/telegram-link").status_code == 409  # no bot configured
    sara.telegram_user_id = SARA_TG
    db.commit()
    assert asker.delete("/api/me/telegram-link").status_code == 204
    db.refresh(sara)
    assert sara.telegram_user_id is None


def test_groups_the_bot_joins_can_be_chosen_in_settings(
    client: TestClient,
    telegram: FakeTelegram,
    ask_client: Callable[[], TestClient],
    make_user: UserFactory,
) -> None:
    update = {
        "update_id": 7,
        "my_chat_member": {"chat": {"id": GROUP, "type": "supergroup", "title": "GR reviewers"}},
    }
    hook(client, update)
    owner = ask_client()
    sign_in(owner, make_user(Role.OWNER).email)

    body = owner.get("/api/settings").json()

    assert body["telegram"]["seen_chats"] == [{"id": GROUP, "title": "GR reviewers"}]
    assert body["telegram"]["configured"] is True


# --- the web queue ----------------------------------------------------------------------------


@pytest.fixture
def web(ask_client: Callable[[], TestClient]) -> Callable[[User], TestClient]:
    def make(user: User) -> TestClient:
        c = ask_client()
        sign_in(c, user.email)
        return c

    return make


def test_the_web_queue(
    posted: Asked,
    ali: User,
    bea: User,
    web: Callable[[User], TestClient],
    me: tuple[TestClient, User],
    db: Session,
    telegram: FakeTelegram,
    run_jobs: RunJobs,
) -> None:
    answer, review = posted
    ali_web, bea_web = web(ali), web(bea)
    asker, _ = me

    assert asker.get("/api/reviews").status_code == 403
    assert asker.post(f"/api/reviews/{review.id}/claim").status_code == 403
    [row] = ali_web.get("/api/reviews").json()
    assert (row["number"], row["reason_label"], row["asked_by"]["name"]) == (
        review.number,
        f"Low confidence ({answer.confidence})",
        "Sara",
    )
    assert ali_web.get("/api/reviews/count").json() == {"waiting": 1}

    claimed = ali_web.post(f"/api/reviews/{review.id}/claim").json()
    assert (claimed["state"], claimed["mine"]) == ("claimed", True)
    taken = bea_web.post(f"/api/reviews/{review.id}/decide", json={"action": "approve"})
    assert (taken.status_code, taken.json()["error"]["message"]) == (409, "Ali is handling this.")
    empty = ali_web.post(f"/api/reviews/{review.id}/decide", json={"action": "edit", "text": " "})
    assert empty.status_code == 422

    done = ali_web.post(
        f"/api/reviews/{review.id}/decide",
        json={"action": "edit", "text": "Pro costs $950.", "note": "Price went up"},
    ).json()
    run_jobs()

    assert (done["state"], done["current_text"], done["note"]) == (
        "edited",
        "Pro costs $950.",
        "Price went up",
    )
    assert ali_web.get("/api/reviews").json() == []
    assert [r["number"] for r in ali_web.get("/api/reviews?show=decided").json()] == [review.number]
    assert "✏️ Corrected by Ali" in telegram.edits[-1]["text"]


def test_deciding_an_open_review_on_the_web_claims_it(
    posted: Asked, ali: User, web: Callable[[User], TestClient], db: Session
) -> None:
    _, review = posted
    done = web(ali).post(f"/api/reviews/{review.id}/decide", json={"action": "approve"}).json()
    assert (done["state"], done["claimed_by"]["name"], done["decided_by"]["name"]) == (
        "approved",
        "Ali",
        "Ali",
    )


def test_release_puts_it_back(
    posted: Asked, ali: User, bea: User, web: Callable[[User], TestClient]
) -> None:
    _, review = posted
    ali_web = web(ali)
    ali_web.post(f"/api/reviews/{review.id}/claim")
    released = ali_web.post(f"/api/reviews/{review.id}/release").json()
    assert (released["state"], released["claimed_by"]) == ("open", None)
    assert web(bea).post(f"/api/reviews/{review.id}/claim").json()["mine"] is True


def test_web_needs_info_is_posted_to_the_group(
    posted: Asked,
    ali: User,
    web: Callable[[User], TestClient],
    telegram: FakeTelegram,
    run_jobs: RunJobs,
) -> None:
    _, review = posted
    web(ali).post(
        f"/api/reviews/{review.id}/decide",
        json={"action": "needs_info", "text": "Which location?"},
    )
    run_jobs()
    note = telegram.sent[-1]
    assert note["text"] == f"❓ Ali asked about #R-{review.number}:\nWhich location?"
    assert note["reply_to"] == review.telegram_message_id


def test_a_no_answer_review_cant_be_approved(
    me: tuple[TestClient, User], ali: User, web: Callable[[User], TestClient], db: Session
) -> None:
    client, _ = me
    ask(client, new_chat(client), "Who is the office dog?")
    review = db.scalars(select(Review)).one()
    ali_web = web(ali)

    refused = ali_web.post(f"/api/reviews/{review.id}/decide", json={"action": "approve"})
    assert refused.status_code == 422
    answered = ali_web.post(
        f"/api/reviews/{review.id}/decide", json={"action": "edit", "text": "Biscuit."}
    ).json()
    assert answered["current_text"] == "Biscuit."


def test_review_history_and_time_in_the_answer_log(
    posted: Asked, ali: User, bea: User, web: Callable[[User], TestClient], db: Session
) -> None:
    answer, review = posted
    review.created_at = now() - timedelta(minutes=90)
    db.commit()
    web(ali).post(
        f"/api/reviews/{review.id}/decide", json={"action": "edit", "text": "Fixed.", "note": "n"}
    )
    owner = web(bea)

    detail = owner.get(f"/api/answer-log/{answer.id}").json()
    stats = owner.get("/api/answer-log").json()["stats"]

    [history] = detail["reviews"]
    assert (history["state"], history["decided_by"], history["final_text"], history["note"]) == (
        "edited",
        "Ali",
        "Fixed.",
        "n",
    )
    assert stats["avg_review_minutes"] == 90


# --- reminders and escalation -----------------------------------------------------------------


def test_reminders_then_escalation(
    posted: Asked,
    bea: User,
    db: Session,
    telegram: FakeTelegram,
    run_jobs: RunJobs,
    mailer: FakeMailer,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, review = posted
    monkeypatch.setattr("app.reviews.jobs.get_mailer", lambda: mailer)

    def tick(hours_old: float) -> None:
        review.created_at = now() - timedelta(hours=hours_old)
        enqueue(db, "review_reminders")
        db.commit()
        run_jobs()
        db.refresh(review)

    tick(3)
    assert len(telegram.sent) == 1 and mailer.outbox == []
    tick(5)
    assert telegram.sent[-1]["text"] == f"⏰ #R-{review.number} has been waiting over 4 h."
    assert telegram.sent[-1]["reply_to"] == review.telegram_message_id
    tick(6)
    assert len(telegram.sent) == 2  # reminded once
    tick(25)
    [email] = mailer.outbox
    assert (email.to, email.subject) == (
        bea.email,
        f"Review #R-{review.number} has waited over 24 hours",
    )
    tick(30)
    assert len(mailer.outbox) == 1  # escalated once


def test_reviews_waiting_on_the_asker_arent_chased(
    posted: Asked,
    ali: User,
    web: Callable[[User], TestClient],
    db: Session,
    telegram: FakeTelegram,
    run_jobs: RunJobs,
) -> None:
    _, review = posted
    web(ali).post(f"/api/reviews/{review.id}/decide", json={"action": "needs_info", "text": "?"})
    run_jobs()
    sent = len(telegram.sent)
    review.created_at = now() - timedelta(hours=30)
    enqueue(db, "review_reminders")
    db.commit()
    run_jobs()
    assert len(telegram.sent) == sent


def test_a_telegram_failure_is_retried(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    telegram: FakeTelegram,
    group: int,
    run_jobs: RunJobs,
) -> None:
    _, review = low_answer(me, db, store, answerer)
    telegram.fail = 1
    run_jobs()
    db.refresh(review)
    assert review.telegram_message_id is None
    from app.db.models import Job

    job = db.scalars(select(Job).where(Job.kind == "telegram_review")).one()
    job.run_after = now()
    db.commit()
    run_jobs()
    db.refresh(review)
    assert review.telegram_message_id is not None


# --- settings and setup ------------------------------------------------------------------------


def test_review_settings(
    web: Callable[[User], TestClient], make_user: UserFactory, db: Session
) -> None:
    owner = web(make_user(Role.OWNER, name="Olivia"))
    reviewer = web(make_user(Role.REVIEWER))

    assert reviewer.get("/api/settings").status_code == 403
    assert reviewer.patch("/api/settings", json={"values": {}}).status_code == 403
    bad = owner.patch(
        "/api/settings",
        json={"values": {"confidence_threshold": 120, "telegram_group_chat_id": "abc", "x": 1}},
    )
    assert bad.status_code == 422
    assert set(bad.json()["error"]["fields"]) == {
        "confidence_threshold",
        "telegram_group_chat_id",
        "x",
    }
    later = owner.patch("/api/settings", json={"values": {"review_escalation_hours": 2}})
    assert later.json()["error"]["fields"] == {
        "review_escalation_hours": "Escalate later than the reminder."
    }

    ok = owner.patch(
        "/api/settings",
        json={"values": {"confidence_threshold": 80, "telegram_group_chat_id": str(GROUP)}},
    ).json()

    assert ok["values"]["confidence_threshold"] == 80
    assert ok["values"]["telegram_group_chat_id"] == GROUP
    entry = db.scalars(select(AuditEntry).where(AuditEntry.entity == "settings")).one()
    assert {c["field"] for c in entry.changes} == {"confidence_threshold", "telegram_group_chat_id"}


def test_test_message(
    web: Callable[[User], TestClient], make_user: UserFactory, telegram: FakeTelegram, db: Session
) -> None:
    owner = web(make_user(Role.OWNER))
    assert owner.post("/api/settings/telegram-test").status_code == 409  # no group yet
    owner.patch("/api/settings", json={"values": {"telegram_group_chat_id": GROUP}})
    assert owner.post("/api/settings/telegram-test").status_code == 200
    assert telegram.sent[-1]["chat"] == GROUP


def test_setup_telegram_registers_the_webhook(
    telegram: FakeTelegram,
    clean_engine: Engine,
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.config import get_settings

    monkeypatch.setenv("APP_URL", "https://answers.example.com")
    get_settings.cache_clear()
    monkeypatch.setattr(cli, "get_engine", lambda: clean_engine)

    cli.main(["setup-telegram"])

    assert telegram.webhook == ("https://answers.example.com/api/telegram/webhook", WEBHOOK_SECRET)
    assert db.get(Setting, "telegram_bot_username") is not None


def test_setup_telegram_needs_https(telegram: FakeTelegram) -> None:
    with pytest.raises(SystemExit, match="APP_URL must be"):
        cli.main(["setup-telegram"])
