"""Every row of SPEC section 3, for every role. The table below is written from the spec,
not from the code."""

import uuid

import pytest

from app.db.models import Role, User
from app.permissions import Action, Forbidden, can, ensure

Y, N = True, False

# (Owner, Admin, Viewer) for each row of the SPEC section 3 table.
SPEC_TABLE: dict[Action, tuple[bool, bool, bool]] = {
    # See Overview, Runs, Agents, Batches, Benchmarks, Leads; download leads as Excel
    Action.VIEW_HUB: (Y, Y, Y),
    # Make, rename or delete a batch; upload and confirm its files
    Action.IMPORT_LEADS: (Y, Y, N),
    # Choose a batch's tasks and bots, start or pause it, change the batches' running order
    Action.RUN_BATCHES: (Y, Y, N),
    # Make, change or delete a task
    Action.EDIT_TASKS: (Y, Y, N),
    # Change a lead's email, phone, website, Top mark or notes; delete a lead
    Action.EDIT_LEADS: (Y, Y, N),
    # Switch an agent on/off, press Run now or Stop
    Action.OPERATE_AGENTS: (Y, Y, N),
    # Change an agent's limit, run time, budget and settings
    Action.CONFIGURE_AGENTS: (Y, Y, N),
    # Make, change or delete a benchmark
    Action.EDIT_BENCHMARKS: (Y, Y, N),
    # See or change Connections (keys, accounts)
    Action.MANAGE_CONNECTIONS: (Y, N, N),
    # Change the total daily budget
    Action.MANAGE_TOTAL_BUDGET: (Y, N, N),
    # Add an agent, show or replace an agent's token
    Action.MANAGE_AGENT_TOKENS: (Y, N, N),
    # Manage users (invite, deactivate, change role)
    Action.MANAGE_USERS: (Y, N, N),
    # See the History (audit log)
    Action.VIEW_HISTORY: (Y, N, N),
    # Own profile, password, alert channels
    Action.EDIT_OWN_PROFILE: (Y, Y, Y),
}
ROLES = (Role.OWNER, Role.ADMIN, Role.VIEWER)


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
    (action, role, allowed)
    for action, rules in SPEC_TABLE.items()
    for role, allowed in zip(ROLES, rules, strict=True)
]


@pytest.mark.parametrize(("action", "role", "allowed"), CASES)
def test_spec_row(action: Action, role: Role, allowed: bool) -> None:
    assert can(person(role), action) is allowed


@pytest.mark.parametrize("action", list(Action))
@pytest.mark.parametrize("role", ROLES)
def test_inactive_and_invited_people_can_do_nothing(action: Action, role: Role) -> None:
    assert not can(person(role, active=False), action)
    assert not can(person(role, invited=True), action)


def test_signed_out_can_do_nothing() -> None:
    assert not any(can(None, action) for action in Action)


def test_ensure_raises_forbidden() -> None:
    with pytest.raises(Forbidden):
        ensure(person(Role.ADMIN), Action.MANAGE_USERS)
    ensure(person(Role.OWNER), Action.MANAGE_USERS)
