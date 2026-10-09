"""The review flow (SPEC section 6.7). The web queue and the Telegram bot both call these
functions, so a review behaves the same whichever channel a reviewer uses.

States: open → claimed → approved / edited / rejected, with needs_info in between while the
asker is asked a question. Claiming is one atomic UPDATE, so two reviewers pressing at the
same moment can't both get it. The caller commits.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app import audit, settings_store
from app.answering.confidence import explain
from app.auth.tokens import now
from app.db.models import (
    UNDECIDED,
    Answer,
    AnswerKind,
    AnswerOutcome,
    AnswerStatus,
    Message,
    Review,
    ReviewMessage,
    ReviewMessageKind,
    ReviewReason,
    ReviewState,
    Role,
    User,
)
from app.jobs.queue import enqueue

ACTIONS = ("approve", "edit", "reject", "no_answer", "needs_info")
NEEDS_TEXT = {"edit", "reject", "needs_info"}
MAX_TEXT = 20000

POST_JOB = "telegram_review"
UPDATE_JOB = "telegram_review_update"
NOTE_JOB = "telegram_review_note"


class ReviewError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def reason_label(review: Review) -> str:
    if review.reason == ReviewReason.LOW_CONFIDENCE:
        score = review.answer.confidence
        return f"Low confidence ({score})" if score is not None else "Low confidence"
    return {
        ReviewReason.NO_ANSWER: "No answer found",
        ReviewReason.FLAG: "Flagged 👎",
        ReviewReason.ADMIN: "Owner review",
    }[review.reason]


def channel_label(answer: Answer) -> str:
    return "Chat" if answer.kind == AnswerKind.CHAT else "Marketing"


def explanation(review: Review) -> str:
    return explain(review.answer.confidence_parts)


def _name(db: Session, user_id: uuid.UUID | None) -> str:
    if user_id is None:
        return "Someone"
    user = db.get(User, user_id)
    return user.name if user else "Someone"


# --- creating ------------------------------------------------------------------------------


def create(db: Session, answer: Answer, reason: ReviewReason) -> Review:
    """Open a review for an answer (or return the one already open) and post it to Telegram.
    Admin reviews are decided straight away on the web, so they aren't posted."""
    existing = db.scalar(
        select(Review).where(Review.answer_id == answer.id, Review.state.in_(UNDECIDED))
    )
    if existing is not None:
        return existing
    review = Review(answer_id=answer.id, reason=reason, state=ReviewState.OPEN)
    db.add(review)
    db.flush()
    if reason != ReviewReason.ADMIN:
        enqueue(db, POST_JOB, {"review_id": str(review.id)})
    return review


# --- claiming ------------------------------------------------------------------------------


def claim(db: Session, review_id: uuid.UUID, user: User) -> Review:
    """Claim an open review, atomically. Claiming one you already hold is fine."""
    won = db.execute(
        update(Review)
        .where(Review.id == review_id, Review.state == ReviewState.OPEN)
        .values(state=ReviewState.CLAIMED, claimed_by=user.id, claimed_at=now())
        .returning(Review.id)
    ).first()
    review = db.get(Review, review_id, populate_existing=True, with_for_update=True)
    if review is None:
        raise ReviewError(404, "not_found", "That review doesn't exist.")
    if won is not None:
        return review
    if not review.undecided:
        raise ReviewError(409, "decided", f"#R-{review.number} has already been decided.")
    if review.claimed_by != user.id:
        name = _name(db, review.claimed_by)
        raise ReviewError(409, "taken", f"{name} is handling this.")
    return review


def release(db: Session, review_id: uuid.UUID, user: User) -> Review:
    review = claim(db, review_id, user)
    if review.state == ReviewState.CLAIMED:
        review.state = ReviewState.OPEN
        review.claimed_by = None
        review.claimed_at = None
        review.prompt_message_id = None
        review.prompt_action = None
    return review


# --- deciding ------------------------------------------------------------------------------


@dataclass(frozen=True)
class Decision:
    action: str
    text: str | None = None
    note: str | None = None
    # False when the reviewer wrote it in the Telegram group already, so it isn't repeated.
    post_to_group: bool = True


def _set_answer_text(db: Session, answer: Answer, text: str) -> None:
    answer.current_text = text
    # The chat shows the answer's current text; keep the message's copy the same.
    db.execute(update(Message).where(Message.answer_id == answer.id).values(body=text))


def decide(db: Session, review_id: uuid.UUID, user: User, decision: Decision) -> Review:
    action = decision.action
    if action not in ACTIONS:
        raise ReviewError(422, "invalid", "Unknown action.")
    text = (decision.text or "").strip()
    if action in NEEDS_TEXT and not text:
        message = {
            "edit": "Write the corrected answer.",
            "reject": "Write the correct answer, or choose No answer known.",
            "needs_info": "Write your question for the person who asked.",
        }[action]
        raise ReviewError(422, "invalid", message)
    if len(text) > MAX_TEXT:
        raise ReviewError(422, "invalid", "That text is too long.")

    review = claim(db, review_id, user)
    answer = review.answer
    if action == "approve" and answer.outcome == AnswerOutcome.NO_ANSWER:
        raise ReviewError(
            422, "invalid", "There's no answer to approve. Write one, or choose No answer known."
        )
    note = (decision.note or "").strip() or None
    review.prompt_message_id = None
    review.prompt_action = None

    if action == "needs_info":
        review.state = ReviewState.NEEDS_INFO
        answer.status = AnswerStatus.NEEDS_INFO
        question = ReviewMessage(
            review_id=review.id,
            author_id=user.id,
            kind=ReviewMessageKind.QUESTION_TO_ASKER,
            body=text,
        )
        db.add(question)
        db.flush()
        if decision.post_to_group:
            enqueue(db, NOTE_JOB, {"review_id": str(review.id), "message_id": str(question.id)})
        audit.record(db, user, "review_needs_info", "review", review.id, f"#R-{review.number}")
        return review

    if action == "approve":
        review.state = ReviewState.APPROVED
        answer.status = AnswerStatus.VERIFIED
    elif action in ("edit", "reject"):
        review.state = ReviewState.EDITED if action == "edit" else ReviewState.REJECTED
        review.final_text = text
        _set_answer_text(db, answer, text)
        answer.status = AnswerStatus.CORRECTED
    else:  # no_answer
        review.state = ReviewState.REJECTED
        answer.status = AnswerStatus.WRONG_NO_ANSWER
    review.note = note
    review.decided_by = user.id
    review.decided_at = now()
    audit.record(
        db,
        user,
        f"review_{action}",
        "review",
        review.id,
        f"#R-{review.number}",
        [{"field": "status", "from": None, "to": answer.status.value}],
    )
    enqueue(db, UPDATE_JOB, {"review_id": str(review.id)})
    return review


def decided_line(db: Session, review: Review) -> str:
    who = _name(db, review.decided_by)
    at = f"{review.decided_at:%H:%M} UTC" if review.decided_at else ""
    if review.state == ReviewState.APPROVED:
        what = "✅ Approved"
    elif review.state == ReviewState.EDITED:
        what = "✏️ Corrected"
    elif review.answer.status == AnswerStatus.WRONG_NO_ANSWER:
        what = "🚫 No answer known"
    elif review.state == ReviewState.REJECTED:
        what = "❌ Rejected and corrected"
    else:
        what = "Closed"
    return f"{what} by {who} · {at}".rstrip(" ·")


# --- the asker's side ----------------------------------------------------------------------


def open_question(db: Session, answer: Answer) -> tuple[Review, ReviewMessage] | None:
    """The reviewer's question waiting for the asker, if any."""
    review = db.scalar(
        select(Review).where(Review.answer_id == answer.id, Review.state == ReviewState.NEEDS_INFO)
    )
    if review is None:
        return None
    question = db.scalar(
        select(ReviewMessage)
        .where(
            ReviewMessage.review_id == review.id,
            ReviewMessage.kind == ReviewMessageKind.QUESTION_TO_ASKER,
        )
        .order_by(ReviewMessage.created_at.desc())
        .limit(1)
    )
    return (review, question) if question else None


def asker_reply(db: Session, answer: Answer, user: User, text: str) -> Review:
    waiting = open_question(db, answer)
    if waiting is None:
        raise ReviewError(409, "not_waiting", "Our team isn't waiting for an answer from you.")
    review, _ = waiting
    message = ReviewMessage(
        review_id=review.id, author_id=user.id, kind=ReviewMessageKind.ASKER_REPLY, body=text
    )
    db.add(message)
    review.state = ReviewState.CLAIMED if review.claimed_by else ReviewState.OPEN
    answer.status = AnswerStatus.IN_REVIEW
    db.flush()
    enqueue(db, NOTE_JOB, {"review_id": str(review.id), "message_id": str(message.id)})
    return review


# --- reminders and escalation ---------------------------------------------------------------


@dataclass
class Overdue:
    remind: list[Review]
    escalate: list[Review]


def overdue(db: Session, at: datetime) -> Overdue:
    """Reviews waiting on reviewers past the reminder or escalation time (not those waiting
    on the asker). Each is reminded once and escalated once."""
    remind_after = timedelta(hours=settings_store.get_float(db, "review_reminder_hours"))
    escalate_after = timedelta(hours=settings_store.get_float(db, "review_escalation_hours"))
    waiting = (ReviewState.OPEN, ReviewState.CLAIMED)
    remind = db.scalars(
        select(Review).where(
            Review.state.in_(waiting),
            Review.reminded_at.is_(None),
            Review.created_at <= at - remind_after,
        )
    ).all()
    escalate = db.scalars(
        select(Review).where(
            Review.state.in_(waiting),
            Review.escalated_at.is_(None),
            Review.created_at <= at - escalate_after,
        )
    ).all()
    return Overdue(list(remind), list(escalate))


def owners(db: Session) -> list[User]:
    return list(
        db.scalars(
            select(User).where(
                User.role == Role.OWNER, User.active.is_(True), User.password_hash.is_not(None)
            )
        )
    )
