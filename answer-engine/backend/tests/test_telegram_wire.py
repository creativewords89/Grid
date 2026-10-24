"""The real Telegram client against a mock transport: request shapes and error handling."""

import json
from collections.abc import Callable
from typing import Any

import httpx2
import pytest

from app.reviews.telegram import (
    HttpTelegram,
    ReviewCard,
    TelegramError,
    decided_text,
    review_buttons,
    review_text,
)


def bot(
    handler: Callable[[httpx2.Request], httpx2.Response],
) -> tuple[HttpTelegram, list[tuple[str, dict[str, Any]]]]:
    seen: list[tuple[str, dict[str, Any]]] = []

    def record(request: httpx2.Request) -> httpx2.Response:
        seen.append((request.url.path, json.loads(request.content)))
        return handler(request)

    telegram = HttpTelegram("123:SECRET-TOKEN", "https://api.telegram.org")
    telegram.client = httpx2.Client(transport=httpx2.MockTransport(record))
    return telegram, seen


def ok(result: Any) -> Callable[[httpx2.Request], httpx2.Response]:
    return lambda request: httpx2.Response(200, json={"ok": True, "result": result})


def test_send_message() -> None:
    telegram, seen = bot(ok({"message_id": 77}))

    message_id = telegram.send_message(-100, "<b>Hi</b>", {"inline_keyboard": []}, reply_to=5)

    assert message_id == 77
    [(path, body)] = seen
    assert path == "/bot123:SECRET-TOKEN/sendMessage"
    assert body == {
        "chat_id": -100,
        "text": "<b>Hi</b>",
        "parse_mode": "HTML",
        "link_preview_options": {"is_disabled": True},
        "reply_markup": {"inline_keyboard": []},
        "reply_parameters": {"message_id": 5, "allow_sending_without_reply": True},
    }


def test_edit_removes_buttons_and_webhook_has_the_secret() -> None:
    telegram, seen = bot(ok(True))
    telegram.edit_message(-100, 77, "done", None)
    telegram.set_webhook("https://a.example/api/telegram/webhook", "s3cret-value-123456")

    assert seen[0][1]["reply_markup"] == {"inline_keyboard": []}
    assert seen[1][1] == {
        "url": "https://a.example/api/telegram/webhook",
        "secret_token": "s3cret-value-123456",
        "allowed_updates": ["message", "callback_query", "my_chat_member"],
    }


def test_errors_never_include_the_token() -> None:
    refused, _ = bot(
        lambda r: httpx2.Response(400, json={"ok": False, "description": "chat not found"})
    )
    with pytest.raises(TelegramError, match="chat not found") as refused_error:
        refused.send_message(-1, "x")

    def down(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("boom", request=request)

    broken, _ = bot(down)
    with pytest.raises(TelegramError) as broken_error:
        broken.send_message(-1, "x")
    for error in (refused_error.value, broken_error.value):
        assert "SECRET-TOKEN" not in str(error)


def test_card_and_buttons() -> None:
    card = ReviewCard(
        number=142,
        reason_label="Low confidence (62)",
        asker="Sara",
        channel="Chat",
        question="How long does GBP verification take?",
        answer="It usually takes 3–5 days [1].",
        sources=["[1] Onboarding.pdf · p.3"],
        open_url="https://answers.example.com/reviews?id=r1",
    )
    assert review_text(card) == (
        "🔎 <b>Review needed</b> · #R-142 · Low confidence (62)\n"
        "From: Sara · Chat\n"
        "<b>Q:</b> How long does GBP verification take?\n"
        "<b>A:</b> It usually takes 3–5 days [1].\n"
        "Sources: [1] Onboarding.pdf · p.3"
    )
    buttons = review_buttons("r1", card.open_url, no_answer=False)
    assert buttons["inline_keyboard"][1][-1] == {
        "text": "🔗 Open",
        "url": "https://answers.example.com/reviews?id=r1",
    }
    assert decided_text("card", "✅ Approved by Ali · 14:05 UTC") == (
        "card\n\n✅ Approved by Ali · 14:05 UTC"
    )
