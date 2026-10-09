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

    # Original uploads live here, under random names (SPEC section 2).
    upload_dir: str = "/data/uploads"

    # Claude (SPEC section 9). Without a key, scanned pages and images are skipped with a
    # warning instead of being read.
    anthropic_api_key: str = ""
    ocr_model: str = "claude-opus-5-5"
    answer_model: str = "claude-opus-5-5"
    rewrite_model: str = "claude-opus-5-5"
    check_model: str = "claude-opus-5-5"

    # Pinecone (SPEC section 6.3). Without a key, changes wait in the outbox (kb_ops).
    pinecone_api_key: str = ""
    pinecone_index: str = "answer-engine"
    # Optional: the index's host (printed by setup-pinecone). Saves a lookup per start.
    pinecone_host: str = ""
    pinecone_cloud: str = "aws"
    pinecone_region: str = "us-east-1"
    # Fixed when the index is created; changing it means a new index and a rebuild.
    pinecone_embed_model: str = "llama-text-embed-v2"

    # Telegram review bot (SPEC section 6.7). Without a token, reviews use the web queue only.
    telegram_bot_token: str = ""
    telegram_webhook_secret: str = ""
    telegram_api_url: str = "https://api.telegram.org"

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
