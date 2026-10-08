"""Every row of SPEC section 3, for every role, on no object, an object of their own and
someone else's object. The table below is written from the spec, not from the code."""

import uuid
from collections.abc import Collection
from dataclasses import dataclass
from typing import Literal

import pytest

from app.db.models import Role, User
from app.permissions import Action, Forbidden, can, ensure

Rule = Literal["any", "own", "no"]

# (Owner, Reviewer, User) for each row of the SPEC section 3 table.
SPEC_TABLE: dict[Action, tuple[Rule, Rule, Rule]] = {
    Action.ASK: ("any", "any", "any"),
    Action.VIEW_OTHERS_CONVERSATIONS: ("any", "no", "no"),
    Action.GIVE_FEEDBACK: ("own", "own", "own"),  # "an answer they received"
    Action.UPLOAD_FILE: ("any", "any", "any"),
    Action.DELETE_FILE: ("any", "any", "own"),
    Action.MANAGE_TRASH: ("any", "no", "no"),
    Action.DOWNLOAD_FILE: ("any", "any", "any"),
    Action.DECIDE_REVIEW: ("any", "any", "no"),
    Action.ANSWER_NEEDS_INFO: ("any", "any", "own"),
    Action.VIEW_ANSWER_LOG: ("any", "any", "no"),
    Action.ADMIN_REVIEW: ("any", "no", "no"),
    Action.VIEW_VERIFIED: ("any", "any", "any"),
    Action.MANAGE_VERIFIED: ("any", "any", "no"),
    Action.WORK_THREADS: ("any", "any", "any"),
    Action.CLOSE_THREAD: ("any", "any", "own"),
    Action.DELETE_THREAD: ("any", "no", "no"),
    Action.MANAGE_USERS: ("any", "no", "no"),
    Action.MANAGE_SETTINGS: ("any", "no", "no"),
    Action.MANAGE_KB: ("any", "no", "no"),
    Action.VIEW_USAGE: ("any", "no", "no"),
    Action.EDIT_OWN_PROFILE: ("any", "any", "any"),
}
ROLES = (Role.OWNER, Role.REVIEWER, Role.USER)


@dataclass
class Thing:
    owner_ids: Collection[uuid.UUID]


def person(role: Role, *, active: bool = True, invited: bool = False) -> User:
    return User(
        id=uuid.uuid4(),
        email="p@example.com",
        name="P",
        role=role,
        active=active,
        password_hash=None if invited else "hash",
    )


def test_every_action_is_in_the_spec_table() -> None:
    assert set(SPEC_TABLE) == set(Action)


CASES = [
    (action, role, rule)
    for action, rules in SPEC_TABLE.items()
    for role, rule in zip(ROLES, rules, strict=True)
]


@pytest.mark.parametrize(("action", "role", "rule"), CASES)
def test_spec_row(action: Action, role: Role, rule: Rule) -> None:
    user = person(role)
    theirs = Thing(owner_ids={user.id})
    someone_elses = Thing(owner_ids={uuid.uuid4()})

    expected = {
        "any": (True, True, True),
        "own": (False, True, False),
        "no": (False, False, False),
    }[rule]
    # Actions about a specific row are only ever called with that row; "any" rules don't
    # depend on it, so checking without an object too keeps the table honest.
    assert (can(user, action), can(user, action, theirs), can(user, action, someone_elses)) == (
        expected
    )


@pytest.mark.parametrize("action", list(Action))
@pytest.mark.parametrize("role", ROLES)
def test_inactive_and_invited_people_can_do_nothing(action: Action, role: Role) -> None:
    for user in (person(role, active=False), person(role, invited=True)):
        assert not can(user, action, Thing(owner_ids={user.id}))


def test_signed_out_can_do_nothing() -> None:
    assert not any(can(None, action) for action in Action)


def test_ensure_raises_forbidden() -> None:
    with pytest.raises(Forbidden):
        ensure(person(Role.USER), Action.MANAGE_USERS)
    ensure(person(Role.OWNER), Action.MANAGE_USERS)
