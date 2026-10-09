"""Shared fixtures.

Tests that need PostgreSQL get throw-away databases created through TEST_DATABASE_URL (a
server URL whose user may CREATE DATABASE). Locally:

    TEST_DATABASE_URL=postgresql+psycopg://answers:answers@localhost:5432/postgres
"""

import os
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.api.conversations import answerer_dep, store_dep
from app.auth.passwords import hash_password
from app.config import get_settings
from app.db.base import Base
from app.db.models import Role, User
from app.db.session import get_session
from app.jobs import handlers  # noqa: F401  (registers every job type)
from app.jobs.queue import run_next
from app.mail import get_mailer
from app.main import create_app
from tests.fakes import FakeAnswerer, FakeStore

DEFAULT_SERVER_URL = "postgresql+psycopg://answers:answers@localhost:5432/postgres"
BACKEND = Path(__file__).resolve().parent.parent
PASSWORD = "correct horse battery staple"


@pytest.fixture(autouse=True)
def upload_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Every test stores uploads in its own temporary folder."""
    folder = tmp_path / "uploads"
    monkeypatch.setenv("UPLOAD_DIR", str(folder))
    # Never call the real Claude API from tests, whatever key the developer has set.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    get_settings.cache_clear()
    yield folder
    get_settings.cache_clear()


@contextmanager
def temporary_database() -> Iterator[str]:
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


def alembic_config(database_url: str) -> Config:
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "app/db/alembic"))
    cfg.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))
    cfg.attributes["configure_logger"] = False
    return cfg


@pytest.fixture
def fresh_database_url() -> Iterator[str]:
    """An empty database, for migration tests."""
    with temporary_database() as url:
        yield url


@pytest.fixture(scope="session")
def engine() -> Iterator[Engine]:
    """One database migrated to head for the whole run; tables are emptied after each test."""
    with temporary_database() as url:
        command.upgrade(alembic_config(url), "head")
        eng = create_engine(url)
        yield eng
        eng.dispose()


@pytest.fixture
def clean_engine(engine: Engine) -> Iterator[Engine]:
    yield engine
    tables = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
    with engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {tables} CASCADE"))


@pytest.fixture
def db(clean_engine: Engine) -> Iterator[Session]:
    with Session(clean_engine, expire_on_commit=False) as session:
        yield session


@dataclass
class Email:
    to: str
    subject: str
    body: str


@dataclass
class FakeMailer:
    working: bool = True
    outbox: list[Email] = field(default_factory=list)

    def send(self, to: str, subject: str, body: str) -> bool:
        if self.working:
            self.outbox.append(Email(to, subject, body))
        return self.working

    def link(self, marker: str) -> str:
        """The secret after `marker` (e.g. "/invite#") in the latest email."""
        body = self.outbox[-1].body
        return body.split(marker, 1)[1].split()[0]


@pytest.fixture
def mailer() -> FakeMailer:
    return FakeMailer()


@pytest.fixture
def app_factory(clean_engine: Engine, mailer: FakeMailer) -> Callable[[], TestClient]:
    def make() -> TestClient:
        app = create_app()

        def session_override() -> Iterator[Session]:
            with Session(clean_engine, expire_on_commit=False) as session:
                yield session

        app.dependency_overrides[get_session] = session_override
        app.dependency_overrides[get_mailer] = lambda: mailer
        # https so the Secure session cookie is sent back.
        return TestClient(app, base_url="https://testserver")

    return make


@pytest.fixture
def client(app_factory: Callable[[], TestClient]) -> TestClient:
    return app_factory()


UserFactory = Callable[..., User]


@pytest.fixture
def make_user(db: Session) -> UserFactory:
    def make(
        role: Role = Role.USER,
        email: str | None = None,
        name: str = "Test Person",
        password: str | None = PASSWORD,
        active: bool = True,
    ) -> User:
        user = User(
            email=email or f"{uuid.uuid4().hex[:10]}@example.com",
            name=name,
            role=role,
            password_hash=hash_password(password) if password else None,
            active=active,
        )
        db.add(user)
        db.commit()
        return user

    return make


def sign_in(client: TestClient, email: str, password: str = PASSWORD) -> dict[str, object]:
    """Sign in and send the CSRF token with every later request from this client."""
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    body: dict[str, object] = response.json()
    client.headers["X-CSRF-Token"] = str(body["csrf_token"])
    return body


if TYPE_CHECKING:
    from tests.fakes import FakeOcr

RunJobs = Callable[[], int]


@pytest.fixture
def run_jobs(clean_engine: Engine) -> RunJobs:
    """Run every due job, like the worker would. Returns how many ran."""

    def run() -> int:
        count = 0
        while run_next(lambda: Session(clean_engine, expire_on_commit=False), "test-worker"):
            count += 1
        return count

    return run


@pytest.fixture
def fake_ocr(monkeypatch: pytest.MonkeyPatch) -> "FakeOcr":
    """Read scanned pages with a stand-in for Claude."""
    from app.jobs import handlers as job_handlers
    from tests.fakes import FakeOcr

    fake = FakeOcr()
    monkeypatch.setattr(job_handlers, "get_ocr", lambda: fake)
    monkeypatch.setattr("app.files.ocr.RETRY_WAIT", (0.0, 0.0))
    return fake


# --- asking questions (Claude and Pinecone faked) ----------------------------------------


@pytest.fixture
def store() -> FakeStore:
    return FakeStore()


@pytest.fixture
def answerer() -> FakeAnswerer:
    return FakeAnswerer()


@pytest.fixture
def ask_client(
    app_factory: Callable[[], TestClient], store: FakeStore, answerer: FakeAnswerer
) -> Callable[[], TestClient]:
    def make() -> TestClient:
        client = app_factory()
        client.app.dependency_overrides[answerer_dep] = lambda: answerer  # type: ignore[attr-defined]
        client.app.dependency_overrides[store_dep] = lambda: store  # type: ignore[attr-defined]
        return client

    return make


@pytest.fixture
def me(ask_client: Callable[[], TestClient], make_user: UserFactory) -> tuple[TestClient, User]:
    client = ask_client()
    user = make_user(Role.USER, name="Sara")
    sign_in(client, user.email)
    return client, user
