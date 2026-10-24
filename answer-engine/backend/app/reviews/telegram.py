"""The Telegram Bot API, and the review message the group sees (SPEC section 6.7).

Only the calls the review bot needs. Text is sent as Telegram HTML, so everything that comes
from people or documents is escaped, and messages are kept under Telegram's 4096 characters.
"""

import html
import logging
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Protocol

import httpx2

from app.config import get_settings

log = logging.getLogger(__name__)

LIMIT = 4096
ANSWER_ROOM = 3000  # most of a message is the answer; the rest is the header and sources


class TelegramError(Exception):
    pass


class Telegram(Protocol):
    def send_message(
        self,
        chat_id: int,
        text: str,
        reply_markup: dict[str, Any] | None = None,
        reply_to: int | None = None,
    ) -> int:
        """Send HTML text; returns the new message's id."""
        ...

    def edit_message(
        self, chat_id: int, message_id: int, text: str, reply_markup: dict[str, Any] | None
    ) -> None: ...

    def answer_callback(self, callback_id: str, text: str) -> None: ...

    def set_webhook(self, url: str, secret: str) -> None: ...

    def bot_username(self) -> str: ...


class HttpTelegram:
    def __init__(self, token: str, api_url: str) -> None:
        self.base = f"{api_url.rstrip('/')}/bot{token}"
        self.client = httpx2.Client(timeout=15.0)

    def _call(self, method: str, **params: Any) -> Any:
        body = {key: value for key, value in params.items() if value is not None}
        try:
            response = self.client.post(f"{self.base}/{method}", json=body)
            data = response.json()
        except (httpx2.HTTPError, ValueError) as error:
            # The URL holds the token, so it is never logged.
            raise TelegramError(f"Telegram {method} failed: {type(error).__name__}") from None
        if not data.get("ok"):
            raise TelegramError(f"Telegram {method}: {data.get('description', 'error')}")
        return data["result"]

    def send_message(
        self,
        chat_id: int,
        text: str,
        reply_markup: dict[str, Any] | None = None,
        reply_to: int | None = None,
    ) -> int:
        result = self._call(
            "sendMessage",
            chat_id=chat_id,
            text=text,
            parse_mode="HTML",
            link_preview_options={"is_disabled": True},
            reply_markup=reply_markup,
            reply_parameters={"message_id": reply_to, "allow_sending_without_reply": True}
            if reply_to
            else None,
        )
        return int(result["message_id"])

    def edit_message(
        self, chat_id: int, message_id: int, text: str, reply_markup: dict[str, Any] | None
    ) -> None:
        self._call(
            "editMessageText",
            chat_id=chat_id,
            message_id=message_id,
            text=text,
            parse_mode="HTML",
            link_preview_options={"is_disabled": True},
            reply_markup=reply_markup or {"inline_keyboard": []},
        )

    def answer_callback(self, callback_id: str, text: str) -> None:
        self._call("answerCallbackQuery", callback_query_id=callback_id, text=text)

    def set_webhook(self, url: str, secret: str) -> None:
        self._call(
            "setWebhook",
            url=url,
            secret_token=secret,
            allowed_updates=["message", "callback_query", "my_chat_member"],
        )

    def bot_username(self) -> str:
        return str(self._call("getMe")["username"])


@lru_cache
def _client(token: str, api_url: str) -> HttpTelegram:
    return HttpTelegram(token, api_url)


def get_telegram() -> Telegram | None:
    """The bot, or None while TELEGRAM_BOT_TOKEN isn't set (reviews then use the web only)."""
    settings = get_settings()
    if not settings.telegram_bot_token:
        return None
    return _client(settings.telegram_bot_token, settings.telegram_api_url)


# --- the review message --------------------------------------------------------------------


def esc(text: str) -> str:
    return html.escape(text, quote=False)


def shorten(text: str, room: int) -> str:
    if len(text) <= room:
        return text
    return text[: room - 1].rstrip() + "…"


@dataclass(frozen=True)
class ReviewCard:
    number: int
    reason_label: str
    asker: str
    channel: str  # "Chat", or "Marketing · Reddit · r/localseo"
    question: str
    answer: str
    sources: list[str]  # "[1] Onboarding.pdf · p.3"
    open_url: str | None
    no_answer: bool = False


def review_text(card: ReviewCard) -> str:
    head = (
        f"🔎 <b>Review needed</b> · #R-{card.number} · {esc(card.reason_label)}\n"
        f"From: {esc(card.asker)} · {esc(card.channel)}\n"
        f"<b>Q:</b> {esc(shorten(card.question, 600))}\n"
    )
    sources = f"Sources: {esc(shorten('  '.join(card.sources), 400))}" if card.sources else ""
    room = LIMIT - len(head) - len(sources) - 80
    answer = card.answer
    shortened = len(answer) > min(room, ANSWER_ROOM)
    answer = shorten(answer, min(room, ANSWER_ROOM))
    body = f"<b>A:</b> {esc(answer)}"
    if shortened:
        body += "\n<i>(shortened: open the review for the full answer)</i>"
    text = head + body + (f"\n{sources}" if sources else "")
    return text[:LIMIT]


def review_buttons(review_id: str, open_url: str | None, no_answer: bool) -> dict[str, Any]:
    def button(label: str, action: str) -> dict[str, str]:
        return {"text": label, "callback_data": f"rv:{review_id}:{action}"}

    if no_answer:
        first = [button("✏️ Answer", "edit"), button("🚫 No answer known", "noanswer")]
    else:
        first = [
            button("✅ Approve", "approve"),
            button("✏️ Edit", "edit"),
            button("❌ Reject", "reject"),
        ]
    second = [button("❓ Needs info", "needs_info")]
    if open_url and open_url.startswith("https://"):
        second.append({"text": "🔗 Open", "url": open_url})
    return {"inline_keyboard": [first, second]}


def decided_text(original: str, line: str) -> str:
    """The group message after a decision: the card plus "✅ Approved by Ali · 14:05 UTC"."""
    extra = f"\n\n{line}"
    return original[: LIMIT - len(extra)] + extra
