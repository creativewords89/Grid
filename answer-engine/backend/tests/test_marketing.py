"""Marketing threads (SPEC section 6.10): Reddit and Facebook by link or code → draft →
posted → their reply → next draft, with reviews, statuses and permissions. Claude, Pinecone
and Telegram are faked."""

import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.tokens import now
from app.db.models import (
    Community,
    DraftState,
    MessageAuthor,
    Notification,
    Review,
    ReviewState,
    Role,
    Setting,
    Thread,
    ThreadStatus,
    TrashItem,
    User,
    VerifiedAnswer,
    VerifiedOrigin,
)
from app.jobs.queue import enqueue
from app.marketing import service
from app.marketing.service import MessageView, derive_status
from tests.asking import add_doc
from tests.conftest import RunJobs, UserFactory, sign_in
from tests.fakes import FakeAnswerer, FakeStore, FakeTelegram

POST = "https://www.reddit.com/r/localseo/comments/1abc2de/how_long_does_gbp_verification_take/"
QUESTION = "How long does Google Business Profile verification take for a new dentist?"
DOC = (
    "How long does Google Business Profile verification take for a new dentist or other "
    "business? It usually takes 5 to 14 days by postcard or video."
)
THEM = MessageAuthor.THEM
US = MessageAuthor.US


@pytest.fixture
def web(ask_client: Callable[[], TestClient]) -> Callable[[User], TestClient]:
    def make(user: User) -> TestClient:
        c = ask_client()
        sign_in(c, user.email)
        return c

    return make


@pytest.fixture
def sara(make_user: UserFactory) -> User:
    return make_user(Role.USER, name="Sara")


@pytest.fixture(autouse=True)
def knowledge(db: Session, store: FakeStore, sara: User) -> None:
    """A document that answers the thread's question, so drafts score high by default."""
    add_doc(db, store, sara, "GBP guide.pdf", [DOC])


@pytest.fixture
def client(web: Callable[[User], TestClient], sara: User) -> TestClient:
    return web(sara)


def new_thread(client: TestClient, url: str = POST, question: str = QUESTION, **extra: Any) -> Any:
    response = client.post("/api/threads", json={"url": url, "question": question, **extra})
    assert response.status_code == 201, response.text
    return response.json()


def drafted(
    client: TestClient, thread: dict[str, Any], parent: str | None = None, **extra: Any
) -> Any:
    parent = parent or thread["messages"][0]["id"]
    response = client.post(
        f"/api/threads/{thread['id']}/draft", json={"parent_id": parent, **extra}
    )
    assert response.status_code == 200, response.text
    return response.json()


def ours(thread: dict[str, Any]) -> dict[str, Any]:
    drafts: list[dict[str, Any]] = [m for m in thread["messages"] if m["author"] == "us"]
    return drafts[-1]


# --- statuses (pure) -------------------------------------------------------------------------


def v(
    n: int, author: MessageAuthor, parent: int | None = None, state: DraftState | None = None
) -> MessageView:
    ids = {i: uuid.UUID(int=i) for i in range(10)}
    return MessageView(ids[n], author, ids[parent] if parent is not None else None, state, n)


@pytest.mark.parametrize(
    ("messages", "status"),
    [
        ([v(1, THEM)], ThreadStatus.WAITING_FOR_US),
        ([v(1, THEM), v(2, US, 1, DraftState.IN_REVIEW)], ThreadStatus.IN_REVIEW),
        ([v(1, THEM), v(2, US, 1, DraftState.READY)], ThreadStatus.READY_TO_POST),
        ([v(1, THEM), v(2, US, 1, DraftState.POSTED)], ThreadStatus.WAITING_FOR_THEM),
        ([v(1, THEM), v(2, US, 1, DraftState.DISCARDED)], ThreadStatus.WAITING_FOR_US),
        ([v(1, THEM), v(2, US, 1, DraftState.DRAFT)], ThreadStatus.WAITING_FOR_US),
        (
            [v(1, THEM), v(2, US, 1, DraftState.READY), v(3, US, 1, DraftState.IN_REVIEW)],
            ThreadStatus.IN_REVIEW,  # the latest draft counts
        ),
        (
            # Their reply to our posted reply: a new branch needs us.
            [v(1, THEM), v(2, US, 1, DraftState.POSTED), v(3, THEM, 2)],
            ThreadStatus.WAITING_FOR_US,
        ),
        (
            # Two branches: the most urgent wins.
            [
                v(1, THEM),
                v(2, US, 1, DraftState.POSTED),
                v(3, THEM, 2),
                v(4, US, 3, DraftState.READY),
                v(5, THEM, 1),
                v(6, US, 5, DraftState.IN_REVIEW),
            ],
            ThreadStatus.IN_REVIEW,
        ),
        ([], ThreadStatus.WAITING_FOR_US),
    ],
)
def test_status_of_the_most_urgent_branch(
    messages: list[MessageView], status: ThreadStatus
) -> None:
    assert derive_status(messages, closed=False) == status
    assert derive_status(messages, closed=True) == ThreadStatus.CLOSED


# --- the "Paste a URL" box -------------------------------------------------------------------


def test_a_new_url_is_recognised(client: TestClient) -> None:
    body = client.post("/api/threads/resolve", json={"url": POST + "?utm_source=share"}).json()
    assert body["found"] is False
    assert body["parsed"] == {
        "platform": "reddit",
        "thread_id": "reddit:1abc2de",
        "community": "r/localseo",
        "comment_id": None,
        "platform_name": "Reddit",
    }


def test_bad_urls_say_what_to_do(client: TestClient) -> None:
    share = client.post("/api/threads/resolve", json={"url": "https://www.reddit.com/r/x/s/AbC"})
    assert share.json()["error"].startswith("This is a share link.")
    other = client.post("/api/threads/resolve", json={"url": "https://example.com/x"}).json()
    assert "isn't set up for answering" in other["error"]


def test_creating_and_finding_a_thread_again(client: TestClient, db: Session, sara: User) -> None:
    created = new_thread(client, author_name="u/dentist_dan")

    assert (created["id"], created["status"], created["community"]) == (
        "reddit:1abc2de",
        "waiting_for_us",
        "r/localseo",
    )
    assert created["title"] == QUESTION
    [first] = created["messages"]
    assert (first["author"], first["author_name"], first["body"]) == (
        "them",
        "u/dentist_dan",
        QUESTION,
    )

    again = client.post(
        "/api/threads/resolve",
        json={"url": "https://old.reddit.com/r/localseo/comments/1abc2de/x/"},
    ).json()
    assert (again["found"], again["thread"]["id"], again["thread"]["created_by"]["name"]) == (
        True,
        "reddit:1abc2de",
        "Sara",
    )
    dup = client.post("/api/threads", json={"url": POST, "question": "again"})
    assert (dup.status_code, dup.json()["error"]["code"]) == (409, "exists")


FB_POST = "https://www.facebook.com/groups/localbiz/posts/1234567890123456/"


def test_a_facebook_conversation_from_draft_to_follow_up(client: TestClient) -> None:
    thread = new_thread(client, FB_POST + "?fbclid=IwAR0", QUESTION, author_name="Dan Miller")
    assert (thread["id"], thread["community"], thread["person"]) == (
        "facebook:1234567890123456",
        "localbiz",
        "Dan Miller",
    )
    assert "fbclid" not in thread["original_url"]
    thread = drafted(client, thread)
    draft = ours(thread)
    posted = client.post(
        f"/api/thread-messages/{draft['id']}/posted",
        json={"url": FB_POST + "?comment_id=555"},
    )
    assert posted.status_code == 200, posted.text
    assert posted.json()["status"] == "waiting_for_them"

    # Their answer under our comment: its link finds the thread and the comment it replies to.
    link = FB_POST + "?comment_id=555&reply_comment_id=777"
    found = client.post("/api/threads/resolve", json={"url": link}).json()
    assert (found["found"], found["thread"]["id"], found["matched_message_id"]) == (
        True,
        thread["id"],
        draft["id"],
    )
    reply = client.post(
        f"/api/threads/{thread['id']}/replies",
        json={"body": "Is video verification faster?", "author_name": "Dan Miller", "url": link},
    )
    assert reply.status_code == 201, reply.text
    thread = reply.json()
    assert thread["status"] == "waiting_for_us"
    assert thread["messages"][-1]["parent_id"] == draft["id"]
    follow_up = drafted(client, thread, thread["messages"][-1]["id"])
    assert len([m for m in follow_up["messages"] if m["author"] == "us"]) == 2
    # The post's code on its own finds it too.
    code = client.post("/api/threads/resolve", json={"url": "1234567890123456"}).json()
    assert code["found"] is True and code["thread"]["id"] == thread["id"]


def test_a_link_for_another_post_is_refused(client: TestClient) -> None:
    thread = new_thread(client, FB_POST, QUESTION)
    other = "https://www.facebook.com/groups/localbiz/posts/9999999999999999/?comment_id=1"
    reply = client.post(f"/api/threads/{thread['id']}/replies", json={"body": "Hi", "url": other})
    assert reply.status_code == 422
    assert "different thread" in reply.json()["error"]["message"]


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({"url": FB_POST, "question": " "}, "Paste the question"),
        ({"url": "https://www.facebook.com/share/p/1AbCdEf/", "question": "Q?"}, "share link"),
        (
            {"url": "https://www.facebook.com/groups/localbiz/", "question": "Q?"},
            "doesn't look like a link",
        ),
    ],
)
def test_new_threads_need_the_right_details(
    client: TestClient, body: dict[str, str], message: str
) -> None:
    response = client.post("/api/threads", json=body)
    assert response.status_code == 422
    assert message in response.json()["error"]["message"]


def test_a_new_thread_needs_a_link(client: TestClient) -> None:
    assert client.post("/api/threads", json={"question": "Q?"}).status_code == 422


def test_a_switched_off_facebook_takes_no_new_conversations(
    client: TestClient, db: Session
) -> None:
    service.platforms(db)
    platform = service.platform_of(db, "facebook")
    platform.enabled = False
    db.commit()
    response = client.post("/api/threads", json={"url": FB_POST, "question": "Q?"})
    assert response.status_code == 422
    assert "switched off" in response.json()["error"]["message"]


def test_a_reddit_post_code_works_like_its_link(client: TestClient) -> None:
    thread = new_thread(client, "1abc2de", QUESTION, author_name="u/dentist_dan")
    assert thread["id"] == "reddit:1abc2de"
    assert thread["person"] == "u/dentist_dan"
    resolved = client.post("/api/threads/resolve", json={"url": POST}).json()
    assert resolved["found"] is True and resolved["thread"]["id"] == "reddit:1abc2de"
    assert client.post("/api/threads/resolve", json={"url": "1ABC2DE"}).json()["found"] is True


def test_a_well_supported_draft_is_ready_to_post(
    client: TestClient, db: Session, store: FakeStore, answerer: FakeAnswerer, sara: User
) -> None:
    reddit = next(p for p in service.platforms(db) if p.slug == "reddit")
    db.add(Community(platform_id=reddit.id, name="r/localseo", notes="No links to our website."))
    db.commit()
    thread = new_thread(client)

    after = drafted(client, thread, instruction="mention the free audit")

    draft = ours(after)
    assert draft["state"] == "ready" and after["status"] == "ready_to_post"
    assert draft["body"] == answerer.draft_reply
    assert draft["parent_id"] == thread["messages"][0]["id"]
    assert draft["draft"]["outcome"] == "high"
    [prompt] = answerer.drafts
    assert "Platform: Reddit" in prompt
    assert "Style: Short, plain text" in prompt
    assert "Community notes: No links to our website." in prompt
    assert f'<forum_message id="m1" by="them" answer_this="true">\n{QUESTION}' in prompt
    assert DOC in prompt
    assert "Extra instruction from the team member: mention the free audit" in prompt
    assert answerer.checks  # the same support check as chat


def test_a_draft_mentioning_us_gets_the_disclosure_line(
    client: TestClient, answerer: FakeAnswerer
) -> None:
    answerer.draft_reply = "We at GridRankers see 1-2 weeks."
    draft = ours(drafted(client, new_thread(client)))
    assert draft["body"] == "We at GridRankers see 1-2 weeks.\n\n(I work at GridRankers.)"


def test_a_low_draft_goes_to_telegram_and_cant_be_posted(
    client: TestClient,
    db: Session,
    answerer: FakeAnswerer,
    telegram: FakeTelegram,
    run_jobs: RunJobs,
) -> None:
    db.add(Setting(key="telegram_group_chat_id", value=-100123))
    db.commit()
    answerer.verdict = "partial"

    after = drafted(client, new_thread(client))
    run_jobs()

    draft = ours(after)
    assert (draft["state"], after["status"]) == ("in_review", "in_review")
    assert "From: Sara · Marketing · Reddit · r/localseo" in telegram.sent[0]["text"]
    locked = client.post(f"/api/thread-messages/{draft['id']}/posted", json={})
    assert (locked.status_code, locked.json()["error"]["message"]) == (
        409,
        "Waiting for review – don't post yet.",
    )


def test_regenerating_replaces_the_draft_and_withdraws_its_review(
    client: TestClient, db: Session, answerer: FakeAnswerer
) -> None:
    answerer.verdict = "partial"
    thread = new_thread(client)
    drafted(client, thread)
    answerer.verdict = "full"
    answerer.draft_reply = "Shorter: 1-2 weeks."

    after = drafted(client, thread, instruction="shorter")

    drafts = [m for m in after["messages"] if m["author"] == "us"]
    assert [d["body"] for d in drafts] == ["Shorter: 1-2 weeks."]  # the old one is discarded
    assert after["status"] == "ready_to_post"
    assert db.scalars(select(Review)).one().state == ReviewState.CANCELLED


def test_editing_a_draft_by_hand(client: TestClient) -> None:
    draft = ours(drafted(client, new_thread(client)))
    after = client.patch(f"/api/thread-messages/{draft['id']}", json={"body": "My words."}).json()
    assert ours(after)["body"] == "My words."


def test_drafting_needs_the_keys(
    web: Callable[[User], TestClient], app_factory: Callable[[], TestClient], sara: User
) -> None:
    plain = app_factory()
    sign_in(plain, sara.email)
    thread = new_thread(plain)
    response = plain.post(
        f"/api/threads/{thread['id']}/draft", json={"parent_id": thread["messages"][0]["id"]}
    )
    assert response.status_code == 503


def test_a_refused_draft_says_so(client: TestClient, answerer: FakeAnswerer) -> None:
    answerer.draft_stop = "refusal"
    draft = ours(drafted(client, new_thread(client)))
    assert draft["body"].startswith("I can't draft a reply to this one.")
    assert draft["state"] == "in_review"  # refused: score 0, a person decides


# --- reviewing drafts ------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("body", "verified"),
    [
        ({"action": "approve"}, False),  # approve: not added by default
        ({"action": "approve", "add_to_kb": True}, True),
        ({"action": "edit", "text": "Usually 1-2 weeks."}, True),  # edit: added by default
        ({"action": "edit", "text": "Usually 1-2 weeks.", "add_to_kb": False}, False),
    ],
)
def test_reviewing_a_draft_unlocks_it_and_maybe_teaches_the_kb(
    client: TestClient,
    db: Session,
    answerer: FakeAnswerer,
    make_user: UserFactory,
    web: Callable[[User], TestClient],
    sara: User,
    body: dict[str, Any],
    verified: bool,
) -> None:
    answerer.verdict = "partial"
    thread = drafted(client, new_thread(client))
    review = db.scalars(select(Review)).one()

    web(make_user(Role.REVIEWER, name="Ali")).post(f"/api/reviews/{review.id}/decide", json=body)

    after = client.get(f"/api/threads/{thread['id']}").json()
    assert (ours(after)["state"], after["status"]) == ("ready", "ready_to_post")
    if body["action"] == "edit":
        assert ours(after)["body"] == "Usually 1-2 weeks."
    vas = db.scalars(select(VerifiedAnswer)).all()
    assert bool(vas) is verified
    if vas:
        assert vas[0].origin == VerifiedOrigin.MARKETING
    [note] = db.scalars(select(Notification).where(Notification.user_id == sara.id)).all()
    assert (note.kind, note.title, note.link) == (
        "thread_draft_ready",
        "Your Reddit draft is ready to post",
        "/marketing?thread=reddit:1abc2de",
    )


def test_a_rejected_draft_goes_back_to_waiting_for_us(
    client: TestClient,
    db: Session,
    answerer: FakeAnswerer,
    make_user: UserFactory,
    web: Callable[[User], TestClient],
) -> None:
    answerer.verdict = "partial"
    thread = drafted(client, new_thread(client))
    review = db.scalars(select(Review)).one()
    web(make_user(Role.REVIEWER)).post(
        f"/api/reviews/{review.id}/decide", json={"action": "no_answer"}
    )
    after = client.get(f"/api/threads/{thread['id']}").json()
    assert after["status"] == "waiting_for_us"
    assert [m for m in after["messages"] if m["author"] == "us"] == []


# --- posting, their reply, the next draft ----------------------------------------------------


def test_the_whole_conversation(
    client: TestClient, db: Session, answerer: FakeAnswerer, sara: User
) -> None:
    thread = drafted(client, new_thread(client))
    draft = ours(thread)

    posted = client.post(
        f"/api/thread-messages/{draft['id']}/posted", json={"url": POST + "kx9z0p1/"}
    ).json()
    assert posted["status"] == "waiting_for_them"
    mine = ours(posted)
    assert (mine["state"], mine["posted_by"]["name"]) == ("posted", "Sara")

    # Their reply is found again by the comment URL and lands under our reply.
    found = client.post("/api/threads/resolve", json={"url": POST + "kx9z0p1/?context=3"}).json()
    assert found["matched_message_id"] == mine["id"]
    replied = client.post(
        f"/api/threads/{thread['id']}/replies",
        json={"body": "Thanks! And video verification?", "author_name": "u/dentist_dan"},
    ).json()
    reply = replied["messages"][-1]
    assert (reply["author"], reply["parent_id"], replied["status"]) == (
        "them",
        mine["id"],
        "waiting_for_us",
    )

    # The next draft sees the whole thread, with the new message marked.
    answerer.draft_reply = "Video verification is often faster."
    nxt = drafted(client, replied, parent=reply["id"])
    prompt = answerer.drafts[-1]
    assert '<forum_message id="m2" by="us" reply_to="m1">' in prompt
    assert (
        '<forum_message id="m3" by="them" author="u/dentist_dan" reply_to="m2" answer_this="true">'
        in prompt
    )
    assert nxt["status"] == "ready_to_post"


def test_posting_a_link_from_another_thread_is_refused(client: TestClient) -> None:
    draft = ours(drafted(client, new_thread(client)))
    wrong = client.post(
        f"/api/thread-messages/{draft['id']}/posted",
        json={"url": "https://www.reddit.com/r/x/comments/zzz999/other/abc/"},
    )
    assert wrong.json()["error"]["message"] == "That link is for a different thread."


def test_a_reply_corrected_after_posting_tells_the_poster(
    client: TestClient,
    db: Session,
    answerer: FakeAnswerer,
    make_user: UserFactory,
    web: Callable[[User], TestClient],
    sara: User,
) -> None:
    thread = drafted(client, new_thread(client))
    draft = ours(thread)
    client.post(f"/api/thread-messages/{draft['id']}/posted", json={})
    owner = web(make_user(Role.OWNER, name="Olivia"))

    owner.post(
        f"/api/answers/{draft['draft']['answer_id']}/admin-review",
        json={"action": "edit", "text": "It takes 2-3 weeks now."},
    )

    after = client.get(f"/api/threads/{thread['id']}").json()
    mine = ours(after)
    assert mine["body"] == draft["body"]  # what was posted stays as posted
    assert mine["draft"]["corrected_after_post"] == "It takes 2-3 weeks now."
    [note] = db.scalars(select(Notification).where(Notification.user_id == sara.id)).all()
    assert note.kind == "reply_corrected_after_post"
    assert note.body == "It takes 2-3 weeks now."
    # The next draft is told about the correction.
    replied = client.post(f"/api/threads/{thread['id']}/replies", json={"body": "Hm?"}).json()
    drafted(client, replied, parent=replied["messages"][-1]["id"])
    assert (
        "[Our team later corrected this reply to:]\nIt takes 2-3 weeks now." in answerer.drafts[-1]
    )


# --- lists, closing, deleting ----------------------------------------------------------------


def test_list_tabs_and_filters(client: TestClient, db: Session, answerer: FakeAnswerer) -> None:
    new_thread(client)
    drafted(
        client, new_thread(client, "https://www.reddit.com/r/SEO/comments/2bcd3ef/x/", QUESTION)
    )
    facebook = new_thread(client, FB_POST, "Q3?")

    body = client.get("/api/threads").json()
    assert body["counts"]["waiting_for_us"] == 2 and body["counts"]["ready_to_post"] == 1
    assert [t["id"] for t in client.get("/api/threads?status=ready_to_post").json()["items"]] == [
        "reddit:2bcd3ef"
    ]
    assert [t["id"] for t in client.get("/api/threads?platform=facebook").json()["items"]] == [
        facebook["id"]
    ]
    assert len(client.get("/api/threads?community=r/SEO").json()["items"]) == 1
    assert len(client.get("/api/threads?mine=true").json()["items"]) == 3


def test_who_can_close_and_delete(
    client: TestClient, web: Callable[[User], TestClient], make_user: UserFactory, db: Session
) -> None:
    thread = new_thread(client)
    tid = thread["id"]
    other = web(make_user(Role.USER))
    reviewer = web(make_user(Role.REVIEWER))

    assert other.post(f"/api/threads/{tid}/close").status_code == 403
    assert client.post(f"/api/threads/{tid}/close").json()["status"] == "closed"
    assert reviewer.post(f"/api/threads/{tid}/reopen").json()["status"] == "waiting_for_us"
    assert client.get(f"/api/threads/{tid}").json()["can_delete"] is False
    assert reviewer.delete(f"/api/threads/{tid}").status_code == 403

    owner = web(make_user(Role.OWNER))
    assert owner.delete(f"/api/threads/{tid}").status_code == 204
    assert client.get(f"/api/threads/{tid}").status_code == 404
    item = db.scalars(select(TrashItem)).one()
    owner.post(f"/api/trash/{item.id}/restore")
    assert client.get(f"/api/threads/{tid}").status_code == 200


def test_pasting_a_closed_threads_url_reopens_it(client: TestClient) -> None:
    thread = new_thread(client)
    client.post(f"/api/threads/{thread['id']}/close")
    found = client.post("/api/threads/resolve", json={"url": POST}).json()
    assert (found["reopened"], found["thread"]["status"]) == (True, "waiting_for_us")


def test_quiet_threads_close_themselves(client: TestClient, db: Session, run_jobs: RunJobs) -> None:
    thread = new_thread(client)
    row = db.get(Thread, thread["id"])
    assert row is not None
    row.last_activity_at = now() - timedelta(days=15)
    enqueue(db, "thread_auto_close")
    db.commit()

    run_jobs()

    after = client.get(f"/api/threads/{thread['id']}").json()
    assert (after["status"], after["close_reason"]) == ("closed", "inactive")
    reply = client.post(f"/api/threads/{thread['id']}/replies", json={"body": "Anyone?"}).json()
    assert reply["status"] == "waiting_for_us"


# --- platforms -------------------------------------------------------------------------------


def test_the_owner_manages_platforms(
    client: TestClient, web: Callable[[User], TestClient], make_user: UserFactory
) -> None:
    owner = web(make_user(Role.OWNER))
    names = [p["name"] for p in client.get("/api/platforms").json()]
    assert names == ["Reddit", "Facebook"]
    assert (
        client.post(
            "/api/platforms", json={"name": "Quora", "slug": "quora", "hosts": ["quora.com"]}
        ).status_code
        == 403
    )

    quora = owner.post(
        "/api/platforms",
        json={
            "name": "Quora",
            "slug": "quora",
            "hosts": ["www.quora.com"],
            "style_prompt": "Thorough.",
        },
    ).json()
    assert (quora["parser"], quora["hosts"]) == ("generic", ["quora.com"])
    found = client.post(
        "/api/threads/resolve", json={"url": "https://www.quora.com/How-long-is-GBP-verification"}
    ).json()
    assert found["parsed"]["platform"] == "quora"

    reddit = next(p for p in owner.get("/api/platforms").json() if p["slug"] == "reddit")
    owner.patch(f"/api/platforms/{reddit['id']}", json={"enabled": False})
    off = client.post("/api/threads/resolve", json={"url": POST}).json()
    assert off["error"] == "Answering on Reddit is switched off in Settings."

    with_notes = owner.post(
        f"/api/platforms/{reddit['id']}/communities",
        json={"name": "r/SEO", "notes": "Mods hate links."},
    ).json()
    [community] = with_notes["communities"]
    assert community["notes"] == "Mods hate links."
    assert owner.delete(f"/api/communities/{community['id']}").status_code == 204
