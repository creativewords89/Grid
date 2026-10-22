"""Notifications (SPEC section 6.11): who is told, on which channel, and the bell."""

from collections.abc import Callable
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.auth.tokens import now
from app.db.models import (
    Answer,
    FileStatus,
    Job,
    KbOp,
    KbOpKind,
    Notification,
    NotifyChannel,
    Review,
    Role,
    StoredFile,
    User,
)
from app.jobs.queue import PermanentError, enqueue
from app.kb import sync
from app.notifications import service
from tests.asking import add_doc, ask, new_chat
from tests.conftest import FakeMailer, RunJobs, UserFactory, sign_in
from tests.fakes import FakeAnswerer, FakeStore, FakeTelegram

PRICING = "The Pro plan costs $900 per month and includes weekly posts."
QUESTION = "What does the Pro plan cost per month?"


@pytest.fixture(autouse=True)
def mail(monkeypatch: pytest.MonkeyPatch, mailer: FakeMailer) -> FakeMailer:
    """Notification emails go to the fake mailer."""
    monkeypatch.setattr("app.notifications.service.get_mailer", lambda: mailer)
    return mailer


@pytest.fixture
def web(ask_client: Callable[[], TestClient]) -> Callable[[User], TestClient]:
    def make(user: User) -> TestClient:
        c = ask_client()
        sign_in(c, user.email)
        return c

    return make


def low(
    me: tuple[TestClient, User], db: Session, store: FakeStore, answerer: FakeAnswerer
) -> tuple[Answer, Review]:
    client, user = me
    answerer.verdict = "partial"
    add_doc(db, store, user, "Pricing.pdf", [PRICING])
    ask(client, new_chat(client), QUESTION)
    db.expire_all()
    return db.scalars(select(Answer)).one(), db.scalars(select(Review)).one()


def notes(db: Session, user: User) -> list[Notification]:
    db.expire_all()
    return list(
        db.scalars(
            select(Notification)
            .where(Notification.user_id == user.id)
            .order_by(Notification.created_at)
        )
    )


# --- reviews tell the asker ------------------------------------------------------------------


def test_a_correction_tells_the_asker_by_email(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    make_user: UserFactory,
    web: Callable[[User], TestClient],
    run_jobs: RunJobs,
    mail: FakeMailer,
) -> None:
    _, sara = me
    answer, review = low(me, db, store, answerer)
    ali = make_user(Role.REVIEWER, name="Ali")

    web(ali).post(f"/api/reviews/{review.id}/decide", json={"action": "edit", "text": "$950."})
    run_jobs()

    [note] = notes(db, sara)
    assert (note.kind, note.title, note.body, note.link) == (
        "answer_reviewed",
        "Our team corrected an answer you got",
        QUESTION,
        f"/?c={answer.conversation_id}",
    )
    assert (note.channel, note.read_at) == ("email", None) and note.sent_at is not None
    assert notes(db, ali) == []  # the reviewer isn't told about their own decision
    [email] = mail.outbox
    assert (email.to, email.subject) == (sara.email, "Our team corrected an answer you got")
    assert f"/?c={answer.conversation_id}" in email.body
    assert email.unsubscribe is not None and email.unsubscribe in email.body
    assert email.html is not None and "Stop these emails" in email.html


@pytest.mark.parametrize(
    ("action", "title"),
    [
        ("approve", "Our team checked an answer you got: it's right"),
        ("no_answer", "An answer you got was wrong"),
        ("needs_info", "Our team needs more information"),
    ],
)
def test_each_decision_has_its_message(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    make_user: UserFactory,
    web: Callable[[User], TestClient],
    action: str,
    title: str,
) -> None:
    _, sara = me
    _, review = low(me, db, store, answerer)
    body: dict[str, Any] = {"action": action}
    if action == "needs_info":
        body["text"] = "Which client?"

    web(make_user(Role.REVIEWER, name="Ali")).post(f"/api/reviews/{review.id}/decide", json=body)

    [note] = notes(db, sara)
    assert note.title == title
    if action == "needs_info":
        assert note.body == "Ali asks: Which client?"


def test_in_app_only_sends_nothing_else(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    make_user: UserFactory,
    web: Callable[[User], TestClient],
    run_jobs: RunJobs,
    mail: FakeMailer,
) -> None:
    _, sara = me
    sara.notify_channel = NotifyChannel.IN_APP
    db.commit()
    _, review = low(me, db, store, answerer)

    web(make_user(Role.REVIEWER)).post(
        f"/api/reviews/{review.id}/decide", json={"action": "approve"}
    )
    run_jobs()

    assert len(notes(db, sara)) == 1
    assert mail.outbox == []
    assert db.scalars(select(Job).where(Job.kind == service.SEND_JOB)).all() == []


def test_telegram_channel_and_its_email_fallback(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    make_user: UserFactory,
    web: Callable[[User], TestClient],
    run_jobs: RunJobs,
    mail: FakeMailer,
    telegram: FakeTelegram,
) -> None:
    _, sara = me
    sara.telegram_user_id = 777
    sara.notify_channel = NotifyChannel.TELEGRAM
    db.commit()
    _, review = low(me, db, store, answerer)
    ali = web(make_user(Role.REVIEWER))

    ali.post(f"/api/reviews/{review.id}/decide", json={"action": "needs_info", "text": "Which?"})
    run_jobs()
    sent = [m for m in telegram.sent if m["chat"] == 777]
    assert len(sent) == 1 and sent[0]["text"].startswith(
        "🔔 <b>Our team needs more information</b>"
    )
    assert mail.outbox == []

    # Telegram unlinked since: the next one goes by email.
    sara.telegram_user_id = None
    db.commit()
    sara_web = me[0]
    sara_web.post(f"/api/answers/{review.answer_id}/needs-info-reply", json={"text": "Dentist"})
    ali.post(f"/api/reviews/{review.id}/decide", json={"action": "approve"})
    run_jobs()
    assert [e.subject for e in mail.outbox] == ["Our team checked an answer you got: it's right"]


def test_the_owner_correcting_their_own_question_isnt_told(
    ask_client: Callable[[], TestClient],
    make_user: UserFactory,
    db: Session,
    store: FakeStore,
) -> None:
    owner = make_user(Role.OWNER)
    client = ask_client()
    sign_in(client, owner.email)
    add_doc(db, store, owner, "Pricing.pdf", [PRICING])
    ask(client, new_chat(client), QUESTION)
    answer = db.scalars(select(Answer)).one()

    client.post(f"/api/answers/{answer.id}/admin-review", json={"action": "edit", "text": "x."})

    assert notes(db, owner) == []


def test_inactive_people_get_nothing(db: Session, make_user: UserFactory) -> None:
    gone = make_user(active=False)
    assert service.notify(db, gone, "x", "Hello") is None


# --- Owners: escalations, failed files, sync failures ---------------------------------------


def test_escalations_go_to_every_owner(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    make_user: UserFactory,
    run_jobs: RunJobs,
    mail: FakeMailer,
) -> None:
    olivia = make_user(Role.OWNER, name="Olivia")
    bea = make_user(Role.OWNER, name="Bea")
    bea.notify_channel = NotifyChannel.IN_APP
    reviewer = make_user(Role.REVIEWER)
    _, review = low(me, db, store, answerer)
    review.created_at = now() - timedelta(hours=25)
    enqueue(db, "review_reminders")
    db.commit()

    run_jobs()

    for owner in (olivia, bea):
        [note] = notes(db, owner)
        assert note.title == f"Review #R-{review.number} has waited over 24 hours"
        assert note.link == f"/reviews?id={review.id}"
    assert notes(db, reviewer) == []
    assert [e.to for e in mail.outbox] == [olivia.email]  # Bea chose in-app only


def file_failing(
    db: Session,
    user: User,
    error: Exception,
    monkeypatch: pytest.MonkeyPatch,
    upload_dir: Path,
) -> StoredFile:
    record = StoredFile(
        name="Broken.pdf",
        mime="application/pdf",
        size=1,
        sha256="b" * 64,
        storage_path="broken",
        status=FileStatus.QUEUED,
        uploaded_by=user.id,
    )
    db.add(record)
    db.flush()

    def boom(*_: Any) -> Any:
        raise error

    monkeypatch.setattr("app.jobs.handlers.extract", boom)
    upload_dir.mkdir(parents=True, exist_ok=True)
    (upload_dir / "broken").write_bytes(b"%PDF-1.7 broken")
    enqueue(db, "ingest_file", {"file_id": str(record.id)})
    db.commit()
    return record


def _run_until_done(db: Session, run_jobs: RunJobs) -> None:
    for _ in range(4):
        for job in db.scalars(select(Job)):
            job.run_after = now()
        db.commit()
        run_jobs()


def test_a_file_failing_three_times_tells_the_owners(
    db: Session,
    make_user: UserFactory,
    run_jobs: RunJobs,
    monkeypatch: pytest.MonkeyPatch,
    upload_dir: Path,
) -> None:
    owner = make_user(Role.OWNER)
    record = file_failing(db, owner, RuntimeError("disk on fire"), monkeypatch, upload_dir)

    _run_until_done(db, run_jobs)

    db.refresh(record)
    assert record.status == FileStatus.FAILED
    [note] = notes(db, owner)
    assert (note.kind, note.title, note.link) == (
        "file_failed",
        "A file couldn't be read: Broken.pdf",
        "/documents",
    )


def test_a_file_that_can_never_be_read_is_only_the_uploaders_problem(
    db: Session,
    make_user: UserFactory,
    run_jobs: RunJobs,
    monkeypatch: pytest.MonkeyPatch,
    upload_dir: Path,
) -> None:
    owner = make_user(Role.OWNER)
    locked = PermanentError("This PDF is password-protected.")
    record = file_failing(db, owner, locked, monkeypatch, upload_dir)

    _run_until_done(db, run_jobs)

    db.refresh(record)
    assert record.status == FileStatus.FAILED
    assert notes(db, owner) == []


def test_pinecone_failing_for_a_day_tells_the_owners_once(
    db: Session, make_user: UserFactory, clean_engine: Engine, store: FakeStore
) -> None:
    owner = make_user(Role.OWNER)
    op = KbOp(op=KbOpKind.DELETE, namespace="docs", record_ids=["doc_x_0"])
    db.add(op)
    db.commit()
    factory = sessionmaker(bind=clean_engine, expire_on_commit=False)

    store.fail = 1
    sync.process(factory, store)
    assert notes(db, owner) == []  # a fresh failure: just retried

    op.created_at = now() - timedelta(hours=25)
    op.next_attempt_at = now()
    db.commit()
    for _ in range(2):
        store.fail = 1
        sync.process(factory, store)
        db.refresh(op)
        op.next_attempt_at = now()
        db.commit()

    [note] = notes(db, owner)
    assert note.title == "Pinecone has been failing for over 24 hours"
    assert "Pinecone is unreachable" in note.body


# --- the bell ------------------------------------------------------------------------------------


def test_the_bell_shows_only_your_own(
    db: Session, make_user: UserFactory, web: Callable[[User], TestClient]
) -> None:
    sara, ali = make_user(name="Sara"), make_user(Role.REVIEWER, name="Ali")
    first = service.notify(db, sara, "x", "First", link="/")
    service.notify(db, sara, "x", "Second")
    service.notify(db, ali, "x", "Ali's")
    db.commit()
    client = web(sara)

    bell = client.get("/api/notifications").json()
    assert bell["unread"] == 2
    assert [n["title"] for n in bell["items"]] == ["Second", "First"]

    assert first is not None
    after = client.post("/api/notifications/read", json={"ids": [str(first.id)]}).json()
    assert after["unread"] == 1
    assert client.post("/api/notifications/read", json={}).json()["unread"] == 0
    assert web(ali).get("/api/notifications").json()["unread"] == 1


def test_the_bell_needs_a_session(client: TestClient) -> None:
    assert client.get("/api/notifications").status_code == 401
    assert client.get("/api/updates").status_code == 401


# --- "Stop these emails" -------------------------------------------------------------------------


def test_stop_emails_link(client: TestClient, db: Session, make_user: UserFactory) -> None:
    sara = make_user(name="Sara")
    link = service.stop_link(sara.id).split("/api", 1)[1]

    page = client.get(f"/api{link}")
    assert page.status_code == 200 and "<form method='post'" in page.text
    db.refresh(sara)
    channel = db.scalar(select(User.notify_channel).where(User.id == sara.id))
    assert channel == NotifyChannel.EMAIL  # opening the link changes nothing

    done = client.post(f"/api{link}")
    assert done.status_code == 200 and "get notification emails any more" in done.text
    db.expire_all()
    channel = db.scalar(select(User.notify_channel).where(User.id == sara.id))
    assert channel == NotifyChannel.IN_APP

    forged = client.post(f"/api/notifications/stop-emails?u={sara.id}&t={'0' * 32}")
    assert forged.status_code == 403
    assert client.get("/api/notifications/stop-emails?u=nope&t=x").status_code == 403


# --- choosing the channel -------------------------------------------------------------------------


def test_choosing_a_channel(
    db: Session, make_user: UserFactory, web: Callable[[User], TestClient]
) -> None:
    sara = make_user(name="Sara")
    client = web(sara)

    refused = client.patch("/api/me", json={"notify_channel": "telegram"})
    assert refused.json()["error"]["fields"] == {"notify_channel": "Link your Telegram first."}
    assert client.patch("/api/me", json={"notify_channel": "in_app"}).json()["notify_channel"] == (
        "in_app"
    )
    sara.telegram_user_id = 42
    db.commit()
    assert client.patch("/api/me", json={"notify_channel": "telegram"}).status_code == 200
    client.delete("/api/me/telegram-link")
    db.refresh(sara)
    assert sara.notify_channel == NotifyChannel.EMAIL  # unlinking moves it back to email
    assert client.patch("/api/me", json={"name": "Sara K"}).json()["name"] == "Sara K"


# --- live updates ----------------------------------------------------------------------------


def test_updates_report_what_changed_since_the_cursor(
    me: tuple[TestClient, User],
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    make_user: UserFactory,
    web: Callable[[User], TestClient],
) -> None:
    sara_web, _ = me
    answer, review = low(me, db, store, answerer)
    first = sara_web.get("/api/updates").json()
    assert (first["answers"], first["notifications"], first["reviews_waiting"]) == ([], [], None)
    cursor = first["cursor"]

    ali = make_user(Role.REVIEWER)
    ali_web = web(ali)
    assert ali_web.get("/api/updates").json()["reviews_waiting"] == 1
    ali_web.post(f"/api/reviews/{review.id}/decide", json={"action": "edit", "text": "$950."})

    later = sara_web.get("/api/updates", params={"since": cursor}).json()
    assert later["answers"] == [
        {
            "id": str(answer.id),
            "conversation_id": str(answer.conversation_id),
            "status": "corrected",
        }
    ]
    assert [n["kind"] for n in later["notifications"]] == ["answer_reviewed"]
    assert later["unread"] == 1
    assert later["files_changed"] is False
    assert ali_web.get("/api/updates").json()["reviews_waiting"] == 0
    again = sara_web.get("/api/updates", params={"since": later["cursor"]}).json()
    assert (again["answers"], again["notifications"]) == ([], [])
