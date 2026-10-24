"""`POST /api/telegram/webhook`: updates from the review bot (SPEC section 6.7).

Telegram signs every delivery with the secret given at setWebhook; anything else gets a 403.
The reply is always 200 once the secret matches, so Telegram doesn't resend an update that
we chose to ignore.
"""

import hmac
from typing import Annotated, Any

from fastapi import APIRouter, Body, Header

from app.auth.deps import Db
from app.config import get_settings
from app.errors import ApiError
from app.reviews import bot
from app.reviews.telegram import get_telegram

router = APIRouter(prefix="/telegram", tags=["telegram"])


@router.post("/webhook")
def webhook(
    db: Db,
    update: Annotated[dict[str, Any], Body(default_factory=dict)],
    x_telegram_bot_api_secret_token: Annotated[str, Header()] = "",
) -> dict[str, bool]:
    secret = get_settings().telegram_webhook_secret
    sent = x_telegram_bot_api_secret_token.encode()
    if not secret or not hmac.compare_digest(sent, secret.encode()):
        raise ApiError(403, "forbidden", "Not allowed.")
    telegram = get_telegram()
    if telegram is not None:
        bot.handle(db, telegram, update)
    return {"ok": True}
