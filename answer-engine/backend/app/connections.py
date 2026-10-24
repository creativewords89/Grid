"""API keys and other connection details the Owner enters in Settings → Connections.

The Owner shouldn't have to edit `.env` on the server to connect Claude, Pinecone, Telegram
or email (SPEC section 7.8). Values entered in the portal are stored in the `settings` table,
encrypted with a key derived from SECRET_KEY, and take precedence over `.env`. They are
never sent back to the browser: the page shows only whether a value is set and its last
four characters.

`current()` is what the rest of the app reads instead of `get_settings()` for these fields.
It caches the stored values for a few seconds, so a change made in the portal reaches the
worker process too without a restart.
"""

import base64
import hashlib
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy.orm import Session

from app import settings_store
from app.config import Settings, get_settings
from app.db.session import get_engine

log = logging.getLogger(__name__)

STORE_KEY = "connections"
CACHE_SECONDS = 10.0


@dataclass(frozen=True)
class Field:
    group: str
    label: str
    secret: bool = False
    number: bool = False
    placeholder: str = ""


# What the portal can set. Secrets are write-only; the others are shown as they are.
FIELDS: dict[str, Field] = {
    "anthropic_api_key": Field("anthropic", "API key", secret=True, placeholder="sk-ant-…"),
    "pinecone_api_key": Field("pinecone", "API key", secret=True, placeholder="pcsk_…"),
    "pinecone_index": Field("pinecone", "Index name", placeholder="answer-engine"),
    "pinecone_cloud": Field("pinecone", "Cloud", placeholder="aws"),
    "pinecone_region": Field("pinecone", "Region", placeholder="us-east-1"),
    "pinecone_host": Field("pinecone", "Index host (filled in by Create index)"),
    "telegram_bot_token": Field("telegram", "Bot token", secret=True, placeholder="123456:ABC…"),
    "smtp_host": Field("email", "SMTP server", placeholder="smtp.hostinger.com"),
    "smtp_port": Field("email", "Port", number=True, placeholder="587"),
    "smtp_user": Field("email", "Username"),
    "smtp_password": Field("email", "Password", secret=True),
    "smtp_from": Field("email", "From address", placeholder="answers@gridrankers.com"),
}
# Kept in the same encrypted store but never shown: made by the app itself.
HIDDEN = {"telegram_webhook_secret"}
GROUPS = {
    "anthropic": "Claude (Anthropic)",
    "pinecone": "Pinecone",
    "telegram": "Telegram",
    "email": "Email (SMTP)",
}


def _fernet() -> Fernet:
    digest = hashlib.sha256(b"connections:" + get_settings().signing_key).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt(token: str) -> str | None:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except (InvalidToken, ValueError):
        # SECRET_KEY changed since it was saved: the Owner enters it again.
        log.warning("a stored connection value can't be decrypted; enter it again in Settings")
        return None


def stored(db: Session) -> dict[str, str]:
    """The portal's values, decrypted (empty when nothing was entered)."""
    raw = settings_store.get(db, STORE_KEY) or {}
    out: dict[str, str] = {}
    for name, token in raw.items():
        if name in FIELDS or name in HIDDEN:
            value = decrypt(str(token))
            if value:
                out[name] = value
    return out


def save(db: Session, changes: dict[str, str | None]) -> None:
    """Set (or, with None or "", remove) portal values. The caller commits."""
    raw = dict(settings_store.get(db, STORE_KEY) or {})
    for name, value in changes.items():
        if value is None or value == "":
            raw.pop(name, None)
        else:
            raw[name] = encrypt(value)
    settings_store.put(db, STORE_KEY, raw)
    invalidate()


# --- what the app reads -----------------------------------------------------------------------

# Where `current()` reads stored values from; tests point this at their own database.
session_factory: Callable[[], Session | None] = lambda: Session(get_engine())  # noqa: E731
_lock = threading.Lock()
_cache: tuple[float, dict[str, str]] | None = None


def invalidate() -> None:
    global _cache
    with _lock:
        _cache = None


def _overrides() -> dict[str, str]:
    global _cache
    with _lock:
        if _cache is not None and time.monotonic() - _cache[0] < CACHE_SECONDS:
            return _cache[1]
    values: dict[str, str] = {}
    try:
        db = session_factory()
        if db is not None:
            with db:
                values = stored(db)
    except Exception:
        log.warning("couldn't read the connection settings; using .env only", exc_info=True)
    with _lock:
        _cache = (time.monotonic(), values)
    return values


def current() -> Settings:
    """The server settings with the portal's connection values on top."""
    base = get_settings()
    overrides = _overrides()
    if not overrides:
        return base
    update: dict[str, Any] = dict(overrides)
    if "smtp_port" in update:
        try:
            update["smtp_port"] = int(update["smtp_port"])
        except ValueError:
            update.pop("smtp_port")
    return base.model_copy(update=update)


def source(name: str, portal: dict[str, str]) -> str | None:
    """Where a field's value comes from: "portal", "server" (.env), "default" (the built-in
    value) or None (not set)."""
    if name in portal:
        return "portal"
    value = getattr(get_settings(), name, None)
    if value in (None, ""):
        return None
    return "default" if value == Settings.model_fields[name].default else "server"


def hint(value: str) -> str:
    """What the page shows for a secret: its last four characters only."""
    return "••••" + value[-4:] if len(value) > 8 else "••••"


# --- the Test buttons (replaced in tests) ------------------------------------------------------


def check_anthropic(api_key: str, model: str) -> None:
    """One tiny request (a few tokens) to prove the key works. Raises with a reason."""
    import anthropic

    client = anthropic.Anthropic(api_key=api_key, max_retries=1, timeout=30.0)
    client.messages.create(
        model=model, max_tokens=5, messages=[{"role": "user", "content": "Reply with OK."}]
    )


def setup_pinecone(settings: Settings) -> tuple[str, str]:
    """Create the index if it doesn't exist. Returns (summary, index host)."""
    from app.kb.store import PineconeStore

    store = PineconeStore(settings.pinecone_api_key, settings.pinecone_index)
    summary = store.ensure_index(
        settings.pinecone_cloud, settings.pinecone_region, settings.pinecone_embed_model
    )
    return summary, store.index_host()
