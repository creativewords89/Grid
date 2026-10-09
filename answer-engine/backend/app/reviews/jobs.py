"""Worker jobs that keep the Telegram group in step with reviews (SPEC section 6.7).

They run in the worker, so a slow or failing Telegram never slows down answering, and a
failed send is retried like any job. Without a bot token or group, they do nothing.
"""

import logging
import uuid

from sqlalchemy.orm import Session

from app import settings_store
from app.auth.tokens import now
from app.config import get_settings
from app.db.models import Review, ReviewMessage, ReviewMessageKind, User
from app.jobs.queue import Payload, job
from app.mail import get_mailer
from app.reviews import service
from app.reviews.telegram import (
    ReviewCard,
    Telegram,
    decided_text,
    esc,
    get_telegram,
    review_buttons,
    review_text,
    shorten,
)

log = logging.getLogger(__name__)

REMINDERS = "review_reminders"


def group_chat(db: Session) -> int | None:
    value = settings_store.get(db, "telegram_group_chat_id")
    try:
        return int(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _bot(db: Session) -> tuple[Telegram, int] | None:
    telegram = get_telegram()
    chat = group_chat(db)
    return (telegram, chat) if telegram is not None and chat is not None else None


def card(db: Session, review: Review) -> ReviewCard:
    answer = review.answer
    asker = db.get(User, answer.asked_by) if answer.asked_by else None
    return ReviewCard(
        number=review.number,
        reason_label=service.reason_label(review),
        asker=asker.name if asker else "Someone",
        channel=service.channel_label(answer),
        question=answer.question,
        answer=answer.original_text,
        sources=[f"[{s['n']}] {s.get('label') or s.get('file_name', '')}" for s in answer.sources],
        open_url=get_settings().link(f"/reviews?id={review.id}"),
        no_answer=answer.outcome is not None and answer.outcome.value == "no_answer",
    )


@job(service.POST_JOB)
def post_review(db: Session, payload: Payload) -> None:
    bot = _bot(db)
    review = db.get(Review, uuid.UUID(payload["review_id"]))
    if bot is None or review is None or review.telegram_message_id is not None:
        return
    telegram, chat = bot
    info = card(db, review)
    buttons = review_buttons(str(review.id), info.open_url, info.no_answer)
    text = review_text(info)
    if not review.undecided:
        # Decided on the web before the worker got to it: post it as done, without buttons.
        review.telegram_message_id = telegram.send_message(
            chat, decided_text(text, service.decided_line(db, review))
        )
    else:
        review.telegram_message_id = telegram.send_message(chat, text, buttons)
    db.commit()


@job(service.UPDATE_JOB)
def update_review(db: Session, payload: Payload) -> None:
    """After a decision: show the result on the group message and remove its buttons."""
    bot = _bot(db)
    review = db.get(Review, uuid.UUID(payload["review_id"]))
    if bot is None or review is None or review.telegram_message_id is None:
        return
    telegram, chat = bot
    text = decided_text(review_text(card(db, review)), service.decided_line(db, review))
    telegram.edit_message(chat, review.telegram_message_id, text, None)


@job(service.NOTE_JOB)
def post_note(db: Session, payload: Payload) -> None:
    """A reviewer's question to the asker, or the asker's reply, under the review message."""
    bot = _bot(db)
    review = db.get(Review, uuid.UUID(payload["review_id"]))
    note = db.get(ReviewMessage, uuid.UUID(payload["message_id"]))
    if bot is None or review is None or note is None:
        return
    telegram, chat = bot
    author = db.get(User, note.author_id) if note.author_id else None
    name = esc(author.name if author else "Someone")
    body = esc(shorten(note.body, 3500))
    if note.kind == ReviewMessageKind.ASKER_REPLY:
        claimer = db.get(User, review.claimed_by) if review.claimed_by else None
        to = f" ({esc(claimer.name)}, it's back with you)" if claimer else ""
        text = f"💬 {name} replied to #R-{review.number}{to}:\n{body}"
    else:
        text = f"❓ {name} asked about #R-{review.number}:\n{body}"
    telegram.send_message(chat, text, reply_to=review.telegram_message_id)


@job(REMINDERS)
def remind(db: Session, payload: Payload) -> None:
    """Every 5 minutes: remind the group about waiting reviews, then escalate to Owners."""
    at = now()
    due = service.overdue(db, at)
    bot = _bot(db)
    for review in due.remind:
        if bot is not None and review.telegram_message_id is not None:
            telegram, chat = bot
            hours = settings_store.get_float(db, "review_reminder_hours")
            text = f"⏰ #R-{review.number} has been waiting over {hours:g} h."
            telegram.send_message(chat, text, reply_to=review.telegram_message_id)
        review.reminded_at = at
        db.commit()
    if not due.escalate:
        return
    mailer = get_mailer()
    settings = get_settings()
    hours = settings_store.get_float(db, "review_escalation_hours")
    for review in due.escalate:
        review.escalated_at = at
        status = "answered by nobody yet" if review.state.value == "open" else "still undecided"
        for owner in service.owners(db):
            mailer.send(
                owner.email,
                f"Review #R-{review.number} has waited over {hours:g} hours",
                f"Hello {owner.name},\n\n"
                f"Review #R-{review.number} ({service.reason_label(review)}) is {status}.\n"
                f"Question: {review.answer.question}\n\n"
                f"Open it: {settings.link(f'/reviews?id={review.id}')}\n",
            )
        db.commit()
