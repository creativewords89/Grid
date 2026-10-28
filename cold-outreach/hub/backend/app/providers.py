"""The outside services behind the Connections screen's Test buttons (SPEC section 6.1).

Each call raises ProviderError with a reason a person can act on. Reasons never contain the
key, password or token that was used. Tests swap `transport` for an httpx2.MockTransport.
"""

from typing import Any

import httpx2

from app.config import get_settings

transport: httpx2.BaseTransport | None = None


class ProviderError(Exception):
    pass


def _client(timeout: float = 20.0) -> httpx2.Client:
    return httpx2.Client(timeout=timeout, transport=transport)


def _json(response: httpx2.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None


# --- DataForSEO ----------------------------------------------------------------------------


def dataforseo_balance(login: str, password: str) -> float:
    """The account balance in USD."""
    try:
        with _client() as client:
            response = client.get(
                f"{get_settings().dataforseo_url}/appendix/user_data",
                auth=httpx2.BasicAuth(login, password),
            )
    except httpx2.HTTPError as error:
        raise ProviderError(f"DataForSEO can't be reached ({type(error).__name__}).") from None
    data = _json(response) or {}
    if response.status_code == 401 or data.get("status_code") == 40100:
        raise ProviderError("DataForSEO refused the login or password.")
    try:
        task = data["tasks"][0]
        if task.get("status_code") != 20000:
            raise ProviderError(f"DataForSEO said: {task.get('status_message', 'error')}")
        return float(task["result"][0]["money"]["balance"])
    except (KeyError, IndexError, TypeError, ValueError):
        raise ProviderError(f"DataForSEO answered unexpectedly ({response.status_code}).") from None


# --- PageSpeed Insights ---------------------------------------------------------------------


def pagespeed_score(api_key: str) -> int:
    """The mobile performance score of example.com, to prove the key works."""
    try:
        with _client(timeout=90.0) as client:
            response = client.get(
                get_settings().pagespeed_url,
                params={
                    "url": "https://example.com",
                    "strategy": "mobile",
                    "category": "performance",
                    "key": api_key,
                },
            )
    except httpx2.HTTPError as error:
        raise ProviderError(f"PageSpeed can't be reached ({type(error).__name__}).") from None
    data = _json(response) or {}
    if response.status_code != 200:
        message = (data.get("error") or {}).get("message") or f"error {response.status_code}"
        raise ProviderError(f"PageSpeed refused the key: {str(message)[:200]}")
    try:
        return round(float(data["lighthouseResult"]["categories"]["performance"]["score"]) * 100)
    except (KeyError, TypeError, ValueError):
        raise ProviderError("PageSpeed answered without a score.") from None


# --- Telegram ------------------------------------------------------------------------------


def _telegram(token: str, method: str, **params: Any) -> Any:
    try:
        with _client() as client:
            response = client.post(
                f"{get_settings().telegram_url}/bot{token}/{method}", json=params
            )
        data = response.json()
    except (httpx2.HTTPError, ValueError) as error:
        # The URL holds the token, so neither it nor the error text is repeated.
        raise ProviderError(f"Telegram can't be reached ({type(error).__name__}).") from None
    if not data.get("ok"):
        description = str(data.get("description", "error"))
        if response.status_code in (401, 404):
            raise ProviderError("Telegram refused the bot token. Copy it again from @BotFather.")
        raise ProviderError(f"Telegram said: {description[:200]}")
    return data["result"]


def telegram_bot_name(token: str) -> str:
    return str(_telegram(token, "getMe")["username"])


def telegram_find_group(token: str) -> tuple[str, str] | None:
    """The most recent group the bot has seen a message in: (chat id, title)."""
    found: tuple[str, str] | None = None
    for update in _telegram(token, "getUpdates", allowed_updates=["message", "my_chat_member"]):
        for key in ("message", "my_chat_member"):
            chat = (update.get(key) or {}).get("chat") or {}
            if chat.get("type") in ("group", "supergroup"):
                found = (str(chat["id"]), str(chat.get("title") or "your group"))
    return found


def telegram_send(token: str, chat_id: str, text: str) -> None:
    _telegram(token, "sendMessage", chat_id=chat_id, text=text)
