"""Marketing threads (SPEC section 6.10): a person pastes a thread's URL, the engine drafts a
reply from GridRankers' knowledge, a person posts it, and later replies are added to the same
thread found again by its URL. The engine never posts or reads Reddit or Facebook itself.

The caller commits, except where noted.
"""

import logging
import re
import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit, settings_store
from app.ai import usage as usage_log
from app.ai.usage import Usage
from app.answering.claude_answer import Answerer
from app.answering.prompts import ForumMessage, draft_message, thread_block
from app.answering.retrieval import retrieve
from app.answering.service import score_answer
from app.auth.tokens import now
from app.db.models import (
    Answer,
    AnswerKind,
    AnswerStatus,
    CloseReason,
    Community,
    DraftState,
    MessageAuthor,
    Platform,
    PlatformParser,
    Review,
    ReviewState,
    Thread,
    ThreadMessage,
    ThreadStatus,
    TrashItem,
    TrashKind,
    UsageKind,
    User,
)
from app.ids import uuid7
from app.kb.store import VectorStore
from app.marketing.url_parser import Parsed, PlatformRule, UrlError, parse
from app.notifications import service as notifications
from app.reviews import service as reviews

log = logging.getLogger(__name__)

SIMILAR_NAME = 0.5  # trigram similarity for a close spelling of a name ("Dan Miller")
NAME_RESULTS = 20
MAX_TEXT = 20000

DEFAULT_PLATFORMS: list[dict[str, Any]] = [
    {
        "slug": "reddit",
        "name": "Reddit",
        "parser": PlatformParser.REDDIT,
        "style_prompt": (
            "Short, plain text, helpful, no sales tone. Links only if they really help. "
            "No emojis or Markdown headings."
        ),
        "disclosure_line": "(I work at GridRankers.)",
        "position": 1,
    },
    {
        "slug": "facebook",
        "name": "Facebook",
        "parser": PlatformParser.FACEBOOK,
        "style_prompt": (
            "Friendly and conversational. A soft mention of GridRankers is fine where the "
            "group allows it."
        ),
        "disclosure_line": "(I work at GridRankers.)",
        "position": 2,
    },
]


class MarketingError(Exception):
    def __init__(
        self, status: int, code: str, message: str, details: dict[str, Any] | None = None
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


# --- platforms -----------------------------------------------------------------------------


def platforms(db: Session) -> list[Platform]:
    """All platforms, creating Reddit and Facebook the first time (SPEC section 10)."""
    rows = list(db.scalars(select(Platform).order_by(Platform.position, Platform.name)))
    if rows:
        return rows
    for values in DEFAULT_PLATFORMS:
        db.add(Platform(**values))
    db.commit()
    return list(db.scalars(select(Platform).order_by(Platform.position, Platform.name)))


def rules(db: Session) -> list[PlatformRule]:
    return [
        PlatformRule(p.slug, p.parser.value, tuple(p.hosts or ()), p.enabled, p.name)
        for p in platforms(db)
    ]


def platform_of(db: Session, slug: str) -> Platform:
    platforms(db)  # Reddit and Facebook exist from the first read
    platform = db.scalar(select(Platform).where(Platform.slug == slug))
    if platform is None:
        raise MarketingError(404, "not_found", "Unknown platform.")
    return platform


def community_notes(db: Session, platform: Platform, community: str | None) -> str:
    if not community:
        return ""
    row = db.scalar(
        select(Community).where(
            Community.platform_id == platform.id, func.lower(Community.name) == community.lower()
        )
    )
    return row.notes if row else ""


# --- thread status ---------------------------------------------------------------------------

URGENCY = [
    ThreadStatus.WAITING_FOR_US,
    ThreadStatus.IN_REVIEW,
    ThreadStatus.READY_TO_POST,
    ThreadStatus.WAITING_FOR_THEM,
]


@dataclass(frozen=True)
class MessageView:
    id: uuid.UUID
    author: MessageAuthor
    parent_id: uuid.UUID | None
    state: DraftState | None
    order: int


def branch_status(them: MessageView, messages: list[MessageView]) -> ThreadStatus:
    ours = sorted(
        (
            m
            for m in messages
            if m.author == MessageAuthor.US
            and m.parent_id == them.id
            and m.state != DraftState.DISCARDED
        ),
        key=lambda m: m.order,
    )
    if any(m.state == DraftState.POSTED for m in ours):
        return ThreadStatus.WAITING_FOR_THEM
    if not ours:
        return ThreadStatus.WAITING_FOR_US
    latest = ours[-1].state
    if latest == DraftState.IN_REVIEW:
        return ThreadStatus.IN_REVIEW
    if latest == DraftState.READY:
        return ThreadStatus.READY_TO_POST
    return ThreadStatus.WAITING_FOR_US


def derive_status(messages: list[MessageView], closed: bool) -> ThreadStatus:
    """The status of the most urgent open branch (SPEC 6.10). Pure, so it is easy to test."""
    if closed:
        return ThreadStatus.CLOSED
    statuses = [branch_status(m, messages) for m in messages if m.author == MessageAuthor.THEM]
    if not statuses:
        return ThreadStatus.WAITING_FOR_US
    return min(statuses, key=URGENCY.index)


def views(thread: Thread) -> list[MessageView]:
    return [
        MessageView(m.id, m.author, m.parent_id, m.state, n)
        for n, m in enumerate(sorted(thread.messages, key=lambda m: (m.created_at, str(m.id))))
    ]


def refresh_status(db: Session, thread: Thread) -> None:
    db.flush()
    db.refresh(thread, attribute_names=["messages"])
    thread.status = derive_status(views(thread), thread.closed_at is not None)


def touch(thread: Thread) -> None:
    thread.last_activity_at = now()


# --- finding a thread by URL ------------------------------------------------------------------


@dataclass
class Resolved:
    parsed: Parsed
    thread: Thread | None
    matched_message_id: uuid.UUID | None
    reopened: bool


def live_thread(db: Session, thread_id: str) -> Thread | None:
    thread = db.get(Thread, thread_id)
    return thread if thread is not None and thread.deleted_at is None else None


def resolve(db: Session, url: str, by: User) -> Resolved:
    """What the "Paste a URL" box does: open the existing thread (reopening a closed one), or
    say it's new. The caller commits (a reopen is a change)."""
    try:
        parsed = parse(url, rules(db))
    except UrlError as error:
        raise MarketingError(422, "bad_url", str(error)) from None
    thread = live_thread(db, parsed.thread_id)
    if thread is None:
        return Resolved(parsed, None, None, False)
    matched = None
    if parsed.comment_id:
        matched = db.scalar(
            select(ThreadMessage.id).where(
                ThreadMessage.thread_id == thread.id,
                ThreadMessage.external_comment_id == parsed.comment_id,
            )
        )
    reopened = False
    if thread.closed_at is not None:
        reopen(db, thread, by)
        reopened = True
    return Resolved(parsed, thread, matched, reopened)


# --- finding a Facebook thread by the person's name ---------------------------------------------


def clean_name(name: str) -> str:
    return re.sub(r"\s+", " ", name).strip()[:120]


@dataclass
class NameMatch:
    thread: Thread
    first_question: str
    our_last_reply: str | None
    closest: bool


def by_name_platforms(db: Session) -> list[Platform]:
    return [p for p in platforms(db) if p.parser == PlatformParser.FACEBOOK]


def find_by_name(db: Session, name: str, text: str | None = None) -> list[NameMatch]:
    """Facebook threads of the person with this name (or a close spelling), newest first.
    With their new message, the thread whose wording is closest to it is marked. A person
    always checks the list and chooses: two people may share a name (SPEC 6.10)."""
    wanted = clean_name(name).lower()
    if not wanted:
        return []
    platform_ids = [p.id for p in by_name_platforms(db)]
    person = func.lower(Thread.person)
    threads = list(
        db.scalars(
            select(Thread)
            .where(
                Thread.platform_id.in_(platform_ids),
                Thread.deleted_at.is_(None),
                (person == wanted) | (func.similarity(person, wanted) >= SIMILAR_NAME),
            )
            .order_by(Thread.last_activity_at.desc())
            .limit(NAME_RESULTS)
        )
    )
    matches = [_name_match(t) for t in threads]
    if text and text.strip() and matches:
        scores = _similarities(db, text, [m.thread for m in matches])
        best = max(range(len(matches)), key=lambda i: scores[i])
        if scores[best] > 0:
            matches[best].closest = True
    return matches


def _name_match(thread: Thread) -> NameMatch:
    them = [m for m in thread.messages if m.author == MessageAuthor.THEM]
    ours = [
        m
        for m in thread.messages
        if m.author == MessageAuthor.US and m.state != DraftState.DISCARDED
    ]
    posted = [m for m in ours if m.state == DraftState.POSTED]
    last = max(posted or ours, key=lambda m: m.posted_at or m.created_at) if ours else None
    return NameMatch(
        thread=thread,
        first_question=them[0].body if them else thread.title,
        our_last_reply=last.body if last else None,
        closest=False,
    )


def _similarities(db: Session, text: str, threads: list[Thread]) -> list[float]:
    """How close the new message reads to each thread's own messages (best one counts)."""
    scores = []
    for thread in threads:
        bodies = [m.body for m in thread.messages if m.state != DraftState.DISCARDED]
        best = 0.0
        for body in bodies:
            value = db.scalar(select(func.word_similarity(text, body)))
            best = max(best, float(value or 0))
        scores.append(best)
    return scores


def create_by_name(db: Session, platform: Platform, person: str, by: User, question: str) -> Thread:
    """A new Facebook conversation: there is no link, so the ID is random (SPEC 6.10)."""
    if platform.parser != PlatformParser.FACEBOOK:
        raise MarketingError(422, "invalid", f"{platform.name} posts are found by their link.")
    if not platform.enabled:
        raise MarketingError(
            422, "invalid", f"Answering on {platform.name} is switched off in Settings."
        )
    person = clean_name(person)
    if not person:
        raise MarketingError(422, "invalid", "Type the person's name.")
    question = _question(question)
    thread = Thread(
        id=f"{platform.slug}:{uuid7().hex}",
        platform_id=platform.id,
        title=_title(question),
        original_url="",
        person=person,
        status=ThreadStatus.WAITING_FOR_US,
        created_by=by.id,
        last_activity_at=now(),
    )
    db.add(thread)
    db.add(
        ThreadMessage(
            thread_id=thread.id,
            author=MessageAuthor.THEM,
            author_name=person,
            body=question,
            created_by=by.id,
        )
    )
    audit.record(db, by, "create", "thread", thread.id, thread.title)
    db.flush()
    return thread


def _question(question: str) -> str:
    question = question.strip()
    if not question:
        raise MarketingError(422, "invalid", "Paste the question you want to answer.")
    if len(question) > MAX_TEXT:
        raise MarketingError(422, "invalid", "That text is too long.")
    return question


def _title(text: str) -> str:
    line = re.sub(r"\s+", " ", text).strip()
    return line if len(line) <= 120 else line[:119] + "…"


def create_thread(
    db: Session,
    url: str,
    by: User,
    question: str,
    title: str | None = None,
    author_name: str | None = None,
) -> Thread:
    resolved = resolve(db, url, by)
    if resolved.thread is not None:
        raise MarketingError(
            409,
            "exists",
            "This thread is already here. Open it to add their reply.",
            {"thread_id": resolved.thread.id},
        )
    question = _question(question)
    parsed = resolved.parsed
    platform = platform_of(db, parsed.platform)
    person = clean_name(author_name or "") or None
    thread = Thread(
        id=parsed.thread_id,
        platform_id=platform.id,
        community=parsed.community,
        title=(title or "").strip()[:300] or _title(question),
        original_url=parsed.clean_url or url.strip(),
        person=person,
        status=ThreadStatus.WAITING_FOR_US,
        created_by=by.id,
        last_activity_at=now(),
    )
    db.add(thread)
    db.add(
        ThreadMessage(
            thread_id=thread.id,
            author=MessageAuthor.THEM,
            author_name=person,
            body=question,
            external_url=parsed.clean_url,
            external_comment_id=parsed.comment_id,
            created_by=by.id,
        )
    )
    audit.record(db, by, "create", "thread", thread.id, thread.title)
    db.flush()
    return thread


def add_reply(
    db: Session,
    thread: Thread,
    by: User,
    body: str,
    parent_id: uuid.UUID | None = None,
    author_name: str | None = None,
    url: str | None = None,
) -> ThreadMessage:
    """Their reply in the thread, under the message it answers: the one chosen, else the
    comment the URL points to, else our latest posted reply."""
    body = body.strip()
    if not body:
        raise MarketingError(422, "invalid", "Paste their reply.")
    comment_id = _comment_in(db, thread, url)
    ids = {m.id for m in thread.messages}
    if parent_id is not None and parent_id not in ids:
        raise MarketingError(422, "invalid", "Choose a message from this thread.")
    if parent_id is None:
        parent_id = _default_parent(thread)
    if thread.closed_at is not None:
        reopen(db, thread, by)
    reply = ThreadMessage(
        thread_id=thread.id,
        parent_id=parent_id,
        author=MessageAuthor.THEM,
        author_name=(author_name or "").strip()[:120] or None,
        body=body,
        external_url=url.strip() if url else None,
        external_comment_id=comment_id,
        created_by=by.id,
    )
    db.add(reply)
    touch(thread)
    refresh_status(db, thread)
    return reply


def _comment_in(db: Session, thread: Thread, url: str | None) -> str | None:
    """The comment a link points to, for threads found by link. A Facebook thread keeps a
    link only as a note (its posts are found by name)."""
    if not url or thread.platform.parser == PlatformParser.FACEBOOK:
        return None
    try:
        parsed = parse(url, rules(db))
    except UrlError as error:
        raise MarketingError(422, "bad_url", str(error)) from None
    if parsed.thread_id != thread.id:
        raise MarketingError(422, "other_thread", "That link is for a different thread.")
    return parsed.comment_id


def _default_parent(thread: Thread) -> uuid.UUID | None:
    posted = [m for m in thread.messages if m.state == DraftState.POSTED]
    if posted:
        return max(posted, key=lambda m: m.posted_at or m.created_at).id
    them = [m for m in thread.messages if m.author == MessageAuthor.THEM]
    return them[0].id if them else None


def parent_for_comment(thread: Thread, comment_id: str | None) -> uuid.UUID | None:
    if not comment_id:
        return None
    for m in thread.messages:
        if m.external_comment_id == comment_id:
            return m.id
    return None


# --- drafts -----------------------------------------------------------------------------------


def _forum(thread: Thread) -> tuple[list[ForumMessage], dict[uuid.UUID, str]]:
    ordered = [
        m
        for m in sorted(thread.messages, key=lambda m: (m.created_at, str(m.id)))
        if m.author == MessageAuthor.THEM or m.state == DraftState.POSTED
    ]
    refs = {m.id: f"m{n + 1}" for n, m in enumerate(ordered)}
    out = []
    for m in ordered:
        corrected = None
        if m.author == MessageAuthor.US and m.answer and m.answer.current_text != m.body:
            corrected = m.answer.current_text
        out.append(
            ForumMessage(
                ref=refs[m.id],
                author=m.author.value,
                name=m.author_name,
                body=m.body,
                reply_to=refs.get(m.parent_id) if m.parent_id else None,
                corrected_text=corrected,
            )
        )
    return out, refs


def _mentions_us(text: str) -> bool:
    return re.search(r"grid\s*rankers", text, re.IGNORECASE) is not None


def with_disclosure(text: str, line: str | None) -> str:
    """SPEC 6.10 / open decision 1: a draft that mentions GridRankers says we work there."""
    if not line or not _mentions_us(text) or line.strip().lower() in text.lower():
        return text
    return f"{text.rstrip()}\n\n{line.strip()}"


def _discard_drafts(db: Session, thread: Thread, parent_id: uuid.UUID) -> None:
    for m in thread.messages:
        if (
            m.author == MessageAuthor.US
            and m.parent_id == parent_id
            and m.state in (DraftState.DRAFT, DraftState.IN_REVIEW, DraftState.READY)
        ):
            m.state = DraftState.DISCARDED
            if m.answer_id is not None:
                _cancel_reviews(db, m.answer_id)


def _cancel_reviews(db: Session, answer_id: uuid.UUID) -> None:
    waiting = db.scalars(
        select(Review).where(
            Review.answer_id == answer_id,
            Review.state.in_([ReviewState.OPEN, ReviewState.CLAIMED, ReviewState.NEEDS_INFO]),
        )
    ).all()
    for review in waiting:
        review.state = ReviewState.CANCELLED
        review.decided_at = now()
        review.prompt_message_id = None
        review.prompt_action = None
        reviews.enqueue_update(db, review)


def draft(
    db: Session,
    thread: Thread,
    parent_id: uuid.UUID,
    by: User,
    answerer: Answerer,
    store: VectorStore,
    instruction: str | None = None,
) -> ThreadMessage:
    """Draft our reply to one of their messages (SPEC 6.10). Commits: the draft is saved
    before its support check, like a chat answer."""
    target = next((m for m in thread.messages if m.id == parent_id), None)
    if target is None or target.author != MessageAuthor.THEM:
        raise MarketingError(422, "invalid", "Choose one of their messages to answer.")
    if thread.closed_at is not None:
        raise MarketingError(409, "closed", "This thread is closed. Reopen it first.")
    platform = thread.platform
    first = next(
        (
            m
            for m in sorted(thread.messages, key=lambda m: m.created_at)
            if m.author == MessageAuthor.THEM
        ),
        target,
    )
    query = target.body if first.id == target.id else f"{first.body}\n\n{target.body}"
    found = retrieve(db, store, query[:4000])
    forum, refs = _forum(thread)
    prompt = draft_message(
        platform=platform.name,
        style=platform.style_prompt,
        community=thread.community,
        community_notes=community_notes(db, platform, thread.community),
        items=found.items,
        thread=thread_block(forum, refs[target.id]),
        instruction=(instruction or "").strip()[:500] or None,
    )
    completion = answerer.draft(prompt)
    spent = Usage()
    spent.add(completion.model, completion.input_tokens, completion.output_tokens)
    refused = completion.stop_reason == "refusal" or not completion.text.strip()
    text = (
        "I can't draft a reply to this one. Please write it yourself or ask the team."
        if refused
        else with_disclosure(completion.text.strip(), platform.disclosure_line)
    )
    answer = Answer(
        kind=AnswerKind.MARKETING,
        asked_by=by.id,
        question=target.body,
        retrieval_query=query[:4000],
        original_text=text,
        current_text=text,
        sources=[],
        model=completion.model,
        stop_reason=completion.stop_reason,
        usage={
            "requests": spent.requests,
            "input_tokens": spent.input_tokens,
            "output_tokens": spent.output_tokens,
            "cost_usd": round(spent.cost_usd, 6),
            "context": [item.chunk_id for item in found.items],
        },
    )
    db.add(answer)
    db.flush()
    _discard_drafts(db, thread, target.id)
    message = ThreadMessage(
        thread_id=thread.id,
        parent_id=target.id,
        author=MessageAuthor.US,
        body=text,
        answer_id=answer.id,
        state=DraftState.DRAFT,
        created_by=by.id,
    )
    db.add(message)
    touch(thread)
    usage_log.record(db, by.id, UsageKind.DRAFT, spent)
    refresh_status(db, thread)
    db.commit()

    # The same confidence score as chat: low goes to review, high is ready to post.
    score_answer(db, target.body, by.id, answer, found.items, answerer, found.verified_hit)
    db.refresh(answer)
    message.state = (
        DraftState.IN_REVIEW if answer.status == AnswerStatus.IN_REVIEW else DraftState.READY
    )
    refresh_status(db, thread)
    db.commit()
    return message


def edit_draft(db: Session, message: ThreadMessage, by: User, body: str) -> ThreadMessage:
    if message.author != MessageAuthor.US or message.state not in (
        DraftState.DRAFT,
        DraftState.IN_REVIEW,
        DraftState.READY,
    ):
        raise MarketingError(409, "not_a_draft", "Only a draft that isn't posted can be edited.")
    body = body.strip()
    if not body or len(body) > MAX_TEXT:
        raise MarketingError(422, "invalid", "Write the reply.")
    message.body = body
    touch(message.thread)
    return message


def mark_posted(
    db: Session, message: ThreadMessage, by: User, url: str | None = None
) -> ThreadMessage:
    if message.author != MessageAuthor.US or message.state not in (
        DraftState.READY,
        DraftState.DRAFT,
    ):
        if message.state == DraftState.IN_REVIEW:
            raise MarketingError(409, "in_review", "Waiting for review – don't post yet.")
        raise MarketingError(409, "not_a_draft", "Only a draft that is ready can be posted.")
    thread = message.thread
    comment_id = _comment_in(db, thread, url)
    message.state = DraftState.POSTED
    message.posted_by = by.id
    message.posted_at = now()
    message.external_url = url.strip() if url else None
    message.external_comment_id = comment_id
    touch(thread)
    refresh_status(db, thread)
    audit.record(db, by, "posted", "thread", thread.id, thread.title)
    return message


def close(db: Session, thread: Thread, by: User | None, reason: CloseReason) -> None:
    thread.closed_at = now()
    thread.close_reason = reason
    thread.status = ThreadStatus.CLOSED
    audit.record(db, by, "close", "thread", thread.id, thread.title)


def reopen(db: Session, thread: Thread, by: User) -> None:
    thread.closed_at = None
    thread.close_reason = None
    touch(thread)
    refresh_status(db, thread)
    audit.record(db, by, "reopen", "thread", thread.id, thread.title)


def delete(db: Session, thread: Thread, by: User) -> None:
    thread.deleted_at = now()
    for m in thread.messages:
        if m.answer_id is not None:
            _cancel_reviews(db, m.answer_id)
    db.add(
        TrashItem(
            kind=TrashKind.THREAD,
            ref_id=uuid.uuid5(uuid.NAMESPACE_URL, thread.id),
            title=thread.title[:255],
            data={"thread_id": thread.id},
            deleted_by=by.id,
            deleted_at=thread.deleted_at,
        )
    )
    audit.record(db, by, "delete", "thread", thread.id, thread.title)


def auto_close(db: Session) -> int:
    """Daily 04:30: threads quiet for 14 days (setting) are closed (SPEC 6.10)."""
    days = settings_store.get_int(db, "thread_auto_close_days")
    quiet = db.scalars(
        select(Thread).where(
            Thread.deleted_at.is_(None),
            Thread.closed_at.is_(None),
            Thread.last_activity_at < now() - timedelta(days=days),
        )
    ).all()
    for thread in quiet:
        close(db, thread, None, CloseReason.INACTIVE)
    return len(quiet)


# --- after a review of a draft ------------------------------------------------------------------


def draft_for(db: Session, answer: Answer) -> ThreadMessage | None:
    return db.scalar(select(ThreadMessage).where(ThreadMessage.answer_id == answer.id))


def channel_label(db: Session, answer: Answer) -> str:
    message = draft_for(db, answer)
    if message is None:
        return "Marketing"
    thread = message.thread
    parts = ["Marketing", thread.platform.name]
    if thread.community:
        parts.append(thread.community)
    return " · ".join(parts)


def on_review_decided(db: Session, answer: Answer, action: str, by: User) -> None:
    """A reviewer decided a draft: unlock it for posting (or drop it), and tell the person
    who drafted it. A reply corrected after it was posted tells its poster (SPEC 6.10)."""
    message = draft_for(db, answer)
    if message is None:
        return
    thread = message.thread
    platform = thread.platform.name
    link = f"/marketing?thread={thread.id}"
    if message.state == DraftState.POSTED:
        if action in ("edit", "reject") and message.posted_by:
            poster = db.get(User, message.posted_by)
            if poster is not None and poster.id != by.id:
                notifications.notify(
                    db,
                    poster,
                    notifications.REPLY_CORRECTED,
                    "A reply you posted was corrected — consider editing your comment on "
                    + platform,
                    answer.current_text,
                    link,
                    ("thread", thread.id),
                )
        return
    if action == "needs_info":
        message.state = DraftState.IN_REVIEW
    elif action == "no_answer":
        message.state = DraftState.DISCARDED
    else:
        message.state = DraftState.READY
        message.body = answer.current_text
    refresh_status(db, thread)
    if answer.asked_by is None or answer.asked_by == by.id or action == "needs_info":
        return
    drafter = db.get(User, answer.asked_by)
    if drafter is None:
        return
    if action == "no_answer":
        title = f"Our team rejected a {platform} draft: write the reply yourself or redraft"
    else:
        title = f"Your {platform} draft is ready to post"
    notifications.notify(
        db, drafter, notifications.DRAFT_READY, title, thread.title, link, ("thread", thread.id)
    )
