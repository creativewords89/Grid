"""API keys for scripts and assistants (SPEC section 4, step 28)."""

import json
from collections.abc import Callable
from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.tokens import hash_secret, now
from app.db.models import ApiKey, AuditEntry, Role, User
from tests.conftest import UserFactory, sign_in

DATA = {
    "posts": [{"row": 1, "question": "Should I hide my address?", "comments": [], "picked": []}],
    "threads": [{"key": "s1", "title": "Should I hide my address?", "rows": [1]}],
}


@pytest.fixture
def owner(make_user: UserFactory) -> User:
    return make_user(Role.OWNER, name="Olivia")


@pytest.fixture
def boss(app_factory: Callable[[], TestClient], owner: User) -> TestClient:
    c = app_factory()
    sign_in(c, owner.email)
    return c


@pytest.fixture
def bare(app_factory: Callable[[], TestClient]) -> TestClient:
    """A client with no session cookie: only the key signs it in."""
    return app_factory()


def make_key(boss: TestClient, scopes: list[str] | None = None, **extra: Any) -> Any:
    body = {"name": "Claude data sync", "scopes": scopes or ["question_bank"], **extra}
    return boss.post("/api/api-keys", json=body)


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def load(client: TestClient, token: str) -> Any:
    """Upload DATA to the first question set, making one if there is none."""
    sets = client.get("/api/qb/sets", headers=bearer(token))
    if sets.status_code != 200:
        return sets
    items = sets.json()["items"]
    sid = (
        items[0]["id"]
        if items
        else client.post("/api/qb/sets", json={"name": "Data"}, headers=bearer(token)).json()["id"]
    )
    raw = json.dumps(DATA).encode()
    return client.post(
        f"/api/qb/sets/{sid}/load", files={"file": ("data.json", raw)}, headers=bearer(token)
    )


# --- creating keys ----------------------------------------------------------------------------


def test_a_key_is_shown_once_and_stored_hashed(boss: TestClient, db: Session) -> None:
    response = make_key(boss, ["verified_import", "question_bank"], expires_days=30)

    assert response.status_code == 201
    body = response.json()
    token = body["token"]
    assert token.startswith("ae_") and len(token) > 40
    assert body["key"]["prefix"] == token[:8]
    assert body["key"]["scopes"] == ["question_bank", "verified_import"]
    assert body["key"]["made_by"]["name"] == "Olivia"
    stored = db.scalars(select(ApiKey)).one()
    assert stored.token_hash == hash_secret(token) and token not in stored.token_hash
    assert stored.expires_at is not None
    assert timedelta(days=29) < stored.expires_at - now() <= timedelta(days=30)
    listed = boss.get("/api/api-keys").json()
    assert "token" not in json.dumps(listed["items"])
    assert set(listed["scopes"]) == {"question_bank", "verified_import"}
    assert (
        db.scalars(select(AuditEntry).where(AuditEntry.entity == "api_key")).one().action
        == "create"
    )


@pytest.mark.parametrize(
    "body",
    [
        {"name": " ", "scopes": ["question_bank"]},
        {"name": "x", "scopes": []},
        {"name": "x", "scopes": ["users"]},
        {"name": "x", "scopes": ["facebook"]},
        {"name": "x", "scopes": ["question_bank"], "expires_days": 7},
    ],
)
def test_keys_that_cant_be_made(boss: TestClient, db: Session, body: dict[str, Any]) -> None:
    assert boss.post("/api/api-keys", json=body).status_code == 422
    assert db.scalars(select(ApiKey)).all() == []


def test_a_key_that_never_expires(boss: TestClient, db: Session) -> None:
    make_key(boss, expires_days=None)

    assert db.scalars(select(ApiKey)).one().expires_at is None


@pytest.mark.parametrize("role", [Role.REVIEWER, Role.USER])
def test_only_owners_manage_keys(
    app_factory: Callable[[], TestClient], make_user: UserFactory, boss: TestClient, role: Role
) -> None:
    key_id = make_key(boss).json()["key"]["id"]
    c = app_factory()
    sign_in(c, make_user(role).email)

    assert c.get("/api/api-keys").status_code == 403
    body = {"name": "x", "scopes": ["question_bank"]}
    assert c.post("/api/api-keys", json=body).status_code == 403
    assert c.delete(f"/api/api-keys/{key_id}").status_code == 403


# --- using a key ------------------------------------------------------------------------------


def test_a_key_reaches_only_its_scopes_and_needs_no_csrf(
    boss: TestClient, bare: TestClient
) -> None:
    token = make_key(boss).json()["token"]

    assert load(bare, token).json() == {"posts": 1, "threads": 1, "answers": 0, "skipped": []}
    assert bare.get("/api/qb/sets", headers=bearer(token)).status_code == 200
    # Outside its scopes: refused, even though its Owner could do it.
    assert bare.get("/api/verified", headers=bearer(token)).status_code == 403
    assert bare.get("/api/users", headers=bearer(token)).status_code == 403
    assert bare.get("/api/settings", headers=bearer(token)).status_code == 403
    imported = bare.post(
        "/api/verified/import",
        files={"file": ("a.csv", b"question,answer\nQ?,A.\n")},
        headers=bearer(token),
    )
    assert imported.status_code == 403
    assert imported.json()["error"]["code"] == "scope"
    # A key can't manage keys or reach the person's own account.
    assert bare.get("/api/api-keys", headers=bearer(token)).status_code == 401
    assert bare.get("/api/auth/me", headers=bearer(token)).status_code == 401


def test_the_import_scope(boss: TestClient, bare: TestClient) -> None:
    token = make_key(boss, ["verified_import"]).json()["token"]

    imported = bare.post(
        "/api/verified/import",
        files={"file": ("a.csv", b"question,answer\nQ?,A.\n")},
        headers=bearer(token),
    )

    assert imported.status_code == 200 and imported.json()["created"] == 1
    assert bare.get("/api/qb/sets", headers=bearer(token)).status_code == 403


def test_cookies_still_need_the_csrf_token(boss: TestClient) -> None:
    no_csrf = boss.post("/api/qb/sets", json={"name": "x"}, headers={"X-CSRF-Token": "wrong"})

    assert no_csrf.status_code == 403


def test_revoked_keys_stop_working(boss: TestClient, bare: TestClient, db: Session) -> None:
    created = make_key(boss).json()

    assert boss.delete(f"/api/api-keys/{created['key']['id']}").status_code == 204

    assert load(bare, created["token"]).status_code == 401
    assert boss.get("/api/api-keys").json()["items"][0]["revoked_at"] is not None
    actions = {
        a.action for a in db.scalars(select(AuditEntry).where(AuditEntry.entity == "api_key"))
    }
    assert actions == {"create", "revoke"}


@pytest.mark.parametrize("change", ["expired", "deactivated", "demoted", "unknown"])
def test_keys_that_dont_work(
    boss: TestClient, bare: TestClient, db: Session, owner: User, change: str
) -> None:
    token = make_key(boss).json()["token"]
    key = db.scalars(select(ApiKey)).one()
    if change == "expired":
        key.expires_at = now() - timedelta(seconds=1)
    elif change == "deactivated":
        owner.active = False
    elif change == "demoted":
        owner.role = Role.REVIEWER
    else:
        token = token[:-4] + "zzzz"
    db.commit()

    response = load(bare, token)

    assert response.status_code == 401
    assert "isn't valid" in response.json()["error"]["message"]


def test_last_used_is_written_at_most_once_a_minute(
    boss: TestClient, bare: TestClient, db: Session
) -> None:
    token = make_key(boss).json()["token"]

    bare.get("/api/qb/sets", headers=bearer(token))
    db.expire_all()
    key = db.scalars(select(ApiKey)).one()
    first = key.last_used_at
    assert first is not None and key.last_used_ip

    bare.get("/api/qb/sets", headers=bearer(token))
    db.expire_all()
    assert db.scalars(select(ApiKey)).one().last_used_at == first


def test_actions_with_a_key_are_the_owners(
    boss: TestClient, bare: TestClient, db: Session, owner: User
) -> None:
    token = make_key(boss).json()["token"]
    load(bare, token)
    sid = bare.get("/api/qb/sets", headers=bearer(token)).json()["items"][0]["id"]
    page = bare.get(f"/api/qb/sets/{sid}/threads", headers=bearer(token)).json()
    tid = page["items"][0]["id"]

    saved = bare.put(
        f"/api/qb/threads/{tid}/answer",
        json={"items": [{"text": "Hide it if nobody visits."}], "status": "approved"},
        headers=bearer(token),
    )

    assert saved.json()["answer"]["answered_by"]["name"] == "Olivia"
    entry = db.scalars(select(AuditEntry).where(AuditEntry.entity == "fb_thread")).one()
    assert entry.actor_id == owner.id
