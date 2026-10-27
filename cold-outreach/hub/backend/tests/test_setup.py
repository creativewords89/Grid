"""First run: create the Owner from the browser with the setup code (SPEC section 4)."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.setup import setup_code
from app.db.models import AuditEntry, Role, User
from tests.conftest import PASSWORD, UserFactory


def test_setup_creates_the_first_owner_and_signs_them_in(client: TestClient, db: Session) -> None:
    assert client.get("/api/setup").json() == {"needed": True}
    body = {
        "code": setup_code().lower().replace("-", " "),  # typed casually still works
        "name": "Olivia",
        "email": "Olivia@Example.com",
        "password": PASSWORD,
    }

    response = client.post("/api/setup", json=body)

    assert response.status_code == 201, response.text
    assert response.json()["user"]["role"] == "owner"
    assert client.get("/api/auth/me").status_code == 200
    owner = db.scalars(select(User)).one()
    assert (owner.email, owner.role) == ("olivia@example.com", Role.OWNER)
    assert db.scalars(select(AuditEntry.action)).all() == ["create"]
    assert client.get("/api/setup").json() == {"needed": False}
    again = client.post("/api/setup", json=body | {"email": "x@example.com"})
    assert again.status_code == 409


def test_setup_needs_the_code_and_a_good_password(client: TestClient, db: Session) -> None:
    base = {"name": "Olivia", "email": "o@example.com", "password": PASSWORD}
    wrong = client.post("/api/setup", json=base | {"code": "AAAA-BBBB-CCCC"})
    assert wrong.status_code == 403
    weak = client.post("/api/setup", json=base | {"code": setup_code(), "password": "short"})
    assert weak.status_code == 422
    assert db.scalar(select(User.id)) is None


def test_setup_is_closed_once_anyone_has_an_account(
    client: TestClient, make_user: UserFactory
) -> None:
    make_user(Role.VIEWER)
    assert client.get("/api/setup").json() == {"needed": False}
    response = client.post(
        "/api/setup",
        json={"code": setup_code(), "name": "X", "email": "x@example.com", "password": PASSWORD},
    )
    assert response.status_code == 409


def test_wrong_codes_count_towards_the_sign_in_limit(client: TestClient) -> None:
    body = {"code": "AAAA-BBBB-CCCC", "name": "X", "email": "x@example.com", "password": PASSWORD}
    codes = [client.post("/api/setup", json=body).status_code for _ in range(11)]

    assert codes[:10] == [403] * 10
    assert codes[10] == 429


def test_the_code_depends_on_the_secret_key(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.config import get_settings

    monkeypatch.setenv("SECRET_KEY", "one-secret-key-that-is-long-enough-xx")
    get_settings.cache_clear()
    first = setup_code()
    monkeypatch.setenv("SECRET_KEY", "another-secret-key-that-is-long-enough")
    get_settings.cache_clear()

    assert setup_code() != first
    assert len(first.replace("-", "")) == 12


def test_cli_prints_the_setup_code(
    clean_engine: object, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from app import cli

    monkeypatch.setattr(cli, "get_engine", lambda: clean_engine)
    cli.main(["setup-code"])

    assert setup_code() in capsys.readouterr().out
