"""Shared fixtures.

Tests that need PostgreSQL get a fresh, throw-away database per test session, created
through TEST_DATABASE_URL (a server URL whose user may CREATE DATABASE). Locally:

    TEST_DATABASE_URL=postgresql+psycopg://answers:answers@localhost:5432/postgres
"""

import os
import uuid
from collections.abc import Iterator

import pytest
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.engine import make_url

DEFAULT_SERVER_URL = "postgresql+psycopg://answers:answers@localhost:5432/postgres"


@pytest.fixture(scope="session")
def database_url() -> Iterator[str]:
    server_url = make_url(os.environ.get("TEST_DATABASE_URL", DEFAULT_SERVER_URL))
    name = f"answers_test_{uuid.uuid4().hex[:8]}"
    admin = create_engine(server_url, isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as conn:
            conn.execute(text(f'CREATE DATABASE "{name}"'))
    except Exception as exc:  # pragma: no cover - only when no server is running
        admin.dispose()
        pytest.skip(f"PostgreSQL not reachable at {server_url!r}: {exc}")
    try:
        yield server_url.set(database=name).render_as_string(hide_password=False)
    finally:
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()


@pytest.fixture(scope="session")
def engine(database_url: str) -> Iterator[Engine]:
    eng = create_engine(database_url)
    yield eng
    eng.dispose()
