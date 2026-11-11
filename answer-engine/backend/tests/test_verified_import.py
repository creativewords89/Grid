"""Importing verified answers from a file (SPEC section 6.9, step 26)."""

import io
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.answering.prompts import ANSWER_SYSTEM
from app.db.models import (
    AuditEntry,
    KbOp,
    Role,
    User,
    VerifiedAnswer,
    VerifiedAnswerVersion,
    VerifiedOrigin,
    VerifiedStatus,
)
from app.kb.store import VERIFIED
from app.verified import importing
from app.verified.service import search_text
from tests.asking import ask, new_chat
from tests.conftest import UserFactory, sign_in
from tests.fakes import FakeAnswerer, FakeStore

HEADER = "question,when_it_applies,answer,topic,subtopic,similar_questions,post_urls\n"
SAB = "Should I show my address on Google?"


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


def upload(client: TestClient, content: bytes | str, name: str = "answers.csv") -> Any:
    data = content.encode() if isinstance(content, str) else content
    return client.post("/api/verified/import", files={"file": (name, data)})


def xlsx(rows: list[list[str]]) -> bytes:
    book = Workbook()
    sheet = book.active
    assert sheet is not None
    for row in rows:
        sheet.append(row)
    out = io.BytesIO()
    book.save(out)
    return out.getvalue()


def answers(db: Session) -> list[VerifiedAnswer]:
    db.expire_all()
    return list(
        db.scalars(
            select(VerifiedAnswer)
            .where(VerifiedAnswer.deleted_at.is_(None))
            .order_by(VerifiedAnswer.created_at)
        )
    )


TWO_ANSWERS = (
    HEADER + f'"{SAB}",If customers visit you,"Yes, show it.",GBP,SAB,"Do I show my address? || '
    'Hide or show?",https://facebook.com/x\n'
    + f'"{SAB}",If you travel to customers,"No, hide it and set service areas.",GBP,SAB,,\n'
    + '"How long does verification take?",,"Usually a few days.",GBP,Verification,,\n'
)


# --- one verified answer per row --------------------------------------------------------------


def test_every_row_is_its_own_answer_and_two_answers_to_one_question_stay_separate(
    boss: TestClient, db: Session
) -> None:
    response = upload(boss, TWO_ANSWERS)

    assert response.status_code == 200, response.text
    assert response.json() == {"created": 3, "updated": 0, "unchanged": 0, "skipped": []}
    first, second, third = answers(db)
    assert (first.question, first.applies_when, first.answer) == (
        SAB,
        "If customers visit you",
        "Yes, show it.",
    )
    assert (second.applies_when, second.answer) == (
        "If you travel to customers",
        "No, hide it and set service areas.",
    )
    # Never merged: two records, one answer group.
    assert first.answer_group == second.answer_group != third.answer_group
    assert first.also_asked == "Do I show my address? || Hide or show?"
    assert {va.origin for va in (first, second, third)} == {VerifiedOrigin.IMPORT}
    assert {va.status for va in (first, second, third)} == {VerifiedStatus.ACTIVE}
    assert third.applies_when is None and third.also_asked is None
    # Each one is versioned, audited and queued for search.
    assert (
        db.scalar(
            select(VerifiedAnswerVersion).where(
                VerifiedAnswerVersion.verified_answer_id == first.id
            )
        )
        is not None
    )
    created = db.scalars(select(AuditEntry).where(AuditEntry.entity == "verified_answer")).all()
    assert len(created) == 3
    queued = [
        r
        for op in db.scalars(select(KbOp).where(KbOp.namespace == VERIFIED))
        for r in op.record_ids
    ]
    assert sorted(queued) == sorted(va.record_id for va in (first, second, third))


def test_search_text_has_the_wordings_and_when_it_applies(boss: TestClient, db: Session) -> None:
    upload(boss, TWO_ANSWERS)
    first, _, third = answers(db)

    assert search_text(first) == (
        f"Q: {SAB}\nAlso asked as: Do I show my address? || Hide or show?\n"
        "When it applies: If customers visit you\nA: Yes, show it."
    )
    assert search_text(third) == "Q: How long does verification take?\nA: Usually a few days."


def test_skipped_rows_say_which_row_and_why(boss: TestClient, db: Session) -> None:
    long_question = "Why " + "x" * 2000 + "?"
    content = (
        HEADER
        + '"A question with no answer?",,,,,,\n'
        + f'"{long_question}",,"An answer.",,,,\n'
        + '"Is it fine?",,"Yes.",,,,\n'
        + '"Is it fine?",,"Yes.",,,,\n'
    )

    response = upload(boss, content)

    body = response.json()
    assert (body["created"], body["updated"], body["unchanged"]) == (1, 0, 0)
    assert body["skipped"] == [
        {"row": 2, "reason": "No question or no answer."},
        {"row": 3, "reason": "The question is over 2,000 characters."},
        {"row": 5, "reason": "The same answer appears earlier in the file."},
    ]
    assert [va.question for va in answers(db)] == ["Is it fine?"]


def test_header_names_title_lines_bom_and_multi_line_cells(boss: TestClient, db: Session) -> None:
    content = (
        "﻿GridRankers answers\n"
        "Question,When it applies,Answer\n"
        '"Do posts help?",,"Yes.\nPost weekly, with a photo."\n'
    )

    assert upload(boss, content).json()["created"] == 1
    [va] = answers(db)
    assert va.answer == "Yes.\nPost weekly, with a photo."


def test_an_excel_file_works_too(boss: TestClient, db: Session) -> None:
    content = xlsx([["question", "angle", "answer"], [SAB, "Storefront", "Show it."]])

    response = upload(boss, content, "answers.xlsx")
    assert response.json().get("created") == 1, response.text
    [va] = answers(db)
    assert (va.question, va.applies_when, va.answer) == (SAB, "Storefront", "Show it.")


@pytest.mark.parametrize(
    ("content", "name", "status", "message"),
    [
        ("topic,notes\nGBP,x\n", "a.csv", 422, "“question” and “answer” columns"),
        ("question,answer\n,\n", "a.csv", 422, "No answers were found"),
        (b"%PDF-1.4 not a sheet", "a.pdf", 415, "CSV or Excel"),
    ],
)
def test_a_file_that_cant_be_used_changes_nothing(
    boss: TestClient, db: Session, content: str | bytes, name: str, status: int, message: str
) -> None:
    response = upload(boss, content, name)

    assert response.status_code == status
    assert message in response.json()["error"]["message"]
    assert answers(db) == []


def test_too_many_rows(boss: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(importing, "MAX_ROWS", 2)
    content = "question,answer\n" + "".join(f"Q{i}?,A{i}.\n" for i in range(3))

    response = upload(boss, content)

    assert response.status_code == 422
    assert "at most 2 answers" in response.json()["error"]["message"]


# --- importing an updated file ----------------------------------------------------------------


def test_importing_again_updates_instead_of_duplicating(boss: TestClient, db: Session) -> None:
    upload(boss, TWO_ANSWERS)
    first, second, third = answers(db)
    boss.post(f"/api/verified/{second.id}/disable")
    changed = TWO_ANSWERS.replace("Usually a few days.", "Usually 3 to 5 days.")

    body = upload(boss, changed).json()

    assert (body["created"], body["updated"], body["unchanged"]) == (0, 1, 2)
    now_first, now_second, now_third = answers(db)
    assert [va.id for va in (now_first, now_second, now_third)] == [first.id, second.id, third.id]
    assert now_third.answer == "Usually 3 to 5 days." and now_third.version == 2
    # A person's decision to disable one isn't undone by importing again.
    assert now_second.status == VerifiedStatus.DISABLED


def test_unlabelled_answers_match_by_their_position(boss: TestClient, db: Session) -> None:
    content = HEADER + '"Is SEO dead?",,"No.",,,,\n"Is SEO dead?",,"It changed.",,,,\n'
    assert upload(boss, content).json()["created"] == 2
    one, two = answers(db)
    assert one.answer_group == two.answer_group and one.import_key != two.import_key

    body = upload(boss, content.replace("It changed.", "It changed a lot.")).json()

    assert (body["created"], body["updated"], body["unchanged"]) == (0, 1, 1)
    assert [va.answer for va in answers(db)] == ["No.", "It changed a lot."]


def test_a_deleted_answer_imported_again_is_added_anew(boss: TestClient, db: Session) -> None:
    upload(boss, TWO_ANSWERS)
    _, _, third = answers(db)
    assert boss.delete(f"/api/verified/{third.id}").status_code == 204

    body = upload(boss, TWO_ANSWERS).json()

    assert (body["created"], body["unchanged"]) == (1, 2)
    assert len(answers(db)) == 3


def test_editing_when_it_applies_and_the_wordings(boss: TestClient, db: Session) -> None:
    upload(boss, TWO_ANSWERS)
    first = answers(db)[0]

    response = boss.patch(
        f"/api/verified/{first.id}",
        json={"applies_when": "If you have a showroom", "also_asked": ""},
    )

    assert response.status_code == 200
    body = response.json()
    assert (body["applies_when"], body["also_asked"], body["version"]) == (
        "If you have a showroom",
        None,
        2,
    )
    listed = boss.get("/api/verified?q=showroom").json()["items"]
    assert [row["id"] for row in listed] == [str(first.id)]


# --- topics (step 30) ---------------------------------------------------------------------------


def test_the_list_is_grouped_by_topic_with_counts(boss: TestClient, db: Session) -> None:
    upload(boss, TWO_ANSWERS + '"Is SEO dead?",,"No.",,,,\n')

    page = boss.get("/api/verified").json()

    assert page["topics"] == [
        {
            "name": "GBP",
            "count": 3,
            "subtopics": [{"name": "SAB", "count": 2}, {"name": "Verification", "count": 1}],
        },
        {"name": "", "count": 1, "subtopics": [{"name": "", "count": 1}]},
    ]
    # Grouped: topic, then subtopic, "No topic" last.
    assert [(r["topic"], r["subtopic"]) for r in page["items"]] == [
        ("GBP", "SAB"),
        ("GBP", "SAB"),
        ("GBP", "Verification"),
        ("", ""),
    ]
    one = boss.get("/api/verified", params={"topic": "GBP", "subtopic": "Verification"}).json()
    assert [r["question"] for r in one["items"]] == ["How long does verification take?"]
    assert len(one["topics"]) == 2  # the topic list doesn't shrink with the filter
    none = boss.get("/api/verified", params={"topic": ""}).json()
    assert [r["question"] for r in none["items"]] == ["Is SEO dead?"]


def test_changing_a_topic_needs_no_new_version_or_search_update(
    boss: TestClient, db: Session
) -> None:
    upload(boss, TWO_ANSWERS)
    first = answers(db)[0]
    db.execute(delete(KbOp))
    db.commit()

    body = boss.patch(
        f"/api/verified/{first.id}", json={"topic": "  Google  Business Profile ", "subtopic": ""}
    ).json()

    assert (body["topic"], body["subtopic"], body["version"]) == ("Google Business Profile", "", 1)
    assert db.scalars(select(KbOp)).all() == []
    entry = db.scalars(
        select(AuditEntry).where(
            AuditEntry.action == "update", AuditEntry.entity_id == str(first.id)
        )
    ).one()
    assert {c["field"] for c in entry.changes} == {"topic", "subtopic"}


def test_importing_again_fills_in_topics(boss: TestClient, db: Session) -> None:
    upload(boss, TWO_ANSWERS.replace(",GBP,", ",,"))
    assert {va.topic for va in answers(db)} == {""}

    body = upload(boss, TWO_ANSWERS).json()

    assert body["updated"] == 3
    assert {va.topic for va in answers(db)} == {"GBP"}
    assert {va.version for va in answers(db)} == {1}


# --- who can import ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("role", "allowed"), [(Role.OWNER, True), (Role.REVIEWER, False), (Role.USER, False)]
)
def test_only_owners_import(
    make_user: UserFactory,
    web: Callable[[User], TestClient],
    db: Session,
    role: Role,
    allowed: bool,
) -> None:
    client = web(make_user(role))

    assert client.get("/api/verified").json()["can_import"] is allowed
    response = upload(client, TWO_ANSWERS)

    assert response.status_code == (200 if allowed else 403)
    assert len(answers(db)) == (3 if allowed else 0)


def test_importing_needs_sign_in(client: TestClient) -> None:
    assert upload(client, TWO_ANSWERS).status_code == 401


# --- answering with several correct answers ---------------------------------------------------


def test_answering_sees_both_answers_with_one_group_and_is_told_not_to_blend(
    boss: TestClient,
    db: Session,
    store: FakeStore,
    answerer: FakeAnswerer,
    me: tuple[TestClient, User],
) -> None:
    upload(boss, TWO_ANSWERS)
    first, second, _ = answers(db)
    for va in (first, second):
        store.data.setdefault(VERIFIED, {})[va.record_id] = {
            "_id": va.record_id,
            "text": search_text(va),
        }
    client, _ = me
    answerer.reply = "Yes, show it [1]."

    ask(client, new_chat(client), SAB)

    prompt = answerer.prompts[0]
    group = f'group="{first.answer_group}"'
    assert prompt.count(group) == 2
    assert "When it applies: If customers visit you" in prompt
    assert "When it applies: If you travel to customers" in prompt
    assert "never blend them into one answer" in ANSWER_SYSTEM
