"""Users screen API (SPEC sections 3, 4 and 7.7)."""

from collections.abc import Callable

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import AuthSession, Role, User
from tests.conftest import FakeMailer, UserFactory, sign_in


@pytest.fixture
def owner(client: TestClient, make_user: UserFactory) -> User:
    user = make_user(Role.OWNER, name="Olivia")
    sign_in(client, user.email)
    return user


def test_owner_lists_everyone(client: TestClient, owner: User, make_user: UserFactory) -> None:
    make_user(Role.REVIEWER, name="bob")
    make_user(password=None, name="Ann")

    users = client.get("/api/users").json()

    assert [u["name"] for u in users] == ["Ann", "bob", "Olivia"]
    assert [u["invited"] for u in users] == [True, False, False]
    assert "password_hash" not in users[0]


@pytest.mark.parametrize("role", [Role.REVIEWER, Role.USER])
def test_only_the_owner_manages_people(
    client: TestClient, make_user: UserFactory, role: Role
) -> None:
    me, other = make_user(role), make_user()
    sign_in(client, me.email)

    responses = [
        client.get("/api/users"),
        client.post(
            "/api/users/invite", json={"name": "X", "email": "x@example.com", "role": "user"}
        ),
        client.patch(f"/api/users/{other.id}", json={"role": "owner"}),
        client.post(f"/api/users/{other.id}/reset-password"),
        client.post(f"/api/users/{other.id}/resend-invite"),
    ]

    assert [r.status_code for r in responses] == [403] * 5
    assert responses[0].json()["error"]["code"] == "forbidden"


def test_invite_creates_the_person_and_emails_them(
    client: TestClient, owner: User, mailer: FakeMailer, db: Session
) -> None:
    response = client.post(
        "/api/users/invite",
        json={"name": " Nadia ", "email": "Nadia@Example.com", "role": "reviewer"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["email_sent"] is True
    assert body["link"] is None
    assert body["user"]["email"] == "nadia@example.com"
    assert body["user"]["name"] == "Nadia"
    assert body["user"]["invited"] is True
    assert mailer.outbox[0].to == "nadia@example.com"
    assert "Olivia has invited you" in mailer.outbox[0].body
    assert db.scalar(select(User).where(User.email == "nadia@example.com")) is not None


def test_invite_returns_the_link_when_email_is_not_working(
    client: TestClient, owner: User, mailer: FakeMailer
) -> None:
    mailer.working = False

    body = client.post(
        "/api/users/invite", json={"name": "Nadia", "email": "n@example.com", "role": "user"}
    ).json()

    assert body["email_sent"] is False
    assert body["link"].startswith("http://localhost:8080/invite#")


def test_invite_refuses_an_email_already_used(
    client: TestClient, owner: User, make_user: UserFactory
) -> None:
    make_user(email="taken@example.com")

    response = client.post(
        "/api/users/invite", json={"name": "X", "email": "TAKEN@example.com", "role": "user"}
    )

    assert response.status_code == 409
    assert response.json()["error"]["fields"] == {"email": "Already used."}


def test_invite_validates_its_fields(client: TestClient, owner: User) -> None:
    response = client.post(
        "/api/users/invite", json={"name": "", "email": "not-an-email", "role": "boss"}
    )

    assert response.status_code == 422
    assert set(response.json()["error"]["fields"]) == {"name", "email", "role"}


def test_resend_invite_only_for_people_who_have_not_accepted(
    client: TestClient, owner: User, make_user: UserFactory, mailer: FakeMailer
) -> None:
    pending, accepted = make_user(password=None), make_user()

    assert client.post(f"/api/users/{pending.id}/resend-invite").json()["email_sent"] is True
    assert mailer.outbox[-1].to == pending.email
    assert client.post(f"/api/users/{accepted.id}/resend-invite").status_code == 409


def test_owner_sends_a_password_reset(
    client: TestClient, owner: User, make_user: UserFactory, mailer: FakeMailer
) -> None:
    person, pending = make_user(), make_user(password=None)

    assert client.post(f"/api/users/{person.id}/reset-password").json()["email_sent"] is True
    assert "/reset#" in mailer.outbox[-1].body
    assert client.post(f"/api/users/{pending.id}/reset-password").status_code == 409


def test_unknown_person_is_404(client: TestClient, owner: User) -> None:
    response = client.patch("/api/users/0192f3a4-0000-7000-8000-000000000000", json={"name": "X"})

    assert response.status_code == 404


def test_change_name_and_role(client: TestClient, owner: User, make_user: UserFactory) -> None:
    person = make_user()

    body = client.patch(f"/api/users/{person.id}", json={"name": "Sam", "role": "reviewer"}).json()

    assert (body["name"], body["role"]) == ("Sam", "reviewer")


def test_deactivating_someone_signs_them_out(
    app_factory: Callable[[], TestClient], make_user: UserFactory, db: Session
) -> None:
    owner, person = make_user(Role.OWNER), make_user()
    admin, their_phone = app_factory(), app_factory()
    sign_in(admin, owner.email)
    sign_in(their_phone, person.email)

    response = admin.patch(f"/api/users/{person.id}", json={"active": False})

    assert response.json()["active"] is False
    assert db.scalar(select(AuthSession).where(AuthSession.user_id == person.id)) is None
    assert their_phone.get("/api/auth/me").status_code == 401


def test_owner_cannot_deactivate_themselves(client: TestClient, owner: User) -> None:
    response = client.patch(f"/api/users/{owner.id}", json={"active": False})

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "self_deactivate"


def test_the_last_owner_cannot_be_demoted(client: TestClient, owner: User) -> None:
    response = client.patch(f"/api/users/{owner.id}", json={"role": "reviewer"})

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "last_owner"


def test_an_inactive_owner_does_not_count(
    client: TestClient, owner: User, make_user: UserFactory
) -> None:
    make_user(Role.OWNER, active=False)

    response = client.patch(f"/api/users/{owner.id}", json={"role": "user"})

    assert response.status_code == 409


def test_with_two_owners_one_can_be_demoted_or_deactivated(
    client: TestClient, owner: User, make_user: UserFactory
) -> None:
    second, third = make_user(Role.OWNER), make_user(Role.OWNER)

    assert client.patch(f"/api/users/{second.id}", json={"role": "user"}).status_code == 200
    assert client.patch(f"/api/users/{third.id}", json={"active": False}).status_code == 200
    assert client.patch(f"/api/users/{owner.id}", json={"role": "user"}).status_code == 409


def test_owner_can_demote_themselves_when_another_owner_exists(
    client: TestClient, owner: User, make_user: UserFactory
) -> None:
    make_user(Role.OWNER)

    assert client.patch(f"/api/users/{owner.id}", json={"role": "reviewer"}).status_code == 200
    # Now a Reviewer: managing people is refused.
    assert client.get("/api/users").status_code == 403
