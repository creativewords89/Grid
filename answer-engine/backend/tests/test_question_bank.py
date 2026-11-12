"""Question Bank: sets of real questions answered into verified answers (SPEC 6.9a, 27, 29)."""

import io
import json
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.conversations import answerer_dep
from app.db.models import (
    AuditEntry,
    FbStatus,
    FbThread,
    KbOp,
    QuestionSet,
    Role,
    User,
    VerifiedAnswer,
    VerifiedOrigin,
    VerifiedStatus,
)
from app.kb.store import VERIFIED
from app.question_bank.export import sheet_name
from app.verified.service import search_text
from tests.conftest import UserFactory, sign_in
from tests.fakes import FakeAnswerer, FakeStore

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


def make_set(client: TestClient, name: str = "Local SEO group", **extra: Any) -> str:
    response = client.post("/api/qb/sets", json={"name": name, "source": "Facebook", **extra})
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


def first_set(client: TestClient) -> str:
    return str(client.get("/api/qb/sets").json()["items"][0]["id"])


def load(
    client: TestClient, data: Any, set_id: str | None = None, name: str = "facebook-data.json"
) -> Any:
    raw = json.dumps(data).encode() if not isinstance(data, bytes) else data
    sid = set_id or first_set(client)
    return client.post(f"/api/qb/sets/{sid}/load", files={"file": (name, raw)})


def threads(client: TestClient, set_id: str | None = None) -> Any:
    return client.get(f"/api/qb/sets/{set_id or first_set(client)}/threads").json()


@pytest.fixture
def boss_set(boss: TestClient) -> TestClient:
    make_set(boss)
    return boss


@pytest.fixture
def loaded(boss_set: TestClient) -> TestClient:
    assert load(boss_set, {"posts": POSTS, "threads": THREADS}).status_code == 200
    return boss_set


def thread_id(client: TestClient, key: str, set_id: str | None = None) -> str:
    items = threads(client, set_id)["items"]
    return str(next(t["id"] for t in items if t["key"] == key))


def prefix(db: Session) -> str:
    return db.scalars(select(QuestionSet)).first().prefix  # type: ignore[union-attr]


def save(client: TestClient, key: str, status: str, items: Any = None, title: str = "") -> Any:
    return client.put(
        f"/api/qb/threads/{thread_id(client, key)}/answer",
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


def test_loading_the_data_file(boss_set: TestClient, db: Session) -> None:
    response = load(boss_set, {"posts": POSTS, "threads": THREADS})

    assert response.json() == {"posts": 2, "threads": 3, "answers": 0, "skipped": []}
    page = threads(boss_set)
    assert page["can_manage"] is True
    assert page["set"]["name"] == "Local SEO group" and page["set"]["total"] == 3
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
    detail = loaded.get(f"/api/qb/threads/{thread_id(loaded, 's315')}").json()
    assert detail["title"] == "New title?"
    assert detail["answer"]["status"] == "draft"
    assert [i["text"] for i in detail["answer"]["items"]] == [t["text"] for t in TWO]


def test_answers_in_the_file_arrive_with_their_status(boss_set: TestClient, db: Session) -> None:
    answers = {
        "s315": {"title": "Towns in a roofer's GBP?", "status": "final", "angles": TWO},
        "s316": {"status": "skip", "angles": []},
    }

    body = load(boss_set, {"posts": POSTS, "threads": THREADS, "answers": answers}).json()

    assert body["answers"] == 2
    counts = threads(boss_set)["counts"]
    assert (counts["approved"], counts["skipped"]) == (1, 1)
    # Approved ones are verified straight away, one per answer.
    assert [(v.question, v.answer) for v in live(db)] == [
        ("Towns in a roofer's GBP?", "It depends how broad it is."),
        ("Towns in a roofer's GBP?", "Mention the main town naturally."),
    ]


@pytest.mark.parametrize(
    ("content", "message"),
    [
        (b"not json", "can't be read"),
        (json.dumps({"posts": "x", "threads": []}).encode(), "expected shape"),
        (json.dumps({"posts": [{"row": "1"}], "threads": []}).encode(), "expected shape"),
    ],
)
def test_a_bad_file_changes_nothing(
    boss_set: TestClient, db: Session, content: bytes, message: str
) -> None:
    response = load(boss_set, content)

    assert response.status_code == 422
    assert message in response.json()["error"]["message"]
    assert db.scalars(select(FbThread)).all() == []


# --- a thread ---------------------------------------------------------------------------------


def test_a_thread_has_its_post_comments_and_similar_threads(loaded: TestClient) -> None:
    save(loaded, "s316", "draft", [{"label": "", "picks": [], "text": "Only real areas."}])

    detail = loaded.get(f"/api/qb/threads/{thread_id(loaded, 's315')}").json()

    assert detail["set_name"] == "Local SEO group"
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
    p = prefix(db)
    assert p.startswith("qb-")
    assert (one.import_key, two.import_key) == (f"{p}:s315:1", f"{p}:s315:2")
    assert one.answer_group == two.answer_group == f"{p}:s315"
    assert (one.applies_when, two.applies_when) == ("Broad service area", None)
    assert one.question == "Should my GBP description list towns?"
    assert one.also_asked == POSTS[0]["question"]
    assert {v.origin for v in (one, two)} == {VerifiedOrigin.FACEBOOK}
    # Step 30: the thread's topic groups them on the Verified Answers page.
    assert (one.topic, one.subtopic) == ("Google Business Profile", "Profile Edits & Info")
    queued = [
        r
        for op in db.scalars(select(KbOp).where(KbOp.namespace == VERIFIED))
        for r in op.record_ids
    ]
    assert sorted(queued) == sorted([one.record_id, two.record_id])


def test_a_verified_answer_traces_back_to_its_thread(
    loaded: TestClient,
    db: Session,
    make_user: UserFactory,
    web: Callable[[User], TestClient],
) -> None:
    save(loaded, "s315", "approved")
    one = live(db)[0]

    origin = loaded.get(f"/api/verified/{one.id}").json()["origin_thread"]

    assert origin == {
        "id": thread_id(loaded, "s315"),
        "set_id": first_set(loaded),
        "set_name": "Local SEO group",
        "rows": [315],
    }
    # Users can't open the Question Bank, so they don't get the link.
    user = web(make_user(Role.USER))
    assert user.get(f"/api/verified/{one.id}").json()["origin_thread"] is None


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
    assert threads(loaded)["counts"]["skipped"] == 1

    save(loaded, "s315", "approved")
    cleared = loaded.delete(f"/api/qb/threads/{thread_id(loaded, 's315')}/answer").json()
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
    return client.post(f"/api/qb/threads/{thread_id(client, key)}/rework", json=body)


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


# --- sets ----------------------------------------------------------------------------------------


def test_sets_are_listed_with_their_progress(loaded: TestClient) -> None:
    other = make_set(loaded, "Reddit r/localseo", source="Reddit", url="https://reddit.com/r/x")
    save(loaded, "s315", "approved")

    listed = loaded.get("/api/qb/sets").json()

    assert listed["can_manage"] is True
    first, second = listed["items"]
    assert (first["name"], first["total"], first["counts"]["approved"]) == (
        "Local SEO group",
        3,
        1,
    )
    assert (second["id"], second["source"], second["total"]) == (other, "Reddit", 0)
    assert second["counts"] == {"todo": 0, "draft": 0, "approved": 0, "skipped": 0}


@pytest.mark.parametrize(
    ("name", "status"), [(" ", 422), ("x" * 121, 422), ("local seo GROUP", 409)]
)
def test_names_that_cant_be_used(boss_set: TestClient, db: Session, name: str, status: int) -> None:
    assert boss_set.post("/api/qb/sets", json={"name": name}).status_code == status
    assert len(db.scalars(select(QuestionSet)).all()) == 1


def test_sets_keep_their_questions_and_answers_apart(loaded: TestClient, db: Session) -> None:
    other = make_set(loaded, "Client emails")
    # The same keys and rows in another set are different threads.
    load(loaded, {"posts": POSTS, "threads": THREADS}, other)
    save(loaded, "s315", "approved")
    loaded.put(
        f"/api/qb/threads/{thread_id(loaded, 's315', other)}/answer",
        json={"items": [{"text": "Emails answer."}], "status": "approved"},
    )

    assert threads(loaded)["counts"]["approved"] == 1
    assert threads(loaded, other)["counts"]["approved"] == 1
    keys = [v.import_key or "" for v in live(db)]
    assert len(keys) == 3 and len({k.rsplit(":", 2)[0] for k in keys}) == 2
    detail = loaded.get(f"/api/qb/threads/{thread_id(loaded, 's316', other)}").json()
    # Similar threads come from the same set only.
    assert [s["title"] for s in detail["similar"]] == [THREADS[0]["title"]]
    assert detail["similar"][0]["items"][0]["text"] == "Emails answer."


def test_renaming_a_set(boss_set: TestClient, db: Session) -> None:
    sid = first_set(boss_set)

    response = boss_set.patch(f"/api/qb/sets/{sid}", json={"name": "FB group 2026", "url": "u"})

    assert response.json()["name"] == "FB group 2026" and response.json()["url"] == "u"
    entries = db.scalars(select(AuditEntry).where(AuditEntry.entity == "question_set")).all()
    assert [e.action for e in entries] == ["create", "update"]


def test_deleting_a_set_trashes_its_verified_answers(loaded: TestClient, db: Session) -> None:
    keep = make_set(loaded, "Keep me")
    load(loaded, {"posts": POSTS, "threads": THREADS}, keep)
    loaded.put(
        f"/api/qb/threads/{thread_id(loaded, 's315', keep)}/answer",
        json={"items": [{"text": "Kept."}], "status": "approved"},
    )
    save(loaded, "s315", "approved")
    gone = first_set(loaded)

    assert loaded.delete(f"/api/qb/sets/{gone}").status_code == 204

    assert [s["name"] for s in loaded.get("/api/qb/sets").json()["items"]] == ["Keep me"]
    assert [v.answer for v in live(db)] == ["Kept."]
    assert db.scalars(select(FbThread).where(FbThread.set_id == uuid.UUID(gone))).all() == []
    assert loaded.get(f"/api/qb/sets/{gone}/threads").status_code == 404


# --- uploading a spreadsheet ---------------------------------------------------------------------

SHEET = (
    "Question,Details,Link,Asked by,Topic,Comments,Answer\n"
    'Do I need a website for GBP?,"I run a mobile car wash.\nNo site yet.",https://x.co/1,Sam,'
    'GBP,"Ann: Not required.\nIt helps though",\n'
    "How often should I post?,,,,Posts,,Once a week is plenty.\n"
    ",only details,,,,,\n"
    "Do I need a website for GBP?,,,,,,\n"
)


def test_a_csv_becomes_a_set_of_threads(boss_set: TestClient, db: Session) -> None:
    response = load(boss_set, SHEET.encode(), name="questions.csv")

    body = response.json()
    assert (body["threads"], body["answers"]) == (3, 1)
    assert body["skipped"] == [{"row": 4, "reason": "No question."}]
    page = threads(boss_set)
    # Most discussed first, then in file order; a repeated question is its own thread.
    assert [(t["key"], t["title"]) for t in page["items"]] == [
        ("r2", "Do I need a website for GBP?"),
        ("r3", "How often should I post?"),
        ("r5", "Do I need a website for GBP?"),
    ]
    assert page["counts"]["draft"] == 1  # an answer in the file is a draft to check
    first = boss_set.get(f"/api/qb/threads/{page['items'][0]['id']}").json()
    [post] = first["posts"]
    assert post["question"] == "I run a mobile car wash.\nNo site yet."
    assert (post["url"], post["author"], post["row"]) == ("https://x.co/1", "Sam", 2)
    assert post["comments"] == [["Ann", "Not required.", []], ["", "It helps though", []]]
    # Uploading the same file again updates instead of adding.
    assert load(boss_set, SHEET.encode(), name="questions.csv").json()["threads"] == 3
    assert threads(boss_set)["set"]["total"] == 3


@pytest.mark.parametrize(
    ("content", "name", "code"),
    [
        (b"answer\nSome answer\n", "a.csv", "no_columns"),
        (b"question\n\n", "a.csv", "empty"),
        (b"%PDF-1.4 not a sheet", "a.pdf", "unsupported"),
    ],
)
def test_spreadsheets_that_cant_be_used(
    boss_set: TestClient, db: Session, content: bytes, name: str, code: str
) -> None:
    response = load(boss_set, content, name=name)

    assert response.json()["error"]["code"] == code
    assert db.scalars(select(FbThread)).all() == []


# --- suggested answers (step 31) ----------------------------------------------------------------


def index(db: Session, store: FakeStore) -> None:
    """What the sync worker would put in Pinecone: every live verified answer."""
    db.expire_all()
    space = store.data.setdefault(VERIFIED, {})
    for va in live(db):
        if va.status == VerifiedStatus.ACTIVE:
            space[va.record_id] = {"_id": va.record_id, "text": search_text(va)}


def suggestions(client: TestClient, key: str, set_id: str | None = None) -> Any:
    return client.get(f"/api/qb/threads/{thread_id(client, key, set_id)}/suggestions").json()


def test_approved_answers_are_suggested_by_meaning_from_any_set(
    loaded: TestClient, db: Session, store: FakeStore
) -> None:
    other = make_set(loaded, "Reddit")
    load(loaded, {"posts": POSTS, "threads": THREADS}, other)
    save(loaded, "s315", "approved")
    index(db, store)

    found = suggestions(loaded, "s315", other)

    assert [(s["kind"], s["answer"], s["applies_when"]) for s in found] == [
        ("verified", TWO[0]["text"], "Broad service area"),
        ("verified", TWO[1]["text"], ""),
    ]
    first = found[0]
    assert first["match"] == "strong" and first["score"] == 1.0
    assert (first["set_name"], first["rows"]) == ("Local SEO group", [315])
    assert first["thread_id"] == thread_id(loaded, "s315")
    assert store.searched[-1] == THREADS[0]["title"]
    # A thread never gets its own answers back.
    assert suggestions(loaded, "s315") == []


def test_drafts_in_other_threads_are_suggested_by_words(loaded: TestClient) -> None:
    save(loaded, "s316", "draft", [{"label": "", "picks": [], "text": "Only where you work."}])

    found = suggestions(loaded, "s315")

    assert [(s["kind"], s["answer"], s["match"]) for s in found] == [
        ("draft", "Only where you work.", "possible")
    ]
    assert found[0]["verified_id"] is None and found[0]["set_name"] == "Local SEO group"


def test_without_search_approved_answers_are_found_by_words(
    loaded: TestClient, db: Session, store: FakeStore
) -> None:
    save(loaded, "s316", "approved", [{"label": "", "picks": [], "text": "Only where you work."}])
    store.fail = 1  # Pinecone is unreachable

    found = suggestions(loaded, "s315")

    assert [(s["kind"], s["answer"]) for s in found] == [("verified", "Only where you work.")]


# --- downloading approved answers (step 32) -----------------------------------------------------


def workbook(response: Any) -> Any:
    from openpyxl import load_workbook

    assert response.status_code == 200, response.text
    return load_workbook(io.BytesIO(response.content))


def test_downloading_a_set_gives_one_sheet_per_topic_with_answers_side_by_side(
    loaded: TestClient, db: Session
) -> None:
    save(loaded, "s315", "approved", title="Should my GBP description list towns?")
    save(loaded, "s316", "approved", [{"label": "", "picks": [], "text": "=1+1 is not advice"}])
    sid = first_set(loaded)

    response = loaded.get(f"/api/qb/sets/{sid}/export")

    assert "Local%20SEO%20group%20-%20approved.xlsx" in response.headers["content-disposition"]
    book = workbook(response)
    assert book.sheetnames == ["Summary", "Google Business Profile"]
    rows = list(book["Google Business Profile"].iter_rows(values_only=True))
    assert rows[0] == (
        "Question",
        "Description",
        "Topic",
        "Subtopic",
        "Answer 1",
        "When answer 1 applies",
        "Answer 2",
        "When answer 2 applies",
        "Approved by",
        "Approved on",
    )
    first = rows[1]
    assert first[:4] == (
        "Can a plumber add city names to GBP services?",
        POSTS[1]["question"],
        "Google Business Profile",
        "Products & Services",
    )
    # Text that looks like a formula stays text.
    assert first[4] == "=1+1 is not advice" and first[6] is None
    second = rows[2]
    assert second[0] == "Should my GBP description list towns?"
    assert second[4:8] == (TWO[0]["text"], "Broad service area", TWO[1]["text"], None)
    assert second[8] == "Olivia"
    summary = list(book["Summary"].iter_rows(values_only=True))
    assert ("Google Business Profile", 2, 3) in summary


def test_drafts_and_skipped_are_left_out_and_a_topic_splits_by_subtopic(
    loaded: TestClient,
) -> None:
    save(loaded, "s315", "approved")
    save(loaded, "s316", "draft")
    sid = first_set(loaded)

    book = workbook(
        loaded.get(f"/api/qb/sets/{sid}/export", params={"topic": "Google Business Profile"})
    )

    assert book.sheetnames == ["Summary", "Profile Edits & Info"]
    assert len(list(book["Profile Edits & Info"].iter_rows())) == 2
    empty = workbook(loaded.get(f"/api/qb/sets/{sid}/export", params={"topic": "Reviews"}))
    assert empty.sheetnames == ["Summary"]


def test_sheet_names_are_valid_and_unique() -> None:
    taken = {"summary"}

    names = [sheet_name(n, taken) for n in ["Summary", "Q&A: Tools/Apps?", "x" * 40, "x" * 40, ""]]

    assert names == ["Summary (2)", "Q&A  Tools Apps", "x" * 31, "x" * 27 + " (2)", "Other"]


# --- who can do what ---------------------------------------------------------------------------


@pytest.mark.parametrize(("role", "work"), [(Role.REVIEWER, True), (Role.USER, False)])
def test_who_can_work_and_manage_sets(
    loaded: TestClient,
    make_user: UserFactory,
    web: Callable[[User], TestClient],
    role: Role,
    work: bool,
) -> None:
    client = web(make_user(role))
    sid = first_set(loaded)
    tid = thread_id(loaded, "s315")
    ok = 200 if work else 403

    listed = client.get("/api/qb/sets")
    assert listed.status_code == ok
    if work:
        assert listed.json()["can_manage"] is False
    page = client.get(f"/api/qb/sets/{sid}/threads")
    assert page.status_code == ok
    if work:
        assert page.json()["can_manage"] is False
    assert client.get(f"/api/qb/threads/{tid}").status_code == ok
    assert client.get(f"/api/qb/threads/{tid}/suggestions").status_code == ok
    assert client.get(f"/api/qb/sets/{sid}/export").status_code == ok
    assert (
        client.put(f"/api/qb/threads/{tid}/answer", json={"items": TWO, "status": "draft"})
    ).status_code == ok
    assert client.delete(f"/api/qb/threads/{tid}/answer").status_code == ok
    assert (
        client.post(f"/api/qb/threads/{tid}/rework", json={"mode": "fit", "text": "x"})
    ).status_code == ok
    # Only Owners manage sets.
    assert client.post("/api/qb/sets", json={"name": "Mine"}).status_code == 403
    assert client.patch(f"/api/qb/sets/{sid}", json={"name": "Mine"}).status_code == 403
    assert load(client, {"posts": [], "threads": []}, sid).status_code == 403
    assert client.delete(f"/api/qb/sets/{sid}").status_code == 403
    assert loaded.get("/api/qb/sets").json()["items"][0]["name"] == "Local SEO group"


def test_signing_in_is_needed(client: TestClient) -> None:
    sid = uuid.uuid4()
    assert client.get("/api/qb/sets").status_code == 401
    assert client.get(f"/api/qb/sets/{sid}/threads").status_code == 401
    assert client.post("/api/qb/sets", json={"name": "x"}).status_code == 401
