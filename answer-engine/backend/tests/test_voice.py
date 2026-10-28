"""Brand voice (SPEC section 6.13): examples files per platform, their Pinecone namespace, the
style guide and writing rules, how examples are picked for drafts, suggestions from posted
replies, Try it, and who may change what. Claude and Pinecone are faked."""

import io
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.auth.tokens import now
from app.db.models import (
    DraftState,
    MessageAuthor,
    Platform,
    Role,
    Thread,
    ThreadMessage,
    ThreadStatus,
    User,
    VoiceExample,
    VoiceSource,
    VoiceState,
)
from app.kb import outbox, sync
from app.kb.reconcile import reconcile
from app.marketing import service as marketing
from app.voice import service as voice
from tests.asking import add_doc
from tests.conftest import RunJobs, UserFactory, sign_in
from tests.fakes import FakeAnswerer, FakeStore

POST = "https://www.reddit.com/r/localseo/comments/1abc2de/how_long_does_gbp_verification_take/"
QUESTION = "How long does Google Business Profile verification take for a new dentist?"
CSV = (
    "question,answer,group,notes\n"
    "How long does GBP verification take?,Usually a week or two. Keep your details the same "
    "everywhere while you wait. Is it a new listing?,r/localseo,very good\n"
    "Can I use a PO box for my GBP?,Sadly no. Google wants a real address you can be visited "
    "at.,,\n"
    ",missing question,,\n"
    "Can I use a PO box for my GBP?,Sadly no. Google wants a real address you can be visited "
    "at.,,\n"
)


@pytest.fixture
def web(ask_client: Callable[[], TestClient]) -> Callable[[User], TestClient]:
    def make(user: User) -> TestClient:
        c = ask_client()
        sign_in(c, user.email)
        return c

    return make


@pytest.fixture
def owner(make_user: UserFactory) -> User:
    return make_user(Role.OWNER, name="Olivia")


@pytest.fixture
def boss(web: Callable[[User], TestClient], owner: User) -> TestClient:
    return web(owner)


@pytest.fixture
def send(clean_engine: Engine, store: FakeStore) -> Callable[[], int]:
    factory = sessionmaker(bind=clean_engine, expire_on_commit=False)

    def run() -> int:
        total = 0
        while sent := sync.process(factory, store):
            total += sent
        return total

    return run


def upload(client: TestClient, slug: str, content: bytes | str, name: str = "examples.csv") -> Any:
    data = content.encode() if isinstance(content, str) else content
    return client.post(f"/api/voice/{slug}/file", files={"file": (name, data)})


def xlsx(rows: list[list[str]]) -> bytes:
    book = Workbook()
    sheet = book.active
    assert sheet is not None
    for row in rows:
        sheet.append(row)
    out = io.BytesIO()
    book.save(out)
    return out.getvalue()


def platform(db: Session, slug: str) -> Platform:
    marketing.platforms(db)
    found = db.scalar(select(Platform).where(Platform.slug == slug))
    assert found is not None
    return found


def examples(db: Session, slug: str) -> list[VoiceExample]:
    db.expire_all()
    p = platform(db, slug)
    return list(
        db.scalars(
            select(VoiceExample)
            .where(VoiceExample.platform_id == p.id)
            .order_by(VoiceExample.created_at)
        )
    )


# --- uploading examples -------------------------------------------------------------------


def test_uploading_examples_for_a_platform(
    boss: TestClient, db: Session, store: FakeStore, send: Callable[[], int]
) -> None:
    response = upload(boss, "reddit", CSV)

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["added"], body["skipped"], body["duplicates"]) == (2, 1, 1)
    assert body["voice"]["from_file"] == 2
    assert body["voice"]["file"]["name"] == "examples.csv"
    assert body["voice"]["file"]["uploaded_by"]["name"] == "Olivia"
    first = examples(db, "reddit")[0]
    assert (first.community, first.notes, first.source) == ("r/localseo", "very good", "file")
    # Searched by its question, in Reddit's own namespace only.
    send()
    space = store.data["voice-reddit"]
    assert {str(r["text"]) for r in space.values()} == {
        "How long does GBP verification take?",
        "Can I use a PO box for my GBP?",
    }
    assert "voice-facebook" not in store.data
    assert boss.get("/api/voice/facebook").json()["from_file"] == 0


def test_excel_files_and_other_column_names_work(boss: TestClient, db: Session) -> None:
    content = xlsx(
        [
            ["Facebook examples"],
            ["Their question", "Our answer", "Group (optional)"],
            ["Do reviews help ranking?", "They help, steady ones most.", "localbiz"],
        ]
    )
    response = upload(boss, "facebook", content, "Facebook examples.xlsx")
    assert response.status_code == 200, response.text
    [example] = examples(db, "facebook")
    assert (example.question, example.answer, example.community) == (
        "Do reviews help ranking?",
        "They help, steady ones most.",
        "localbiz",
    )


@pytest.mark.parametrize(
    ("content", "name", "status", "message"),
    [
        ("title,body\nQ,A\n", "x.csv", 422, "“question” and “answer” columns"),
        ("question,answer\n,only answer\n", "x.csv", 422, "each row needs a question"),
        (b"%PDF-1.4 not a sheet", "x.pdf", 415, "Excel (.xlsx) or CSV"),
        (b"", "x.csv", 415, "empty"),
    ],
)
def test_bad_files_say_what_to_fix(
    boss: TestClient, content: str | bytes, name: str, status: int, message: str
) -> None:
    response = upload(boss, "reddit", content, name)
    assert response.status_code == status, response.text
    assert message in response.json()["error"]["message"]


def test_a_new_file_replaces_the_old_examples_but_keeps_approved_replies(
    boss: TestClient, db: Session, owner: User, store: FakeStore, send: Callable[[], int]
) -> None:
    upload(boss, "reddit", CSV)
    p = platform(db, "reddit")
    posted = VoiceExample(
        platform_id=p.id,
        source=VoiceSource.POSTED,
        state=VoiceState.ACTIVE,
        question="Is GBP free?",
        answer="Yes, it costs nothing.",
    )
    db.add(posted)
    db.flush()
    outbox.upsert(db, "voice-reddit", [posted.record_id])
    db.commit()
    send()

    upload(boss, "reddit", "question,answer\nDo I need a website?,Not strictly.\n", "v2.csv")
    send()

    kept = {(e.question, e.source) for e in examples(db, "reddit")}
    assert kept == {("Do I need a website?", "file"), ("Is GBP free?", "posted")}
    texts = {str(r["text"]) for r in store.data["voice-reddit"].values()}
    assert texts == {"Do I need a website?", "Is GBP free?"}
    assert boss.get("/api/voice/reddit").json()["file"]["name"] == "v2.csv"


# --- one example ------------------------------------------------------------------------------


def test_switching_off_starring_and_editing_an_example(
    boss: TestClient, db: Session, store: FakeStore, send: Callable[[], int]
) -> None:
    upload(boss, "reddit", CSV)
    send()
    example = examples(db, "reddit")[0]

    off = boss.patch(f"/api/voice/examples/{example.id}", json={"enabled": False})
    assert off.status_code == 200 and off.json()["enabled"] is False
    send()
    assert example.record_id not in store.data["voice-reddit"]

    boss.patch(
        f"/api/voice/examples/{example.id}",
        json={"enabled": True, "starred": True, "question": "How long is verification?"},
    )
    send()
    assert store.data["voice-reddit"][example.record_id]["text"] == "How long is verification?"
    assert examples(db, "reddit")[0].starred is True

    listed = boss.get("/api/voice/reddit/examples", params={"q": "verification"}).json()
    assert listed["total"] == 1 and listed["items"][0]["starred"] is True

    assert boss.delete(f"/api/voice/examples/{example.id}").status_code == 204
    send()
    assert example.record_id not in store.data["voice-reddit"]
    assert len(examples(db, "reddit")) == 1


# --- who can change what ----------------------------------------------------------------------


@pytest.mark.parametrize("role", [Role.REVIEWER, Role.USER])
def test_everyone_can_see_and_try_but_only_the_owner_changes(
    role: Role,
    boss: TestClient,
    web: Callable[[User], TestClient],
    make_user: UserFactory,
    db: Session,
    store: FakeStore,
) -> None:
    upload(boss, "reddit", CSV)
    example = examples(db, "reddit")[0]
    other = web(make_user(role))

    assert other.get("/api/voice").status_code == 200
    seen = other.get("/api/voice/reddit").json()
    assert seen["from_file"] == 2 and seen["can_manage"] is False
    assert other.get("/api/voice/reddit/examples").json()["total"] == 2
    assert other.post("/api/voice/reddit/try", json={"question": QUESTION}).status_code == 200

    assert upload(other, "reddit", CSV).status_code == 403
    assert (
        other.patch(f"/api/voice/examples/{example.id}", json={"enabled": False}).status_code == 403
    )
    assert other.delete(f"/api/voice/examples/{example.id}").status_code == 403
    assert other.post(f"/api/voice/examples/{example.id}/approve", json={}).status_code == 403
    assert other.post(f"/api/voice/examples/{example.id}/dismiss").status_code == 403
    assert other.put("/api/voice/reddit/guide", json={"text": "x"}).status_code == 403
    assert other.post("/api/voice/reddit/guide/rewrite").status_code == 403
    rules = {"max_words": 80, "emojis": "none", "links": "never", "banned": []}
    assert other.put("/api/voice/reddit/rules", json=rules).status_code == 403
    assert boss.get("/api/voice/reddit").json()["can_manage"] is True


def test_signed_out_people_get_nothing(client: TestClient) -> None:
    assert client.get("/api/voice/reddit").status_code == 401
    assert client.post("/api/voice/reddit/file", files={"file": ("x.csv", b"q")}).status_code == 401


# --- the style guide and writing rules -----------------------------------------------------------


def test_the_ai_writes_the_style_guide_after_an_upload(
    boss: TestClient,
    db: Session,
    answerer: FakeAnswerer,
    run_jobs: RunJobs,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.answering.claude_answer.get_answerer", lambda db=None: answerer)
    upload(boss, "reddit", CSV)
    run_jobs()

    body = boss.get("/api/voice/reddit").json()
    assert body["guide"] == answerer.guide_reply
    assert body["guide_edited"] is False and body["guide_at"]
    assert "Can I use a PO box for my GBP?" in answerer.guides[0]

    # The Owner's edit is kept when new examples arrive…
    edited = boss.put("/api/voice/reddit/guide", json={"text": "- Keep it short."}).json()
    assert edited["guide_edited"] is True
    upload(boss, "reddit", "question,answer\nQ two?,A two.\n", "v2.csv")
    run_jobs()
    assert boss.get("/api/voice/reddit").json()["guide"] == "- Keep it short."

    # …until "Rewrite from examples".
    answerer.guide_reply = "- Plain words only."
    rewritten = boss.post("/api/voice/reddit/guide/rewrite").json()
    assert (rewritten["guide"], rewritten["guide_edited"]) == ("- Plain words only.", False)


def test_rewriting_needs_examples(boss: TestClient) -> None:
    response = boss.post("/api/voice/facebook/guide/rewrite")
    assert response.status_code == 409
    assert "Add examples first" in response.json()["error"]["message"]


def test_writing_rules_are_saved(boss: TestClient, db: Session) -> None:
    response = boss.put(
        "/api/voice/facebook/rules",
        json={
            "max_words": 80,
            "emojis": "none",
            "links": "never",
            "banned": ["game-changer", "DM me", "DM me"],
            "disclosure_line": " (I work at GridRankers.) ",
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["rules"] == {
        "max_words": 80,
        "emojis": "none",
        "links": "never",
        "banned": ["game-changer", "DM me"],
        "disclosure_line": "(I work at GridRankers.)",
    }
    p = platform(db, "facebook")
    db.refresh(p)
    assert voice.rules(p) == [
        "At most 80 words.",
        "No emojis.",
        "No links.",
        "Never use these words or phrases: “game-changer”, “DM me”.",
    ]
    bad = boss.put(
        "/api/voice/facebook/rules", json={"max_words": 3, "emojis": "one", "links": "never"}
    )
    assert bad.status_code == 422


# --- picking examples for a draft -----------------------------------------------------------------


def add_example(
    db: Session,
    p: Platform,
    store: FakeStore,
    question: str,
    answer: str,
    **fields: Any,
) -> VoiceExample:
    example = VoiceExample(
        platform_id=p.id,
        source=fields.pop("source", VoiceSource.FILE),
        state=fields.pop("state", VoiceState.ACTIVE),
        question=question,
        answer=answer,
        **fields,
    )
    db.add(example)
    db.flush()
    store.upsert(voice.namespace(p), [{"_id": example.record_id, "text": question}])
    return example


def test_close_examples_are_picked_with_the_same_group_preferred(
    db: Session, store: FakeStore
) -> None:
    p = platform(db, "reddit")
    general = add_example(db, p, store, "How long does verification take?", "A week or two.")
    local = add_example(
        db,
        p,
        store,
        "How long does verification take here?",
        "Depends on the postcard, usually soon.",
        community="r/localseo",
    )
    add_example(db, p, store, "Do reviews help ranking?", "Steady ones do.")

    picked = voice.pick(db, store, p, "How long does verification take?", "r/localseo")

    assert picked.matched
    assert [e.id for e in picked.examples][:2] == [local.id, general.id]
    assert all("reviews" not in e.question for e in picked.examples)


def test_near_copies_are_skipped_and_recent_ones_rotate(db: Session, store: FakeStore) -> None:
    p = platform(db, "reddit")
    same = "Usually a week or two by postcard, keep your details the same."
    a = add_example(db, p, store, "How long does verification take?", same)
    b = add_example(db, p, store, "How long does verification take now?", same)
    c = add_example(db, p, store, "How long does verification take, mostly?", "Ten days.")

    picked = voice.pick(db, store, p, "How long does verification take?", None)
    ids = [e.id for e in picked.examples]
    assert a.id in ids and b.id not in ids and c.id in ids  # b is a near-copy of a

    voice.mark_used([a])
    db.flush()
    again = voice.pick(db, store, p, "How long does verification take?", None)
    # a was just used: it steps back, and its near-copy b may take its place.
    assert again.examples[0].id in (b.id, c.id)
    assert a.id not in [e.id for e in again.examples[:1]]


def test_with_no_close_example_typical_ones_are_used(db: Session, store: FakeStore) -> None:
    p = platform(db, "reddit")
    star = add_example(db, p, store, "Do reviews help?", "Steady ones do.", starred=True)
    add_example(db, p, store, "Is GBP free?", "Yes.")
    add_example(db, p, store, "Can I add photos?", "Yes, lots.")
    off = add_example(db, p, store, "Unrelated words entirely", "x", enabled=False)

    picked = voice.pick(db, store, p, "Something completely different", None)

    assert not picked.matched
    assert len(picked.examples) == voice.TYPICAL and picked.examples[0].id == star.id
    assert off.id not in [e.id for e in picked.examples]


def test_other_platforms_examples_are_never_used(db: Session, store: FakeStore) -> None:
    facebook = platform(db, "facebook")
    reddit = platform(db, "reddit")
    add_example(db, facebook, store, "How long does verification take?", "Facebook style!")
    picked = voice.pick(db, store, reddit, "How long does verification take?", None)
    assert picked.examples == []


# --- drafts use the brand voice ------------------------------------------------------------------


def test_a_draft_uses_the_style_guide_rules_and_close_examples(
    web: Callable[[User], TestClient],
    make_user: UserFactory,
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
) -> None:
    sara = make_user(Role.USER, name="Sara")
    add_doc(db, store, sara, "GBP guide.pdf", [f"{QUESTION} It takes 5 to 14 days."])
    p = platform(db, "reddit")
    p.voice_guide = "- 2-4 short sentences."
    p.voice_max_words = 60
    p.voice_banned = ["guaranteed"]
    example = add_example(
        db, p, store, "How long does GBP verification take?", "Usually a week or two, mate."
    )
    db.commit()
    client = web(sara)
    thread = client.post("/api/threads", json={"url": POST, "question": QUESTION}).json()

    after = client.post(
        f"/api/threads/{thread['id']}/draft", json={"parent_id": thread["messages"][0]["id"]}
    ).json()

    prompt = answerer.drafts[-1]
    assert "<brand_voice>" in prompt and "- 2-4 short sentences." in prompt
    assert "At most 60 words." in prompt and "“guaranteed”" in prompt
    assert "<style_examples>" in prompt and "Usually a week or two, mate." in prompt
    ours = [m for m in after["messages"] if m["author"] == "us"][-1]
    assert ours["draft"]["style_examples"] == [
        {"id": str(example.id), "question": "How long does GBP verification take?"}
    ]
    db.refresh(example)
    assert example.used_count == 1 and example.last_used_at is not None


def test_a_draft_without_a_brand_voice_is_unchanged(
    web: Callable[[User], TestClient],
    make_user: UserFactory,
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
) -> None:
    sara = make_user(Role.USER, name="Sara")
    client = web(sara)
    thread = client.post("/api/threads", json={"url": POST, "question": QUESTION}).json()
    client.post(
        f"/api/threads/{thread['id']}/draft", json={"parent_id": thread["messages"][0]["id"]}
    )
    prompt = answerer.drafts[-1]
    # Writing rules have defaults, but there is no guide and there are no examples.
    assert "<style_examples>" not in prompt and "Style guide:" not in prompt


# --- suggestions from posted replies ----------------------------------------------------------


def test_posted_replies_wait_for_approval(
    web: Callable[[User], TestClient],
    boss: TestClient,
    make_user: UserFactory,
    db: Session,
    store: FakeStore,
    send: Callable[[], int],
) -> None:
    sara = make_user(Role.USER, name="Sara")
    add_doc(db, store, sara, "GBP guide.pdf", [f"{QUESTION} It takes 5 to 14 days."])
    client = web(sara)
    thread = client.post(
        "/api/threads", json={"url": POST, "question": QUESTION, "author_name": "u/dan"}
    ).json()
    drafted = client.post(
        f"/api/threads/{thread['id']}/draft", json={"parent_id": thread["messages"][0]["id"]}
    ).json()
    draft = [m for m in drafted["messages"] if m["author"] == "us"][-1]
    assert client.post(f"/api/thread-messages/{draft['id']}/posted", json={}).status_code == 200

    waiting = boss.get("/api/voice/reddit/examples", params={"state": "suggested"}).json()
    [suggestion] = waiting["items"]
    assert (suggestion["question"], suggestion["answer"]) == (QUESTION, draft["body"])
    assert suggestion["created_by"]["name"] == "Sara"
    assert boss.get("/api/voice").json()[0]["suggested"] == 1

    approved = boss.post(
        f"/api/voice/examples/{suggestion['id']}/approve", json={"answer": "Edited answer."}
    )
    assert approved.status_code == 200
    assert (approved.json()["state"], approved.json()["answer"]) == ("active", "Edited answer.")
    send()
    assert any(r["text"] == QUESTION for r in store.data["voice-reddit"].values())
    again = boss.post(f"/api/voice/examples/{suggestion['id']}/dismiss")
    assert again.status_code == 409


def test_a_correction_after_posting_updates_the_suggestion(db: Session) -> None:
    p = platform(db, "reddit")
    thread = Thread(
        id="reddit:abc123",
        platform_id=p.id,
        title="T",
        original_url="",
        status=ThreadStatus.WAITING_FOR_THEM,
        last_activity_at=now(),
    )
    db.add(thread)
    db.flush()
    them = ThreadMessage(thread_id=thread.id, author=MessageAuthor.THEM, body="Is GBP free?")
    db.add(them)
    db.flush()
    ours = ThreadMessage(
        thread_id=thread.id,
        parent_id=them.id,
        author=MessageAuthor.US,
        body="Yes.",
        state=DraftState.POSTED,
    )
    db.add(ours)
    db.flush()
    db.refresh(thread)

    suggestion = voice.suggest_from_post(db, ours)
    assert suggestion is not None and suggestion.question == "Is GBP free?"
    assert voice.suggest_from_post(db, ours) is None  # once per posted reply
    voice.correct_suggestion(db, ours, "Yes, it's free.")
    assert (suggestion.answer, suggestion.corrected) == ("Yes, it's free.", True)

    suggestion.state = VoiceState.ACTIVE  # once approved, later corrections don't change it
    voice.correct_suggestion(db, ours, "Changed again.")
    assert suggestion.answer == "Yes, it's free."


# --- Try it ------------------------------------------------------------------------------------


def test_try_it_shows_the_draft_its_examples_and_the_checks(
    boss: TestClient, db: Session, store: FakeStore, answerer: FakeAnswerer, owner: User
) -> None:
    add_doc(db, store, owner, "GBP guide.pdf", [f"{QUESTION} It takes 5 to 14 days."])
    p = platform(db, "reddit")
    p.voice_max_words = 10
    p.voice_banned = ["guaranteed"]
    add_example(db, p, store, "How long does GBP verification take?", "A week or two.")
    db.commit()
    answerer.draft_reply = "Guaranteed in a week, see https://example.com for the full steps 😀"

    response = boss.post("/api/voice/reddit/try", json={"question": QUESTION})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["text"].startswith("Guaranteed in a week")
    assert body["matched"] is True
    assert body["examples"][0]["answer"] == "A week or two."
    assert body["sources"] == ["GBP guide.pdf · p.1"]
    assert body["checks"] == {
        "words": 11,
        "max_words": 10,
        "too_long": True,
        "links": True,
        "emojis": 1,
        "banned": ["guaranteed"],
    }
    # A test draft is never saved or counted as a use.
    assert examples(db, "reddit")[0].used_count == 0


# --- Pinecone: Check, Rebuild and Settings → Connections --------------------------------------


def test_rebuild_includes_each_platforms_namespace(
    boss: TestClient, db: Session, store: FakeStore, send: Callable[[], int]
) -> None:
    upload(boss, "reddit", CSV)
    send()
    store.data["voice-reddit"]["vx_stray"] = {"_id": "vx_stray", "text": "old"}

    reconcile(db, store, rebuild=False, by=None)
    db.commit()
    send()

    assert "vx_stray" not in store.data["voice-reddit"]
    assert len(store.data["voice-reddit"]) == 2


def test_settings_show_the_namespaces_in_use(
    boss: TestClient, db: Session, send: Callable[[], int]
) -> None:
    upload(boss, "reddit", CSV)
    send()
    groups = boss.get("/api/connections").json()["groups"]
    pinecone = next(g for g in groups if g["id"] == "pinecone")
    rows = {n["namespace"]: n for n in pinecone["namespaces"]}
    assert rows["docs"]["used_for"] == "Knowledge base (facts)"
    assert rows["voice-reddit"]["records"] == 2
    assert rows["voice-reddit"]["used_for"] == "Brand voice: Reddit"
    assert rows["voice-reddit"]["last_synced"] is not None
    assert rows["voice-facebook"]["records"] == 0 and not rows["voice-facebook"]["pending"]
