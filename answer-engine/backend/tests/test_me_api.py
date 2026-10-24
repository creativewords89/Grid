"""A person's own profile and password (SPEC section 7.9)."""

from collections.abc import Callable

from fastapi.testclient import TestClient

from app.db.models import Role
from tests.conftest import PASSWORD, UserFactory, sign_in

NEW_PASSWORD = "a brand new passphrase"


def test_everyone_can_rename_themselves(client: TestClient, make_user: UserFactory) -> None:
    for role in Role:
        user = make_user(role)
        sign_in(client, user.email)

        response = client.patch("/api/me", json={"name": f"  New {role.value} "})

        assert response.json()["name"] == f"New {role.value}"


def test_cannot_change_own_role_through_profile(client: TestClient, make_user: UserFactory) -> None:
    user = make_user()
    sign_in(client, user.email)

    response = client.patch("/api/me", json={"name": "X", "role": "owner"})

    assert response.status_code == 422


def test_change_password_needs_the_current_one(client: TestClient, make_user: UserFactory) -> None:
    user = make_user()
    sign_in(client, user.email)

    response = client.post(
        "/api/me/password", json={"current_password": "wrong one!", "new_password": NEW_PASSWORD}
    )

    assert response.status_code == 422
    assert "current_password" in response.json()["error"]["fields"]


def test_change_password_applies_the_rules(client: TestClient, make_user: UserFactory) -> None:
    user = make_user()
    sign_in(client, user.email)

    response = client.post(
        "/api/me/password", json={"current_password": PASSWORD, "new_password": "short"}
    )

    assert response.json()["error"]["fields"] == {"new_password": "Use at least 10 characters."}


def test_change_password_signs_out_other_devices_only(
    app_factory: Callable[[], TestClient], make_user: UserFactory
) -> None:
    user = make_user()
    laptop, phone = app_factory(), app_factory()
    sign_in(laptop, user.email)
    sign_in(phone, user.email)

    response = laptop.post(
        "/api/me/password", json={"current_password": PASSWORD, "new_password": NEW_PASSWORD}
    )

    assert response.status_code == 200
    assert laptop.get("/api/auth/me").status_code == 200
    assert phone.get("/api/auth/me").status_code == 401
