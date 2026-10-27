"""API keys and accounts the Owner enters on the Connections screen (SPEC section 6.1).

Everything is entered in the website; nothing comes from `.env`. Values are stored in the
`settings` table, each encrypted with a key derived from SECRET_KEY. Secrets are never sent
back to the browser: the page shows only whether one is set and its last four characters.

`current()` is what the rest of the Hub reads. It caches the stored values for a few
seconds, so a change made in the website reaches the scheduler too without a restart.
"""

import base64
import hashlib
import json
import logging
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy.orm import Session

from app import settings_store
from app.config import get_settings
from app.db.session import get_engine

log = logging.getLogger(__name__)

STORE_KEY = "connections"
CACHE_SECONDS = 10.0

Kind = Literal["text", "secret", "number", "json"]


@dataclass(frozen=True)
class Field:
    group: str
    label: str
    kind: Kind = "text"
    placeholder: str = ""
    required: bool = True

    @property
    def secret(self) -> bool:
        # A service account key file holds a private key, so it is write-only too.
        return self.kind in ("secret", "json")


FIELDS: dict[str, Field] = {
    "dataforseo_login": Field("dataforseo", "Login (API email)", placeholder="you@gridrankers.com"),
    "dataforseo_password": Field("dataforseo", "API password", "secret"),
    "google_service_account": Field("google", "Service account key (JSON file)", "json"),
    "google_sheet_url": Field(
        "google", "Master Sheet link", placeholder="https://docs.google.com/spreadsheets/d/…"
    ),
    "google_drive_folder_url": Field(
        "google", "Drive folder link", placeholder="https://drive.google.com/drive/folders/…"
    ),
    "pagespeed_api_key": Field("pagespeed", "API key", "secret", placeholder="AIza…"),
    "smtp_host": Field("email", "SMTP server", placeholder="smtp.hostinger.com"),
    "smtp_port": Field("email", "Port", "number", placeholder="587"),
    "smtp_user": Field("email", "Username", required=False),
    "smtp_password": Field("email", "Password", "secret", required=False),
    "smtp_from": Field("email", "From address", placeholder="hub@gridrankers.com"),
    "telegram_bot_token": Field("telegram", "Bot token", "secret", placeholder="123456:ABC…"),
    "telegram_chat_id": Field(
        "telegram",
        "Alerts group",
        placeholder="Filled in by the Test button",
        required=False,
    ),
}
GROUPS = {
    "dataforseo": "DataForSEO",
    "google": "Google (Sheets and Drive)",
    "pagespeed": "PageSpeed Insights",
    "email": "Email (SMTP)",
    "telegram": "Telegram alerts",
}


# --- checking what is typed ---------------------------------------------------------------

SHEET_ID = re.compile(r"/spreadsheets/d/([A-Za-z0-9_-]{20,})")
FOLDER_ID = re.compile(r"/folders/([A-Za-z0-9_-]{10,})")
SERVICE_ACCOUNT_KEYS = ("client_email", "private_key", "token_uri")


def sheet_id(url: str) -> str | None:
    match = SHEET_ID.search(url)
    return match.group(1) if match else None


def folder_id(url: str) -> str | None:
    match = FOLDER_ID.search(url)
    return match.group(1) if match else None


def problem(name: str, value: str) -> str | None:
    """Why a value can't be saved, or None. Never repeats the value."""
    field = FIELDS[name]
    if field.kind == "number" and not (value.isdigit() and 0 < int(value) < 65536):
        return "Enter a port number, like 587 or 465."
    if field.kind == "json":
        try:
            data = json.loads(value)
        except ValueError:
            return "This isn't a JSON key file. Download the key again as JSON."
        if not isinstance(data, dict) or data.get("type") != "service_account":
            return "This isn't a service account key. In Google Cloud, create a key of type JSON."
        if any(not data.get(key) for key in SERVICE_ACCOUNT_KEYS):
            return "This key file is incomplete. Download it again."
    if name == "google_sheet_url" and sheet_id(value) is None:
        return "Paste the Sheet's link from the browser's address bar."
    if name == "google_drive_folder_url" and folder_id(value) is None:
        return "Paste the folder's link from the browser's address bar."
    if name == "smtp_from" and "@" not in value:
        return "Enter an email address."
    if name == "telegram_chat_id" and not re.fullmatch(r"-?\d{3,20}", value):
        return "A group id is a number, like -1001234567890. Leave it empty to find it."
    return None


# --- storing -------------------------------------------------------------------------------


def _fernet() -> Fernet:
    digest = hashlib.sha256(b"connections:" + get_settings().signing_key).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt(token: str) -> str | None:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except (InvalidToken, ValueError):
        return None


def unreadable(db: Session) -> set[str]:
    """Saved values that can't be decrypted: SECRET_KEY changed since, enter them again."""
    raw = settings_store.get(db, STORE_KEY) or {}
    return {name for name, token in raw.items() if name in FIELDS and decrypt(str(token)) is None}


def stored(db: Session) -> dict[str, str]:
    """The saved values, decrypted (unreadable ones are left out)."""
    raw = settings_store.get(db, STORE_KEY) or {}
    out: dict[str, str] = {}
    for name, token in raw.items():
        if name in FIELDS:
            value = decrypt(str(token))
            if value is None:
                log.warning("a saved connection value can't be read; enter it again")
            elif value:
                out[name] = value
    return out


def save(db: Session, changes: dict[str, str | None]) -> None:
    """Set (or, with None or "", remove) values. The caller commits."""
    raw = dict(settings_store.get(db, STORE_KEY) or {})
    for name, value in changes.items():
        if value is None or value == "":
            raw.pop(name, None)
        else:
            raw[name] = encrypt(value)
    settings_store.put(db, STORE_KEY, raw)
    invalidate()


def ready(values: dict[str, str], group: str) -> bool:
    """Every required field of the group is filled in."""
    return all(
        values.get(name)
        for name, field in FIELDS.items()
        if field.group == group and field.required
    )


def hint(value: str) -> str:
    """What the page shows for a secret: its last four characters only."""
    return "••••" + value[-4:] if len(value) > 8 else "••••"


# --- what the rest of the Hub reads -------------------------------------------------------

# Where `current()` reads values from; tests point this at their own database.
session_factory: Callable[[], Session | None] = lambda: Session(get_engine())  # noqa: E731
_lock = threading.Lock()
_cache: tuple[float, dict[str, str]] | None = None


def invalidate() -> None:
    global _cache
    with _lock:
        _cache = None


def current() -> dict[str, str]:
    """The saved connection values (cached for a few seconds)."""
    global _cache
    with _lock:
        if _cache is not None and time.monotonic() - _cache[0] < CACHE_SECONDS:
            return dict(_cache[1])
    values: dict[str, str] = {}
    try:
        db = session_factory()
        if db is not None:
            with db:
                values = stored(db)
    except Exception:
        log.warning("couldn't read the connection settings", exc_info=True)
    with _lock:
        _cache = (time.monotonic(), values)
    return dict(values)
