"""The outside services behind the Connections screen's Test buttons (SPEC section 6.1).

Each call raises ProviderError with a reason a person can act on. Reasons never contain the
key, password or token that was used. Tests swap `transport` for an httpx2.MockTransport.
"""

import base64
import json
import time
from typing import Any

import httpx2
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from app.config import get_settings

GOOGLE_SCOPES = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive"

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


# --- Google (service account) --------------------------------------------------------------


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def google_token(service_account_json: str) -> str:
    """An access token for Sheets and Drive, from the service account's key file."""
    account = json.loads(service_account_json)
    key = serialization.load_pem_private_key(account["private_key"].encode(), password=None)
    if not isinstance(key, rsa.RSAPrivateKey):
        raise ProviderError("The key file's private key isn't an RSA key.")
    now = int(time.time())
    # Google's token address comes from the Hub's settings, never from the key file's
    # token_uri, so a key file can't send the signed request somewhere else.
    claims = {
        "iss": account["client_email"],
        "scope": GOOGLE_SCOPES,
        "aud": get_settings().google_token_url,
        "iat": now,
        "exp": now + 3600,
    }
    signing_input = (
        _b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
        + "."
        + _b64(json.dumps(claims).encode())
    )
    signature = key.sign(signing_input.encode(), padding.PKCS1v15(), hashes.SHA256())
    assertion = f"{signing_input}.{_b64(signature)}"
    try:
        with _client() as client:
            response = client.post(
                get_settings().google_token_url,
                data={
                    "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                    "assertion": assertion,
                },
            )
    except httpx2.HTTPError as error:
        raise ProviderError(f"Google can't be reached ({type(error).__name__}).") from None
    data = _json(response) or {}
    if response.status_code != 200 or not data.get("access_token"):
        raise ProviderError(
            "Google refused the service account key "
            f"({data.get('error_description') or data.get('error') or response.status_code})."
        )
    return str(data["access_token"])


def google_reason(response: httpx2.Response) -> str:
    error = (_json(response) or {}).get("error") or {}
    reasons = {item.get("reason") for item in error.get("errors", []) if isinstance(item, dict)}
    if "storageQuotaExceeded" in reasons:
        return (
            "Google says the service account has no storage of its own. Use a folder in a "
            "Shared Drive and add the service account to that Shared Drive."
        )
    if response.status_code == 404:
        return "not found. Share it with the service account's email (as Editor)."
    if response.status_code == 403:
        return "no access. Share it with the service account's email (as Editor)."
    return str(error.get("message") or f"error {response.status_code}")


def google_sheet_tabs(token: str, sheet_id: str) -> tuple[str, list[str]]:
    """The spreadsheet's title and its tab names."""
    with _client() as client:
        response = client.get(
            f"{get_settings().google_sheets_url}/{sheet_id}",
            params={"fields": "properties.title,sheets.properties.title"},
            headers={"Authorization": f"Bearer {token}"},
        )
    if response.status_code != 200:
        raise ProviderError(f"Master Sheet: {google_reason(response)}")
    data = response.json()
    tabs = [sheet["properties"]["title"] for sheet in data.get("sheets", [])]
    return str(data["properties"]["title"]), tabs


def google_sheet_headers(token: str, sheet_id: str, tab: str) -> list[str]:
    with _client() as client:
        response = client.get(
            f"{get_settings().google_sheets_url}/{sheet_id}/values/'{tab}'!1:1",
            headers={"Authorization": f"Bearer {token}"},
        )
    if response.status_code != 200:
        raise ProviderError(f"Master Sheet: {google_reason(response)}")
    rows = response.json().get("values") or [[]]
    return [str(cell) for cell in rows[0] if str(cell).strip()]


def google_drive_write_test(token: str, folder_id: str) -> None:
    """Create a small file in the folder, then delete it."""
    headers = {"Authorization": f"Bearer {token}"}
    params = {"supportsAllDrives": "true"}
    with _client() as client:
        created = client.post(
            get_settings().google_drive_url,
            params=params,
            headers=headers,
            json={
                "name": "Agent Hub connection test (safe to delete)",
                "parents": [folder_id],
                "mimeType": "text/plain",
            },
        )
        if created.status_code != 200:
            raise ProviderError(f"Drive folder: {google_reason(created)}")
        file_id = created.json()["id"]
        deleted = client.delete(
            f"{get_settings().google_drive_url}/{file_id}", params=params, headers=headers
        )
        if deleted.status_code not in (200, 204):
            raise ProviderError(f"Drive folder: the test file couldn't be deleted. {deleted.text}")


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
