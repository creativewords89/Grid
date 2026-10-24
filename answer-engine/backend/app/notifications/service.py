"""Who gets told what, and how (SPEC section 6.11).

A notification is always added to the person's bell, in the same transaction as the event.
If they chose email or Telegram, a worker job also sends it there, so a slow mail server or
Telegram never slows the action down, and a failed send is retried.
"""

import hashlib
import hmac
import html
import logging
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import connections
from app.auth.tokens import now
from app.config import get_settings
from app.db.models import Notification, NotifyChannel, Role, User
from app.jobs.queue import Payload, enqueue, job
from app.mail import get_mailer
from app.reviews.telegram import TelegramError, esc, get_telegram

log = logging.getLogger(__name__)

SEND_JOB = "notification_send"

# Kinds (SPEC 6.11).
ANSWER_REVIEWED = "answer_reviewed"
NEEDS_INFO = "needs_info"
DRAFT_READY = "thread_draft_ready"
REPLY_CORRECTED = "reply_corrected_after_post"
REVIEW_ESCALATED = "review_escalated"
SYNC_FAILING = "sync_failing"
FILE_FAILED = "file_failed"


def notify(
    db: Session,
    user: User,
    kind: str,
    title: str,
    body: str = "",
    link: str | None = None,
    ref: tuple[str, object] | None = None,
) -> Notification | None:
    """Add a notification (the caller commits). Inactive people get nothing."""
    if not user.active:
        return None
    note = Notification(
        user_id=user.id,
        kind=kind,
        ref_kind=ref[0] if ref else None,
        ref_id=str(ref[1]) if ref else None,
        title=title[:200],
        body=body,
        link=link,
    )
    db.add(note)
    db.flush()
    if user.notify_channel != NotifyChannel.IN_APP:
        enqueue(db, SEND_JOB, {"notification_id": str(note.id)})
    return note


def owners(db: Session) -> list[User]:
    return list(
        db.scalars(
            select(User).where(
                User.role == Role.OWNER, User.active.is_(True), User.password_hash.is_not(None)
            )
        )
    )


def notify_owners(
    db: Session,
    kind: str,
    title: str,
    body: str = "",
    link: str | None = None,
    ref: tuple[str, object] | None = None,
    once: bool = False,
) -> int:
    """Tell every Owner. With `once`, an Owner already told about this ref isn't told again."""
    told = 0
    for owner in owners(db):
        if (
            once
            and ref is not None
            and db.scalar(
                select(Notification.id).where(
                    Notification.user_id == owner.id,
                    Notification.kind == kind,
                    Notification.ref_id == str(ref[1]),
                )
            )
        ):
            continue
        if notify(db, owner, kind, title, body, link, ref) is not None:
            told += 1
    return told


# --- the "Stop these emails" link -----------------------------------------------------------


def stop_token(user_id: uuid.UUID) -> str:
    key = get_settings().signing_key
    return hmac.new(key, f"stop-emails:{user_id}".encode(), hashlib.sha256).hexdigest()[:32]


def stop_link(user_id: uuid.UUID) -> str:
    return get_settings().link(
        f"/api/notifications/stop-emails?u={user_id}&t={stop_token(user_id)}"
    )


def check_stop_token(user_id: uuid.UUID, token: str) -> bool:
    return hmac.compare_digest(stop_token(user_id), token)


# --- sending ---------------------------------------------------------------------------------


def email_parts(note: Notification, user: User) -> tuple[str, str, str]:
    settings = get_settings()
    link = settings.link(note.link) if note.link else settings.link("/")
    stop = stop_link(user.id)
    text = (
        f"Hello {user.name},\n\n{note.title}\n\n"
        + (f"{note.body}\n\n" if note.body else "")
        + f"Open it: {link}\n\n"
        f"Stop these emails (you'll still see them in the app): {stop}\n"
    )
    body_html = (
        f"<p>Hello {html.escape(user.name)},</p>"
        f"<p><strong>{html.escape(note.title)}</strong></p>"
        + (f"<p>{html.escape(note.body).replace(chr(10), '<br>')}</p>" if note.body else "")
        + f'<p><a href="{html.escape(link)}">Open it in the Answer Engine</a></p>'
        f'<p style="color:#5d6878;font-size:12px"><a href="{html.escape(stop)}">'
        "Stop these emails</a> (you'll still see them in the app)</p>"
    )
    return text, body_html, stop


@job(SEND_JOB)
def send(db: Session, payload: Payload) -> None:
    note = db.get(Notification, uuid.UUID(payload["notification_id"]))
    if note is None or note.sent_at is not None:
        return
    user = db.get(User, note.user_id)
    if user is None or not user.active:
        return
    channel = user.notify_channel
    telegram = get_telegram()
    if channel == NotifyChannel.TELEGRAM and (telegram is None or user.telegram_user_id is None):
        channel = NotifyChannel.EMAIL  # Telegram was unlinked or switched off: use email
    if channel == NotifyChannel.TELEGRAM and telegram is not None and user.telegram_user_id:
        link = get_settings().link(note.link or "/")
        text = f"🔔 <b>{esc(note.title)}</b>" + (f"\n{esc(note.body)}" if note.body else "")
        if link.startswith("https://"):
            text += f'\n<a href="{esc(link)}">Open it</a>'
        try:
            telegram.send_message(user.telegram_user_id, text)
        except TelegramError:
            log.warning("could not send a notification to Telegram", exc_info=True)
            raise
    elif channel == NotifyChannel.EMAIL:
        text, body_html, stop = email_parts(note, user)
        if not get_mailer().send(user.email, note.title, text, body_html, stop):
            if connections.current().email_configured:
                raise RuntimeError("the email could not be sent")
            return  # email isn't set up: the bell is enough
    else:
        return
    note.channel = channel.value
    note.sent_at = now()
    db.commit()
