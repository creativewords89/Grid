"""Facebook answers (SPEC section 6.9a, step 27)."""

import json
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.conversations import answerer_dep
from app.db.models import (
    FbStatus,
    FbThread,
    KbOp,
    Role,
    User,
    VerifiedAnswer,
    VerifiedOrigin,
    VerifiedStatus,
)
from app.kb.store import VERIFIED
from tests.conftest import UserFactory, sign_in
from tests.fakes import FakeAnswerer

POSTS: list[dict[str, Any]] = [
    {
        "row": 315,
        "url": "https://facebook.com/groups/g/permalink/315/",
        "author": "Dan",
        "question": "I'm a roofer with a big service area. Should my GBP description list towns?",
        "summary": "Mention the main town naturally.",
        "pinned": 1,
        "comments": [
            ["Ann", "It depends how broad your area is.", [["Dan", "Thanks!", []]]],
            ["Bob", "Mention the main location naturally, don't stuff towns.", []],
        ],
        "picked": [["0", "e"], ["1", "t"]],
    },
    {
        "row": 316,
        "url": "https://facebook.com/groups/g/permalink/316/",
        "question": "Plumber here: can I add city names to my services?",
        "comments": [["Cy", "Only where you really work.", []]],
        "picked": [],
    },
]
THREADS: list[dict[str, Any]] = [
    {
        "key": "s315",
        "title": "Should a roofer's GBP description list every town it serves?",
        "topic": "Google Business Profile",
        "subtopic": "Profile Edits & Info",
        "rows": [315],
        "similar": "g1",
    },
    {
        "key": "s316",
        "title": "Can a plumber add city names to GBP services?",
        "topic": "Google Business Profile",
        "subtopic": "Products & Services",
        "rows": [316],
        "similar": "g1",
    },
    {"key": "noise", "title": "Not a question", "rows": [], "noise": True},
]
TWO = [
    {"label": "Broad service area", "picks": ["315:0"], "text": "It depends how broad it is."},
    {"label": "", "picks": ["315:1"], "text": "Mention the main town naturally."},
]


@pytest.fixture
def web(ask_client: Callable[[], TestClient]) -> Callable[[User], TestClient]:
    def make(user: User) -> TestClient:
        c = ask_client()
        sign_in(c, user.email)
        return c

    return make


@pytest.fixture
def boss(make_user: UserFactory, web: Callable[[User], TestClient]) -> TestClient:
    return web(make_user(Role.OWNER, name="Olivia"))


def load(client: TestClient, data: Any) -> Any:
    raw = json.dumps(data).encode() if not isinstance(data, bytes) else data
    return client.post("/api/fb/load", files={"file": ("facebook-data.json", raw)})


@pytest.fixture
def loaded(boss: TestClient) -> TestClient:
    assert load(boss, {"posts": POSTS, "threads": THREADS}).status_code == 200
    return boss


def thread_id(client: TestClient, key: str) -> str:
    items = client.get("/api/fb/threads").json()["items"]
    return str(next(t["id"] for t in items if t["key"] == key))


def save(client: TestClient, key: str, status: str, items: Any = None, title: str = "") -> Any:
    return client.put(
        f"/api/fb/threads/{thread_id(client, key)}/answer",
        json={"title": title, "items": TWO if items is None else items, "status": status},
    )


def live(db: Session) -> list[VerifiedAnswer]:
    db.expire_all()
    return list(
        db.scalars(
            select(VerifiedAnswer)
            .where(VerifiedAnswer.deleted_at.is_(None))
            .order_by(VerifiedAnswer.import_key)
        )
    )


# --- loading the data file -------------------------------------------------------------------


def test_loading_the_data_file(boss: TestClient, db: Session) -> None:
    response = load(boss, {"posts": POSTS, "threads": THREADS})

    assert response.json() == {"posts": 2, "threads": 3, "answers": 0}
    page = boss.get("/api/fb/threads").json()
    assert page["can_load"] is True
    assert page["counts"] == {"todo": 3, "draft": 0, "approved": 0, "skipped": 0}
    # Most discussed first, questions before the noise pile.
    assert [t["key"] for t in page["items"]] == ["s315", "s316", "noise"]
    assert page["items"][0]["talk"] == 3


def test_loading_again_updates_threads_but_never_saved_answers(
    loaded: TestClient, db: Session
) -> None:
    save(loaded, "s315", "draft")
    renamed = [dict(THREADS[0], title="New title?"), *THREADS[1:]]
    answers = {"s315": {"status": "final", "angles": [{"label": "", "text": "Overwrite?"}]}}

    body = load(loaded, {"posts": POSTS, "threads": renamed, "answers": answers}).json()

    assert body["answers"] == 0
    detail = loaded.get(f"/api/fb/threads/{thread_id(loaded, 's315')}").json()
    assert detail["title"] == "New title?"
    assert detail["answer"]["status"] == "draft"
    assert [i["text"] for i in detail["answer"]["items"]] == [t["text"] for t in TWO]


def test_answers_in_the_file_arrive_with_their_status(boss: TestClient, db: Session) -> None:
    answers = {
        "s315": {"title": "Towns in a roofer's GBP?", "status": "final", "angles": TWO},
        "s316": {"status": "skip", "angles": []},
    }

    body = load(boss, {"posts": POSTS, "threads": THREADS, "answers": answers}).json()

    assert body["answers"] == 2
    counts = boss.get("/api/fb/threads").json()["counts"]
    assert (counts["approved"], counts["skipped"]) == (1, 1)
    # Approved ones are verified straight away, one per answer.
    assert [(v.question, v.answer) for v in live(db)] == [
        ("Towns in a roofer's GBP?", "It depends how broad it is."),
        ("Towns in a roofer's GBP?", "Mention the main town naturally."),
    ]


@pytest.mark.parametrize(
    ("content", "message"),
    [
        (b"not json", "Facebook data file"),
        (json.dumps({"posts": "x", "threads": []}).encode(), "expected shape"),
        (json.dumps({"posts": [{"row": "1"}], "threads": []}).encode(), "expected shape"),
    ],
)
def test_a_bad_file_changes_nothing(
    boss: TestClient, db: Session, content: bytes, message: str
) -> None:
    response = load(boss, content)

    assert response.status_code == 422
    assert message in response.json()["error"]["message"]
    assert db.scalars(select(FbThread)).all() == []


# --- a thread ---------------------------------------------------------------------------------


def test_a_thread_has_its_post_comments_and_similar_threads(loaded: TestClient) -> None:
    save(loaded, "s316", "draft", [{"label": "", "picks": [], "text": "Only real areas."}])

    detail = loaded.get(f"/api/fb/threads/{thread_id(loaded, 's315')}").json()

    [post] = detail["posts"]
    assert post["row"] == 315 and post["comments"][0][0] == "Ann"
    assert post["picked"] == [["0", "e"], ["1", "t"]]
    [similar] = detail["similar"]
    assert (similar["title"], similar["status"]) == (
        "Can a plumber add city names to GBP services?",
        "draft",
    )
    assert [i["text"] for i in similar["items"]] == ["Only real areas."]
    assert detail["answer"] == {
        "title": THREADS[0]["title"],
        "items": [],
        "status": "todo",
        "answered_by": None,
        "answered_at": None,
    }


def test_two_selected_answers_stay_separate_when_approved(loaded: TestClient, db: Session) -> None:
    response = save(loaded, "s315", "approved", title="Should my GBP description list towns?")

    assert response.status_code == 200
    assert [i["text"] for i in response.json()["answer"]["items"]] == [t["text"] for t in TWO]
    one, two = live(db)
    assert (one.import_key, two.import_key) == ("fb:s315:1", "fb:s315:2")
    assert one.answer_group == two.answer_group == "fb:s315"
    assert (one.applies_when, two.applies_when) == ("Broad service area", None)
    assert one.question == "Should my GBP description list towns?"
    assert one.also_asked == POSTS[0]["question"]
    assert {v.origin for v in (one, two)} == {VerifiedOrigin.FACEBOOK}
    queued = [
        r
        for op in db.scalars(select(KbOp).where(KbOp.namespace == VERIFIED))
        for r in op.record_ids
    ]
    assert sorted(queued) == sorted([one.record_id, two.record_id])


def test_approving_again_updates_and_removes_answers(loaded: TestClient, db: Session) -> None:
    save(loaded, "s315", "approved")
    first = live(db)[0]

    save(loaded, "s315", "approved", [dict(TWO[0], text="It depends on your area.")])

    [only] = live(db)
    assert (only.id, only.answer, only.version) == (first.id, "It depends on your area.", 2)


def test_draft_skip_and_clear_take_answers_out_of_search(loaded: TestClient, db: Session) -> None:
    save(loaded, "s315", "approved")

    save(loaded, "s315", "draft")
    assert {v.status for v in live(db)} == {VerifiedStatus.DISABLED}

    save(loaded, "s315", "approved")
    assert {v.status for v in live(db)} == {VerifiedStatus.ACTIVE}

    save(loaded, "s315", "skipped")
    assert {v.status for v in live(db)} == {VerifiedStatus.DISABLED}
    assert loaded.get("/api/fb/threads").json()["counts"]["skipped"] == 1

    save(loaded, "s315", "approved")
    cleared = loaded.delete(f"/api/fb/threads/{thread_id(loaded, 's315')}/answer").json()
    assert cleared["answer"]["status"] == "todo" and cleared["answer"]["items"] == []
    assert {v.status for v in live(db)} == {VerifiedStatus.DISABLED}


@pytest.mark.parametrize(
    ("items", "status", "message"),
    [
        ([], "approved", "then approve"),
        ([{"label": "", "picks": [], "text": ""}], "draft", "Nothing to save"),
        ([{"text": "x" * 20001}], "draft", "over 20,000"),
        ([{"text": f"A{i}"} for i in range(7)], "draft", "6 answers"),
    ],
)
def test_answers_that_cant_be_saved(
    loaded: TestClient, db: Session, items: Any, status: str, message: str
) -> None:
    response = save(loaded, "s315", status, items)

    assert response.status_code == 422
    assert message in response.json()["error"]["message"]
    assert live(db) == []
    assert db.scalars(select(FbThread).where(FbThread.key == "s315")).one().status == FbStatus.TODO


# --- Polish and Fit to post ------------------------------------------------------------------


def rework(client: TestClient, key: str, **body: Any) -> Any:
    return client.post(f"/api/fb/threads/{thread_id(client, key)}/rework", json=body)


def test_fit_to_post_sends_the_post_and_lists_the_changes(
    loaded: TestClient, answerer: FakeAnswerer
) -> None:
    answerer.rework_reply = (
        'Sure: {"answer": "As a roofer, mention your main town.", '
        '"changes": ["Made it about roofing"]}'
    )

    response = rework(loaded, "s315", mode="fit", text="Mention the main town.", label="Broad area")

    assert response.json() == {
        "answer": "As a roofer, mention your main town.",
        "changes": ["Made it about roofing"],
    }
    [prompt] = answerer.reworks
    assert "You are NOT rewriting it." in prompt
    assert f"<post>\n{POSTS[0]['question']}\n</post>" in prompt
    assert "<answer>\nMention the main town.\n</answer>" in prompt
    assert "This answer applies: Broad area" in prompt


def test_polish_doesnt_send_the_post(loaded: TestClient, answerer: FakeAnswerer) -> None:
    response = rework(loaded, "s315", mode="polish", text="mention main town", instruction="short")

    assert response.json() == {"answer": "Polished answer.", "changes": []}
    [prompt] = answerer.reworks
    assert "<post>" not in prompt
    assert "The owner's instruction: short" in prompt


@pytest.mark.parametrize("reply", ["Just some text", '{"answer": ""}'])
def test_an_unusable_reply(loaded: TestClient, answerer: FakeAnswerer, reply: str) -> None:
    answerer.rework_reply = reply

    response = rework(loaded, "s315", mode="fit", text="Answer.")

    assert response.status_code == 502


def test_a_refusal(loaded: TestClient, answerer: FakeAnswerer) -> None:
    answerer.rework_stop = "refusal"

    assert rework(loaded, "s315", mode="polish", text="Answer.").status_code == 502


def test_without_a_claude_key(loaded: TestClient) -> None:
    loaded.app.dependency_overrides[answerer_dep] = lambda: None  # type: ignore[attr-defined]

    assert rework(loaded, "s315", mode="polish", text="Answer.").status_code == 503


# --- who can do what ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("role", "work", "load_ok"), [(Role.REVIEWER, True, False), (Role.USER, False, False)]
)
def test_who_can_work_and_load(
    loaded: TestClient,
    make_user: UserFactory,
    web: Callable[[User], TestClient],
    role: Role,
    work: bool,
    load_ok: bool,
) -> None:
    client = web(make_user(role))
    tid = thread_id(loaded, "s315")
    ok = 200 if work else 403

    listed = client.get("/api/fb/threads")
    assert listed.status_code == ok
    if work:
        assert listed.json()["can_load"] is load_ok
    assert client.get(f"/api/fb/threads/{tid}").status_code == ok
    assert (
        client.put(f"/api/fb/threads/{tid}/answer", json={"items": TWO, "status": "draft"})
    ).status_code == ok
    assert client.delete(f"/api/fb/threads/{tid}/answer").status_code == ok
    assert (
        client.post(f"/api/fb/threads/{tid}/rework", json={"mode": "fit", "text": "x"})
    ).status_code == ok
    assert load(client, {"posts": [], "threads": []}).status_code == 403


def test_signing_in_is_needed(client: TestClient) -> None:
    assert client.get("/api/fb/threads").status_code == 401
    assert load(client, {"posts": [], "threads": []}).status_code == 401
