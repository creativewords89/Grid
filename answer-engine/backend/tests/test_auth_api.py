"""Sign in, sessions, CSRF, lockout, forgot / reset and invites (SPEC section 4)."""

from collections.abc import Callable
from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.auth.sessions import COOKIE_NAME, SESSION_TTL
from app.auth.tokens import hash_secret, now
from app.db.models import AuthSession, AuthToken, LoginAttempt, Role, User
from tests.conftest import PASSWORD, FakeMailer, UserFactory, sign_in

BAD_LOGIN = {"error": {"code": "bad_credentials", "message": "Email or password is incorrect."}}
NEW_PASSWORD = "a brand new passphrase"


def login(client: TestClient, email: str, password: str = PASSWORD) -> int:
    return client.post("/api/auth/login", json={"email": email, "password": password}).status_code


# --- sign in and sessions ---------------------------------------------------------------


def test_sign_in_sets_a_secure_session_cookie(client: TestClient, make_user: UserFactory) -> None:
    user = make_user(Role.REVIEWER, email="sara@example.com", name="Sara")

    response = client.post(
        "/api/auth/login", json={"email": "  Sara@Example.com ", "password": PASSWORD}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["user"]["id"] == str(user.id)
    assert body["user"]["role"] == "reviewer"
    assert len(body["csrf_token"]) > 20
    cookie = response.headers["set-cookie"]
    assert cookie.startswith(f"{COOKIE_NAME}=")
    for flag in ("HttpOnly", "Secure", "SameSite=lax", "Max-Age=2592000"):
        assert flag.lower() in cookie.lower()


def test_session_token_is_stored_hashed(
    client: TestClient, make_user: UserFactory, db: Session
) -> None:
    user = make_user()
    sign_in(client, user.email)
    secret = client.cookies[COOKIE_NAME]

    stored = db.scalars(select(AuthSession.token_hash)).one()

    assert stored == hash_secret(secret)
    assert secret not in stored


def test_me_returns_the_signed_in_person(client: TestClient, make_user: UserFactory) -> None:
    user = make_user(name="Ali")
    signed_in = sign_in(client, user.email)

    me = client.get("/api/auth/me").json()

    assert me["user"]["name"] == "Ali"
    assert me["csrf_token"] == signed_in["csrf_token"]


def test_wrong_password_and_unknown_email_get_the_same_answer(
    client: TestClient, make_user: UserFactory
) -> None:
    user = make_user()

    wrong = client.post("/api/auth/login", json={"email": user.email, "password": "nope nope"})
    unknown = client.post("/api/auth/login", json={"email": "x@example.com", "password": "nope"})

    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json() == BAD_LOGIN


def test_deactivated_and_invited_people_cannot_sign_in(
    client: TestClient, make_user: UserFactory
) -> None:
    inactive = make_user(active=False)
    invited = make_user(password=None)

    assert login(client, inactive.email) == 401
    assert login(client, invited.email, "") == 422
    assert login(client, invited.email, "anything at all") == 401


def test_everything_but_auth_and_health_needs_a_session(client: TestClient) -> None:
    for path in ("/api/auth/me", "/api/users"):
        response = client.get(path)
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "unauthenticated"
    assert client.get("/api/health").status_code == 200


def test_sign_in_needs_json(client: TestClient, make_user: UserFactory) -> None:
    user = make_user()

    response = client.post("/api/auth/login", data={"email": user.email, "password": PASSWORD})

    assert response.status_code == 422


def test_sign_out_ends_the_session(client: TestClient, make_user: UserFactory, db: Session) -> None:
    user = make_user()
    sign_in(client, user.email)
    secret = client.cookies[COOKIE_NAME]

    assert client.post("/api/auth/logout").status_code == 204

    assert db.scalar(select(AuthSession)) is None
    client.cookies.set(COOKIE_NAME, secret)
    assert client.get("/api/auth/me").status_code == 401


def test_expired_session_is_refused(
    client: TestClient, make_user: UserFactory, db: Session
) -> None:
    user = make_user()
    sign_in(client, user.email)
    db.execute(update(AuthSession).values(expires_at=now() - timedelta(seconds=1)))
    db.commit()

    assert client.get("/api/auth/me").status_code == 401


def test_session_expiry_slides_forward(
    client: TestClient, make_user: UserFactory, db: Session
) -> None:
    user = make_user()
    sign_in(client, user.email)
    db.execute(update(AuthSession).values(expires_at=now() + timedelta(days=20)))
    db.commit()

    response = client.get("/api/auth/me")

    assert response.status_code == 200
    assert COOKIE_NAME in response.headers.get("set-cookie", "")
    expires = db.scalar(select(AuthSession.expires_at).execution_options(populate_existing=True))
    assert expires is not None
    assert expires > now() + SESSION_TTL - timedelta(minutes=1)


def test_deactivating_someone_ends_their_session_at_once(
    client: TestClient, make_user: UserFactory, db: Session
) -> None:
    user = make_user()
    sign_in(client, user.email)
    db.execute(update(User).where(User.id == user.id).values(active=False))
    db.commit()

    assert client.get("/api/auth/me").status_code == 401


# --- CSRF ---------------------------------------------------------------------------------


def test_writes_need_the_csrf_token(client: TestClient, make_user: UserFactory) -> None:
    user = make_user()
    sign_in(client, user.email)
    token = client.headers.pop("X-CSRF-Token")

    missing = client.post("/api/auth/logout")
    wrong = client.post("/api/auth/logout", headers={"X-CSRF-Token": token[::-1]})
    right = client.post("/api/auth/logout", headers={"X-CSRF-Token": token})

    assert missing.status_code == wrong.status_code == 403
    assert missing.json()["error"]["code"] == "csrf"
    assert right.status_code == 204


def test_reads_do_not_need_the_csrf_token(client: TestClient, make_user: UserFactory) -> None:
    user = make_user()
    sign_in(client, user.email)
    client.headers.pop("X-CSRF-Token")

    assert client.get("/api/auth/me").status_code == 200


# --- lockout ------------------------------------------------------------------------------


def test_five_failures_lock_that_email_and_ip_for_15_minutes(
    client: TestClient, make_user: UserFactory, db: Session
) -> None:
    user = make_user()
    for _ in range(5):
        assert login(client, user.email, "wrong password") == 401

    locked = client.post("/api/auth/login", json={"email": user.email, "password": PASSWORD})

    assert locked.status_code == 429
    assert locked.json()["error"]["code"] == "locked"
    # Attempts while locked are not counted.
    assert db.scalar(select(LoginAttempt).where(LoginAttempt.ok.is_(True))) is None

    # 15 minutes after the fifth failure the lock is gone.
    db.execute(update(LoginAttempt).values(at=LoginAttempt.at - timedelta(minutes=15, seconds=1)))
    db.commit()
    assert login(client, user.email) == 200


def test_lock_applies_per_email_and_ip(
    app_factory: Callable[[], TestClient], make_user: UserFactory, db: Session
) -> None:
    user, other = make_user(), make_user()
    client = app_factory()
    for _ in range(5):
        login(client, user.email, "wrong password")

    assert login(client, other.email) == 200
    db.execute(update(LoginAttempt).values(ip="203.0.113.9"))
    db.commit()
    assert login(app_factory(), user.email) == 200


def test_failures_spread_over_more_than_15_minutes_do_not_lock(
    client: TestClient, make_user: UserFactory, db: Session
) -> None:
    user = make_user()
    login(client, user.email, "wrong password")
    db.execute(update(LoginAttempt).values(at=LoginAttempt.at - timedelta(minutes=20)))
    db.commit()
    for _ in range(4):
        login(client, user.email, "wrong password")

    assert login(client, user.email) == 200


def test_a_successful_sign_in_resets_the_count(client: TestClient, make_user: UserFactory) -> None:
    user = make_user()
    for _ in range(4):
        login(client, user.email, "wrong password")
    assert login(client, user.email) == 200
    for _ in range(4):
        login(client, user.email, "wrong password")

    assert login(client, user.email) == 200


# --- forgot and reset ----------------------------------------------------------------------


def test_forgot_answers_the_same_for_unknown_emails(
    client: TestClient, make_user: UserFactory, mailer: FakeMailer
) -> None:
    user = make_user()

    known = client.post("/api/auth/forgot", json={"email": user.email})
    unknown = client.post("/api/auth/forgot", json={"email": "nobody@example.com"})

    assert known.json() == unknown.json() == {"message": "If that email exists, we've sent a link."}
    assert [email.to for email in mailer.outbox] == [user.email]
    assert "/reset#" in mailer.outbox[0].body


def test_forgot_sends_nothing_to_deactivated_people(
    client: TestClient, make_user: UserFactory, mailer: FakeMailer
) -> None:
    user = make_user(active=False)

    client.post("/api/auth/forgot", json={"email": user.email})

    assert mailer.outbox == []


def test_forgot_sends_a_fresh_invite_to_someone_who_never_set_a_password(
    client: TestClient, make_user: UserFactory, mailer: FakeMailer
) -> None:
    user = make_user(password=None)

    client.post("/api/auth/forgot", json={"email": user.email})

    assert "/invite#" in mailer.outbox[0].body


def test_reset_sets_the_password_and_signs_out_everywhere(
    app_factory: Callable[[], TestClient], make_user: UserFactory, mailer: FakeMailer
) -> None:
    user = make_user()
    laptop = app_factory()
    sign_in(laptop, user.email)
    phone = app_factory()
    phone.post("/api/auth/forgot", json={"email": user.email})
    secret = mailer.link("/reset#")

    check = phone.post("/api/auth/check-token", json={"token": secret, "kind": "reset"})
    reset = phone.post("/api/auth/reset", json={"token": secret, "password": NEW_PASSWORD})

    assert check.json() == {"name": user.name, "email": user.email}
    assert reset.status_code == 200
    assert laptop.get("/api/auth/me").status_code == 401
    assert login(phone, user.email) == 401
    assert login(phone, user.email, NEW_PASSWORD) == 200


def test_reset_link_works_once(
    client: TestClient, make_user: UserFactory, mailer: FakeMailer
) -> None:
    user = make_user()
    client.post("/api/auth/forgot", json={"email": user.email})
    secret = mailer.link("/reset#")
    client.post("/api/auth/reset", json={"token": secret, "password": NEW_PASSWORD})

    again = client.post("/api/auth/reset", json={"token": secret, "password": "another passphrase"})

    assert again.status_code == 400
    assert again.json()["error"]["code"] == "invalid_token"


def test_reset_link_expires_after_an_hour(
    client: TestClient, make_user: UserFactory, mailer: FakeMailer, db: Session
) -> None:
    user = make_user()
    client.post("/api/auth/forgot", json={"email": user.email})
    secret = mailer.link("/reset#")
    token = db.scalars(select(AuthToken)).one()
    assert timedelta(minutes=59) < token.expires_at - now() <= timedelta(hours=1)
    db.execute(update(AuthToken).values(expires_at=now() - timedelta(seconds=1)))
    db.commit()

    response = client.post("/api/auth/reset", json={"token": secret, "password": NEW_PASSWORD})

    assert response.status_code == 400


def test_a_new_reset_link_cancels_the_old_one(
    client: TestClient, make_user: UserFactory, mailer: FakeMailer
) -> None:
    user = make_user()
    client.post("/api/auth/forgot", json={"email": user.email})
    first = mailer.link("/reset#")
    client.post("/api/auth/forgot", json={"email": user.email})
    second = mailer.link("/reset#")

    assert (
        client.post("/api/auth/reset", json={"token": first, "password": NEW_PASSWORD}).status_code
        == 400
    )
    assert (
        client.post("/api/auth/reset", json={"token": second, "password": NEW_PASSWORD}).status_code
        == 200
    )


def test_weak_password_is_refused_and_the_link_still_works(
    client: TestClient, make_user: UserFactory, mailer: FakeMailer
) -> None:
    user = make_user()
    client.post("/api/auth/forgot", json={"email": user.email})
    secret = mailer.link("/reset#")

    weak = client.post("/api/auth/reset", json={"token": secret, "password": "password123"})
    strong = client.post("/api/auth/reset", json={"token": secret, "password": NEW_PASSWORD})

    assert weak.status_code == 422
    assert weak.json()["error"]["fields"] == {
        "password": "That password is too common. Choose something harder to guess."
    }
    assert strong.status_code == 200


def test_unknown_token_is_refused(client: TestClient) -> None:
    response = client.post("/api/auth/check-token", json={"token": "x" * 43, "kind": "invite"})

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_token"


# --- accepting an invite ------------------------------------------------------------------


def _invite(client: TestClient, make_user: UserFactory, mailer: FakeMailer, **person: str) -> str:
    owner = make_user(Role.OWNER)
    sign_in(client, owner.email)
    client.post(
        "/api/users/invite",
        json={"name": "Nadia", "email": "nadia@example.com", "role": "user", **person},
    )
    client.post("/api/auth/logout")
    client.cookies.clear()
    client.headers.pop("X-CSRF-Token")
    return mailer.link("/invite#")


def test_accepting_an_invite_sets_the_password_and_signs_in(
    client: TestClient, make_user: UserFactory, mailer: FakeMailer
) -> None:
    secret = _invite(client, make_user, mailer)

    info = client.post("/api/auth/check-token", json={"token": secret, "kind": "invite"})
    accepted = client.post(
        "/api/auth/accept-invite", json={"token": secret, "password": NEW_PASSWORD}
    )

    assert info.json() == {"name": "Nadia", "email": "nadia@example.com"}
    assert accepted.status_code == 200
    assert accepted.json()["user"]["invited"] is False
    assert client.get("/api/auth/me").json()["user"]["email"] == "nadia@example.com"
    again = client.post("/api/auth/accept-invite", json={"token": secret, "password": NEW_PASSWORD})
    assert again.status_code == 400


def test_invite_link_expires_after_72_hours(
    client: TestClient, make_user: UserFactory, mailer: FakeMailer, db: Session
) -> None:
    secret = _invite(client, make_user, mailer)
    token = db.scalars(select(AuthToken)).one()
    assert timedelta(hours=71) < token.expires_at - now() <= timedelta(hours=72)
    db.execute(update(AuthToken).values(expires_at=now() - timedelta(seconds=1)))
    db.commit()

    response = client.post(
        "/api/auth/accept-invite", json={"token": secret, "password": NEW_PASSWORD}
    )

    assert response.status_code == 400


def test_invite_of_a_deactivated_person_no_longer_works(
    client: TestClient, make_user: UserFactory, mailer: FakeMailer, db: Session
) -> None:
    secret = _invite(client, make_user, mailer)
    db.execute(update(User).where(User.email == "nadia@example.com").values(active=False))
    db.commit()

    response = client.post(
        "/api/auth/accept-invite", json={"token": secret, "password": NEW_PASSWORD}
    )

    assert response.status_code == 400


def test_reset_token_cannot_be_used_as_an_invite(
    client: TestClient, make_user: UserFactory, mailer: FakeMailer
) -> None:
    user = make_user()
    client.post("/api/auth/forgot", json={"email": user.email})
    secret = mailer.link("/reset#")

    response = client.post(
        "/api/auth/accept-invite", json={"token": secret, "password": NEW_PASSWORD}
    )

    assert response.status_code == 400
