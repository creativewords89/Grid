"""Settings read from the environment (`.env` on the server, SPEC section 13.3)."""

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: Literal["development", "test", "production"] = "development"
    app_url: str = "http://localhost:8080"
    database_url: str = Field(
        default="postgresql+psycopg://answers:answers@localhost:5432/answers",
        description="SQLAlchemy URL, always the psycopg (v3) driver.",
    )

    # Email (SPEC section 2). Empty SMTP_HOST means email is not configured: links are
    # logged and, where the Owner asked for them, returned to the Owner instead.
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def email_configured(self) -> bool:
        return bool(self.smtp_host and self.smtp_from)

    def link(self, path: str) -> str:
        return self.app_url.rstrip("/") + path


@lru_cache
def get_settings() -> Settings:
    return Settings()
