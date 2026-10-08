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

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
