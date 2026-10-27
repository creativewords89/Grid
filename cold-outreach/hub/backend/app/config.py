"""Settings read from the environment (`.env` on the server, SPEC section 10).

Only what the Hub needs before it can read its own database lives here. Every other key
(DataForSEO, Google, SMTP, Telegram …) is entered in the website (SPEC section 6.1).
"""

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: Literal["development", "test", "production"] = "development"
    app_url: str = "http://localhost:8080"
    # Derives the setup code (and, from step 3, the key that encrypts Connections).
    # 32+ random characters; required in production.
    secret_key: str = ""
    database_url: str = Field(
        default="postgresql+psycopg://hub:hub@localhost:5432/hub",
        description="SQLAlchemy URL, always the psycopg (v3) driver.",
    )
    # The outside services' addresses. Only the end-to-end tests change them (to local fakes).
    dataforseo_url: str = "https://api.dataforseo.com/v3"
    google_token_url: str = "https://oauth2.googleapis.com/token"  # noqa: S105 (an address)
    google_sheets_url: str = "https://sheets.googleapis.com/v4/spreadsheets"
    google_drive_url: str = "https://www.googleapis.com/drive/v3/files"
    pagespeed_url: str = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
    telegram_url: str = "https://api.telegram.org"
    # The backup service's status file (ops/backup.sh). Empty: backups aren't checked.
    backup_status_file: str = ""
    # One JSON object per log line in production (SPEC section 9).
    json_logs: bool = False

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def signing_key(self) -> bytes:
        if self.secret_key:
            return self.secret_key.encode()
        if self.is_production:
            raise RuntimeError("Set SECRET_KEY in .env (32+ random characters).")
        return b"development-only-signing-key"

    def link(self, path: str) -> str:
        return self.app_url.rstrip("/") + path


@lru_cache
def get_settings() -> Settings:
    return Settings()
