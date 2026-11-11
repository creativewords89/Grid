"""Question Bank (SPEC section 6.9a, steps 27 and 29).

Real questions come in sets (a Facebook group, Reddit, client emails…). Owners and Reviewers
answer them one thread at a time. Each selected or written answer is kept separate;
approving a thread turns each of its answers into a verified answer (origin `facebook`, the
Question Bank's origin since step 27), so it is searched like any other within seconds.
"""

import contextlib
import json
import re
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import func, or_, select, true
from sqlalchemy.orm import Session

from app import audit
from app.ai import usage as usage_log
from app.ai.usage import Usage
from app.answering.claude_answer import Answerer
from app.answering.prompts import rework_message
from app.auth.tokens import now
from app.db.models import (
    FbPost,
    FbStatus,
    FbThread,
    QuestionSet,
    UsageKind,
    User,
    VerifiedAnswer,
    VerifiedOrigin,
    VerifiedStatus,
)
from app.verified import service as verified
from app.verified.service import MAX_TEXT, VerifiedError

MAX_ANSWERS = 6
MAX_THREADS = 20_000  # per set
MAX_NAME = 120
MAX_LABEL = 500
MAX_TITLE = 2000
STATUS_FROM_FILE = {
    "final": FbStatus.APPROVED,
    "approved": FbStatus.APPROVED,
    "done": FbStatus.APPROVED,
    "draft": FbStatus.DRAFT,
    "skip": FbStatus.SKIPPED,
    "skipped": FbStatus.SKIPPED,
}


class FbError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


# --- reading the threads -----------------------------------------------------------------------


def count_comments(comments: list[Any]) -> int:
    total = 0
    for c in comments:
        if isinstance(c, list) and len(c) >= 3:
            total += 1 + count_comments(c[2] if isinstance(c[2], list) else [])
    return total


def comment_at(post: FbPost, path: str) -> tuple[str, str] | None:
    """The (name, text) of the comment at "3.1" (the 4th comment's 2nd reply)."""
    level: list[Any] = post.comments
    found: list[Any] | None = None
    for part in path.split("."):
        if not part.isdigit() or int(part) >= len(level):
            return None
        found = level[int(part)]
        if not isinstance(found, list) or len(found) < 3:
            return None
        level = found[2] if isinstance(found[2], list) else []
    if found is None:
        return None
    return str(found[0] or ""), str(found[1] or "")


def posts_of(db: Session, thread: FbThread) -> list[FbPost]:
    by_row = {
        p.row: p
        for p in db.scalars(
            select(FbPost).where(FbPost.set_id == thread.set_id, FbPost.row.in_(thread.rows))
        )
    }
    return [by_row[r] for r in thread.rows if r in by_row]


def _one_line(text: str, limit: int) -> str:
    return re.sub(r"\s+", " ", text).strip()[:limit]


def also_asked(posts: list[FbPost]) -> str:
    """The posts' own wording, so a visitor's phrasing can match it too."""
    return " || ".join(_one_line(p.question, 300) for p in posts if p.question.strip())[:4000]


# --- answers -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class Item:
    label: str
    picks: list[str]
    text: str

    def to_json(self) -> dict[str, Any]:
        return {"label": self.label, "picks": self.picks, "text": self.text}


def clean_items(raw: Any) -> list[Item]:
    """Each answer on its own: never merged. Empty ones (no text, no comment) are dropped."""
    if not isinstance(raw, list):
        raise FbError(422, "invalid", "The answers aren't in the right shape.")
    items: list[Item] = []
    for entry in raw:
        if not isinstance(entry, dict):
            raise FbError(422, "invalid", "The answers aren't in the right shape.")
        label = str(entry.get("label") or "").strip()
        text = str(entry.get("text") or "").strip()
        picks_raw = entry.get("picks") or []
        if not isinstance(picks_raw, list):
            raise FbError(422, "invalid", "The answers aren't in the right shape.")
        picks = [str(p) for p in picks_raw if re.fullmatch(r"\d+:\d+(\.\d+)*", str(p))][:20]
        if len(text) > MAX_TEXT:
            raise FbError(422, "invalid", "An answer is over 20,000 characters.")
        if len(label) > MAX_LABEL:
            raise FbError(422, "invalid", "A “when it applies” note is over 500 characters.")
        if text or picks:
            items.append(Item(label, picks, text))
    if len(items) > MAX_ANSWERS:
        raise FbError(422, "invalid", f"Keep it to {MAX_ANSWERS} answers per question.")
    return items


def save(
    db: Session,
    thread: FbThread,
    by: User,
    title: str,
    items: list[Item],
    status: FbStatus,
) -> None:
    """Save a thread's answers with a status, and bring its verified answers in line."""
    title = title.strip()
    if len(title) > MAX_TITLE:
        raise FbError(422, "invalid", "The question is over 2,000 characters.")
    if status == FbStatus.APPROVED and not any(i.text for i in items):
        raise FbError(422, "empty", "Select an answer or write one first, then approve.")
    if status == FbStatus.DRAFT and not items:
        raise FbError(422, "empty", "Nothing to save yet. Select an answer or write one first.")
    before = thread.status.value
    thread.answer_title = title if title and title != thread.title else None
    thread.answers = [i.to_json() for i in items] if status != FbStatus.SKIPPED else []
    thread.status = status
    thread.answered_by = by.id
    thread.answered_at = now()
    sync_verified(db, thread, by)
    audit.record(
        db,
        by,
        "update",
        "fb_thread",
        thread.id,
        thread.title[:255],
        [{"field": "status", "from": before, "to": status.value}] if before != status else None,
    )


def clear(db: Session, thread: FbThread, by: User) -> None:
    thread.answer_title = None
    thread.answers = []
    thread.status = FbStatus.TODO
    thread.answered_by = None
    thread.answered_at = None
    sync_verified(db, thread, by)
    audit.record(db, by, "clear", "fb_thread", thread.id, thread.title[:255])


def _group(thread: FbThread) -> str:
    """The answer group of a thread's verified answers; their import keys are `{group}:{n}`."""
    return f"{thread.question_set.prefix}:{thread.key}"


def _prefix(thread: FbThread) -> str:
    return f"{_group(thread)}:"


def verified_of(db: Session, thread: FbThread) -> dict[str, VerifiedAnswer]:
    rows = db.scalars(
        select(VerifiedAnswer).where(
            VerifiedAnswer.import_key.startswith(_prefix(thread), autoescape=True),
            VerifiedAnswer.deleted_at.is_(None),
        )
    )
    return {va.import_key or "": va for va in rows}


def sync_verified(db: Session, thread: FbThread, by: User) -> None:
    """Approved: one verified answer per answer (made, updated or enabled); answers removed
    since go to trash. Anything else: its verified answers are disabled (SPEC 6.9a)."""
    existing = verified_of(db, thread)
    if thread.status != FbStatus.APPROVED:
        for va in existing.values():
            if va.status == VerifiedStatus.ACTIVE:
                verified.set_status(db, va, by, VerifiedStatus.DISABLED)
        return
    question = thread.answer_title or thread.title
    wordings = also_asked(posts_of(db, thread))
    answers = [a for a in thread.answers if str(a.get("text") or "").strip()]
    for n, answer in enumerate(answers, 1):
        key = f"{_prefix(thread)}{n}"
        text = str(answer["text"]).strip()
        label = str(answer.get("label") or "").strip()
        current = existing.pop(key) if key in existing else None
        if current is None:
            made = VerifiedAnswer(
                question=question,
                answer=text,
                applies_when=label or None,
                also_asked=wordings or None,
                answer_group=_group(thread),
                import_key=key,
                topic=verified.clean_topic(thread.topic),
                subtopic=verified.clean_topic(thread.subtopic),
                status=VerifiedStatus.ACTIVE,
                origin=VerifiedOrigin.FACEBOOK,
                created_by=by.id,
                approved_by=by.id,
                version=1,
            )
            db.add(made)
            db.flush()
            verified.add_version(db, made, by)
            verified.sync(db, made)
            audit.record(db, by, "create", "verified_answer", made.id, made.question)
            continue
        verified.edit(
            db,
            current,
            by,
            question,
            text,
            applies_when=label,
            also_asked=wordings,
            topic=thread.topic,
            subtopic=thread.subtopic,
        )
        current.approved_by = by.id
        if current.status != VerifiedStatus.ACTIVE:
            # An expiry date that has passed is left for a person to decide.
            with contextlib.suppress(VerifiedError):
                verified.set_status(db, current, by, VerifiedStatus.ACTIVE)
    for va in existing.values():
        verified.delete(db, va, by)


# --- Polish and Fit to post -------------------------------------------------------------------


@dataclass(frozen=True)
class Reworked:
    answer: str
    changes: list[str]


def _parse(text: str) -> Reworked | None:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        try:
            data = json.loads(match.group(0))
        except ValueError:
            data = None
        if isinstance(data, dict) and isinstance(data.get("answer"), str):
            changes = data.get("changes") or []
            notes = (
                [str(c).strip() for c in changes if str(c).strip()]
                if isinstance(changes, list)
                else []
            )
            return Reworked(data["answer"].strip(), notes[:6]) if data["answer"].strip() else None
    return None


def rework(
    db: Session,
    thread: FbThread,
    answerer: Answerer,
    by: User,
    mode: str,
    text: str,
    label: str = "",
    instruction: str = "",
) -> Reworked:
    """Polish one answer, or fit it to the thread's post. Never merges answers."""
    text = text.strip()
    if not text:
        raise FbError(422, "empty", "There's no answer text yet.")
    post = "\n---\n".join(p.question.strip() for p in posts_of(db, thread))[:4000]
    prompt = rework_message(
        mode,
        thread.answer_title or thread.title,
        post,
        text,
        label.strip()[:MAX_LABEL],
        instruction.strip()[:500],
    )
    completion = answerer.rework(prompt)
    spent = Usage()
    spent.add(completion.model, completion.input_tokens, completion.output_tokens)
    usage_log.record(db, by.id, UsageKind.DRAFT, spent)
    result = _parse(completion.text) if completion.stop_reason != "refusal" else None
    if result is None:
        raise FbError(502, "no_answer", "Claude didn't return an answer. Try again.")
    return result


# --- loading the data file -------------------------------------------------------------------


@dataclass
class Loaded:
    posts: int = 0
    threads: int = 0
    answers: int = 0


def _require(condition: bool, what: str) -> None:
    if not condition:
        raise FbError(422, "invalid", f"The data file isn't in the expected shape ({what}).")


def load(db: Session, qset: QuestionSet, data: Any, by: User) -> Loaded:
    """Add or update a set's posts (by row) and threads (by key). Saved answers are never
    touched; answers in the file fill threads that have none (SPEC 6.9a). The caller commits."""
    _require(isinstance(data, dict), "not an object")
    posts, threads = data.get("posts"), data.get("threads")
    _require(isinstance(posts, list) and isinstance(threads, list), "posts and threads")
    loaded = Loaded()

    have_posts = {p.row: p for p in db.scalars(select(FbPost).where(FbPost.set_id == qset.id))}
    talk: dict[int, int] = {}
    for raw in posts:
        _require(isinstance(raw, dict), "a post")
        row, question = raw.get("row"), raw.get("question")
        _require(isinstance(row, int) and isinstance(question, str), "a post's row and question")
        comments = raw.get("comments") or []
        picked = raw.get("picked") or []
        _require(isinstance(comments, list) and isinstance(picked, list), "comments")
        post = have_posts.get(row)
        if post is None:
            post = FbPost(set_id=qset.id, row=row, question=question)
            db.add(post)
            have_posts[row] = post
        post.question = question
        post.url = str(raw.get("url") or "")
        post.author = str(raw.get("author") or "") or None
        post.summary = str(raw.get("summary") or "")
        post.note = str(raw.get("note") or "") or None
        post.pinned = int(raw.get("pinned") or 0)
        post.comments = comments
        post.picked = picked
        talk[row] = count_comments(comments)
        loaded.posts += 1

    have_threads = {
        t.key: t for t in db.scalars(select(FbThread).where(FbThread.set_id == qset.id))
    }
    for raw in threads:
        _require(isinstance(raw, dict), "a thread")
        key, title, rows = raw.get("key"), raw.get("title"), raw.get("rows")
        _require(
            isinstance(key, str)
            and bool(key)
            and isinstance(title, str)
            and isinstance(rows, list)
            and all(isinstance(r, int) for r in rows),
            "a thread's key, title and rows",
        )
        thread = have_threads.get(key)
        if thread is None:
            thread = FbThread(set_id=qset.id, question_set=qset, key=key, title=title)
            db.add(thread)
            have_threads[key] = thread
        thread.title = title
        thread.topic = str(raw.get("topic") or "")
        thread.subtopic = str(raw.get("subtopic") or "")
        thread.rows = list(rows)
        thread.noise = bool(raw.get("noise"))
        thread.similar = str(raw.get("similar") or "") or None
        thread.talk = sum(talk.get(r, 0) for r in rows)
        loaded.threads += 1
    db.flush()

    answers = data.get("answers") or {}
    _require(isinstance(answers, dict), "answers")
    if len(have_threads) > MAX_THREADS:
        raise FbError(422, "too_many", f"A set holds at most {MAX_THREADS:,} questions.")
    for key, raw in answers.items():
        thread = have_threads.get(key)
        if thread is None or thread.status != FbStatus.TODO or thread.answers:
            continue
        if not isinstance(raw, dict):
            continue
        status = STATUS_FROM_FILE.get(str(raw.get("status") or ""))
        if status is None:
            continue
        items = clean_items(raw.get("items") or raw.get("angles") or [])
        try:
            save(db, thread, by, str(raw.get("title") or thread.title), items, status)
        except FbError:
            continue  # e.g. "approved" with no text: left to do
        loaded.answers += 1
    return loaded


def get(db: Session, thread_id: uuid.UUID) -> FbThread:
    thread = db.get(FbThread, thread_id)
    if thread is None:
        raise FbError(404, "not_found", "That thread doesn't exist.")
    return thread


# --- sets (step 29) -------------------------------------------------------------------------


def get_set(db: Session, set_id: uuid.UUID) -> QuestionSet:
    qset = db.get(QuestionSet, set_id)
    if qset is None:
        raise FbError(404, "not_found", "That question set doesn't exist.")
    return qset


def _clean_name(db: Session, name: str, other_than: uuid.UUID | None = None) -> str:
    name = re.sub(r"\s+", " ", name).strip()
    if not name:
        raise FbError(422, "invalid", "Give the set a name, e.g. “Reddit r/localseo”.")
    if len(name) > MAX_NAME:
        raise FbError(422, "invalid", f"Keep the name under {MAX_NAME} characters.")
    clash = db.scalar(
        select(QuestionSet).where(
            func.lower(QuestionSet.name) == name.lower(),
            QuestionSet.id != other_than if other_than else true(),
        )
    )
    if clash is not None:
        raise FbError(409, "exists", "A set with this name already exists.")
    return name


def create_set(db: Session, by: User, name: str, source: str = "", url: str = "") -> QuestionSet:
    qset = QuestionSet(
        name=_clean_name(db, name),
        source=_one_line(source, 100),
        url=url.strip()[:500],
        prefix=f"qb-{uuid.uuid4().hex[:12]}",
        created_by=by.id,
    )
    db.add(qset)
    db.flush()
    audit.record(db, by, "create", "question_set", qset.id, qset.name)
    return qset


def update_set(
    db: Session,
    qset: QuestionSet,
    by: User,
    name: str | None = None,
    source: str | None = None,
    url: str | None = None,
) -> None:
    changes = []
    if name is not None and name.strip() != qset.name:
        new = _clean_name(db, name, other_than=qset.id)
        changes.append({"field": "name", "from": qset.name, "to": new})
        qset.name = new
    if source is not None:
        qset.source = _one_line(source, 100)
    if url is not None:
        qset.url = url.strip()[:500]
    audit.record(db, by, "update", "question_set", qset.id, qset.name, changes or None)


def delete_set(db: Session, qset: QuestionSet, by: User) -> int:
    """Delete a set with its questions. Its verified answers go to the trash (restorable)."""
    trashed = 0
    for va in db.scalars(
        select(VerifiedAnswer).where(
            VerifiedAnswer.import_key.startswith(f"{qset.prefix}:", autoescape=True),
            VerifiedAnswer.deleted_at.is_(None),
        )
    ):
        verified.delete(db, va, by)
        trashed += 1
    audit.record(db, by, "delete", "question_set", qset.id, qset.name)
    db.delete(qset)
    return trashed


def set_counts(db: Session) -> dict[uuid.UUID, dict[str, int]]:
    counts: dict[uuid.UUID, dict[str, int]] = {}
    for set_id, status, n in db.execute(
        select(FbThread.set_id, FbThread.status, func.count()).group_by(
            FbThread.set_id, FbThread.status
        )
    ):
        counts.setdefault(set_id, {s.value: 0 for s in FbStatus})[status.value] = n
    return counts


# --- answers given before, in any set ---------------------------------------------------------


def _words(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) >= 3][:12]


def answered_like(
    db: Session, text: str, other_than: uuid.UUID | None = None, limit: int = 8
) -> list[FbThread]:
    """Threads with saved answers (approved or draft) whose question shares the most words
    with `text`, from every set: answers written once can be reused anywhere."""
    words = _words(text)
    if not words:
        return []
    candidates = db.scalars(
        select(FbThread)
        .where(
            FbThread.status.in_((FbStatus.APPROVED, FbStatus.DRAFT)),
            FbThread.id != other_than if other_than else true(),
            or_(
                *[
                    func.coalesce(FbThread.answer_title, FbThread.title).ilike(f"%{w}%")
                    for w in words
                ]
            ),
        )
        .limit(300)
    ).all()

    def score(t: FbThread) -> tuple[int, int]:
        have = set(_words(t.answer_title or t.title))
        return (len(have & set(words)), t.status == FbStatus.APPROVED)

    ranked = sorted(candidates, key=score, reverse=True)
    return [t for t in ranked if any(str(a.get("text") or "").strip() for a in t.answers)][:limit]
