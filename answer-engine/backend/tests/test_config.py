from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> Iterator[pytest.MonkeyPatch]:
    get_settings.cache_clear()
    yield monkeypatch
    get_settings.cache_clear()


def test_api_docs_available_outside_production(env: pytest.MonkeyPatch) -> None:
    env.setenv("APP_ENV", "development")

    assert TestClient(create_app()).get("/api/openapi.json").status_code == 200


def test_api_docs_hidden_in_production(env: pytest.MonkeyPatch) -> None:
    env.setenv("APP_ENV", "production")
    client = TestClient(create_app())

    assert client.get("/api/openapi.json").status_code == 404
    assert client.get("/api/docs").status_code == 404
