import io

import pytest
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app import cli
from app.auth.passwords import verify_password
from app.db.models import Role, User

GOOD = "a long owner passphrase"


@pytest.fixture
def run(clean_engine: Engine, monkeypatch: pytest.MonkeyPatch):  # type: ignore[no-untyped-def]
    monkeypatch.setattr(cli, "get_engine", lambda: clean_engine)

    def run(*args: str, password: str = GOOD) -> None:
        monkeypatch.setattr("sys.stdin", io.StringIO(password + "\n"))
        cli.main(["create-owner", "--password-stdin", *args])

    return run


def test_create_owner(run, db: Session) -> None:  # type: ignore[no-untyped-def]
    run("--email", " Boss@Example.com ", "--name", "Boss")

    owner = db.scalars(select(User)).one()
    assert (owner.email, owner.name, owner.role, owner.active) == (
        "boss@example.com",
        "Boss",
        Role.OWNER,
        True,
    )
    assert verify_password(owner.password_hash, GOOD)


def test_create_owner_refuses_a_duplicate(run) -> None:  # type: ignore[no-untyped-def]
    run("--email", "boss@example.com", "--name", "Boss")

    with pytest.raises(SystemExit, match="already has an account"):
        run("--email", "BOSS@example.com", "--name", "Boss 2")


def test_create_owner_refuses_a_weak_password(run, db: Session) -> None:  # type: ignore[no-untyped-def]
    with pytest.raises(SystemExit, match="at least 10"):
        run("--email", "boss@example.com", "--name", "Boss", password="short")

    assert db.scalar(select(User)) is None


def test_create_owner_refuses_a_bad_email(run) -> None:  # type: ignore[no-untyped-def]
    with pytest.raises(SystemExit, match="Invalid email"):
        run("--email", "not-an-email", "--name", "Boss")
