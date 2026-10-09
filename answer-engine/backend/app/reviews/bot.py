"""What the bot does with each Telegram update (SPEC section 6.7).

- In a private chat: `/link CODE` (or `/start CODE`) links the sender's Telegram to the
  account that made the code on its Profile page.
- In the review group: a button press claims the review and acts on it; Edit, Reject and
  Needs info ask for a reply to the bot's message, and that reply is the text.
- Presses and replies from Telegram accounts that aren't linked to an active Owner or
  Reviewer are ignored, with a short explanation.
Every action is checked with `permissions.can()` as the linked person, like the web.
"""

import logging
import re
import uuid
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app import settings_store
from app.auth import tokens
from app.db.models import AuthToken, Review, TokenKind, User
from app.permissions import Action, can
from app.reviews import service
from app.reviews.jobs import group_chat
from app.reviews.service import Decision, ReviewError
from app.reviews.telegram import Telegram, TelegramError, esc

log = logging.getLogger(__name__)

NOT_LINKED = "Your Telegram isn't linked to a reviewer account."
LINK_HELP = (
    "Hello! To review answers, link your account: open your Profile in the Answer Engine, "
    "click Link Telegram, and send me the code like this: /link ABCD2345"
)
PROMPTS = {
    "edit": "✏️ {name}: reply to this message with the corrected answer for #R-{n}.",
    "reject": (
        "❌ {name}: reply to this message with the correct answer for #R-{n}, "
        "or tap No answer known."
    ),
    "needs_info": "❓ {name}: reply to this message with your question for {asker} (#R-{n}).",
}
DONE_TOASTS = {"approve": "✅ Approved", "no_answer": "🚫 Marked: no answer known"}
MAX_SEEN_CHATS = 20
_CODE = re.compile(r"^/(?:link|start)(?:@\w+)?\s+([A-Za-z0-9-]{4,20})\s*$")


def linked_user(db: Session, telegram_id: int | None) -> User | None:
    if telegram_id is None:
        return None
    user = db.scalar(select(User).where(User.telegram_user_id == telegram_id))
    return user if user is not None and can(user, Action.DECIDE_REVIEW) else None


def handle(db: Session, telegram: Telegram, update: dict[str, Any]) -> None:
    try:
        if "callback_query" in update:
            _button(db, telegram, update["callback_query"])
        elif "message" in update:
            _message(db, telegram, update["message"])
        elif "my_chat_member" in update:
            _remember_chat(db, update["my_chat_member"].get("chat", {}))
    except TelegramError:
        log.warning("a Telegram reply failed", exc_info=True)
        db.rollback()


# --- buttons -------------------------------------------------------------------------------


def _button(db: Session, telegram: Telegram, query: dict[str, Any]) -> None:
    callback_id = str(query.get("id", ""))
    data = str(query.get("data", ""))
    parts = data.split(":")
    if len(parts) != 3 or parts[0] != "rv":
        telegram.answer_callback(callback_id, "")
        return
    user = linked_user(db, query.get("from", {}).get("id"))
    if user is None:
        telegram.answer_callback(callback_id, NOT_LINKED)
        return
    chat = query.get("message", {}).get("chat", {}).get("id")
    if chat is not None and chat != group_chat(db):
        telegram.answer_callback(callback_id, "This isn't the review group.")
        return
    try:
        review_id = uuid.UUID(parts[1])
    except ValueError:
        telegram.answer_callback(callback_id, "")
        return
    action = "no_answer" if parts[2] == "noanswer" else parts[2]
    try:
        if action in DONE_TOASTS:
            service.decide(db, review_id, user, Decision(action))
            db.commit()
            telegram.answer_callback(callback_id, DONE_TOASTS[action])
        elif action in PROMPTS:
            _prompt(db, telegram, review_id, user, action)
            telegram.answer_callback(callback_id, "Reply to my message in the group.")
        else:
            telegram.answer_callback(callback_id, "")
    except ReviewError as error:
        db.rollback()
        telegram.answer_callback(callback_id, error.message)


def _prompt(db: Session, telegram: Telegram, review_id: uuid.UUID, user: User, action: str) -> None:
    review = service.claim(db, review_id, user)
    chat = group_chat(db)
    if chat is None:
        raise ReviewError(409, "no_group", "The review group isn't set up.")
    asker = db.get(User, review.answer.asked_by) if review.answer.asked_by else None
    text = PROMPTS[action].format(
        name=esc(user.name), n=review.number, asker=esc(asker.name if asker else "the asker")
    )
    markup: dict[str, Any] = {"force_reply": True, "input_field_placeholder": "Your reply"}
    if action == "reject":
        markup = {
            "inline_keyboard": [
                [{"text": "🚫 No answer known", "callback_data": f"rv:{review.id}:noanswer"}]
            ]
        }
    review.prompt_message_id = telegram.send_message(
        chat, text, markup, reply_to=review.telegram_message_id
    )
    review.prompt_action = action
    db.commit()


# --- messages ------------------------------------------------------------------------------


def _message(db: Session, telegram: Telegram, message: dict[str, Any]) -> None:
    chat = message.get("chat", {})
    text = str(message.get("text") or "").strip()
    sender = message.get("from", {}).get("id")
    if chat.get("type") == "private":
        _private(db, telegram, chat["id"], sender, text)
        return
    _remember_chat(db, chat)
    replied_to = (message.get("reply_to_message") or {}).get("message_id")
    if replied_to is None or chat.get("id") != group_chat(db) or not text:
        return
    review = db.scalar(select(Review).where(Review.prompt_message_id == replied_to))
    if review is None or review.prompt_action is None:
        return
    user = linked_user(db, sender)
    if user is None:
        return  # strangers in the group can't act; they get no reply in the group either
    action = review.prompt_action
    try:
        service.decide(db, review.id, user, Decision(action, text, post_to_group=False))
        db.commit()
    except ReviewError as error:
        db.rollback()
        telegram.send_message(chat["id"], esc(error.message), reply_to=message.get("message_id"))
        return
    if action == "needs_info":
        telegram.send_message(
            chat["id"], "Sent. I'll post their reply here.", reply_to=message.get("message_id")
        )


def _private(db: Session, telegram: Telegram, chat_id: int, sender: int | None, text: str) -> None:
    match = _CODE.match(text)
    if match is None or sender is None:
        telegram.send_message(chat_id, esc(LINK_HELP))
        return
    code = match.group(1).upper()
    token: AuthToken | None = tokens.find_valid(db, code, TokenKind.TELEGRAM_LINK)
    if token is None:
        telegram.send_message(
            chat_id, "That code is wrong or has expired. Get a new one on your Profile page."
        )
        return
    user = token.user
    # One Telegram account belongs to one person: unlink it from anyone else first.
    db.execute(
        update(User)
        .where(User.telegram_user_id == sender, User.id != user.id)
        .values(telegram_user_id=None)
    )
    user.telegram_user_id = sender
    token.used_at = tokens.now()
    db.commit()
    role = "review answers in the group" if can(user, Action.DECIDE_REVIEW) else "get messages"
    telegram.send_message(chat_id, f"✅ Linked to {esc(user.name)}. You can now {role} here.")


def _remember_chat(db: Session, chat: dict[str, Any]) -> None:
    """Groups the bot has seen, for Settings → Reviews → Detect group."""
    if chat.get("type") not in ("group", "supergroup") or "id" not in chat:
        return
    seen = [c for c in settings_store.get(db, "telegram_seen_chats") or [] if c["id"] != chat["id"]]
    seen.insert(0, {"id": chat["id"], "title": str(chat.get("title") or chat["id"])[:120]})
    settings_store.put(db, "telegram_seen_chats", seen[:MAX_SEEN_CHATS])
    db.commit()
