"""Every permission rule of SPEC section 3, in one place.

Every endpoint calls `can(user, action)` (or `ensure`, which raises a 403). No Hub rule
depends on who owns a row, so the role alone decides.
"""

import enum

from app.db.models import Role, User


class Action(enum.StrEnum):
    VIEW_HUB = "view_hub"  # Overview, Runs, Agents, Batches, Benchmarks, Leads and export
    IMPORT_LEADS = "import_leads"  # make batches, upload and confirm files
    EDIT_LEADS = "edit_leads"  # change a lead's email, phone, website, Top, notes; delete it
    OPERATE_AGENTS = "operate_agents"  # switch on/off, Run now, Stop
    CONFIGURE_AGENTS = "configure_agents"  # batches, limit, run time, budget and settings
    EDIT_BENCHMARKS = "edit_benchmarks"  # make, change and delete benchmarks
    MANAGE_CONNECTIONS = "manage_connections"  # see or change keys and accounts
    MANAGE_TOTAL_BUDGET = "manage_total_budget"
    MANAGE_AGENT_TOKENS = "manage_agent_tokens"  # add an agent, show or replace its token
    MANAGE_USERS = "manage_users"
    VIEW_HISTORY = "view_history"
    EDIT_OWN_PROFILE = "edit_own_profile"  # own profile, password, alert channels


_ALL = frozenset(Role)
_STAFF = frozenset({Role.OWNER, Role.ADMIN})
_OWNER = frozenset({Role.OWNER})

_ALLOWED: dict[Action, frozenset[Role]] = {
    Action.VIEW_HUB: _ALL,
    Action.IMPORT_LEADS: _STAFF,
    Action.EDIT_LEADS: _STAFF,
    Action.OPERATE_AGENTS: _STAFF,
    Action.CONFIGURE_AGENTS: _STAFF,
    Action.EDIT_BENCHMARKS: _STAFF,
    Action.MANAGE_CONNECTIONS: _OWNER,
    Action.MANAGE_TOTAL_BUDGET: _OWNER,
    Action.MANAGE_AGENT_TOKENS: _OWNER,
    Action.MANAGE_USERS: _OWNER,
    Action.VIEW_HISTORY: _OWNER,
    Action.EDIT_OWN_PROFILE: _ALL,
}


def can(user: User | None, action: Action) -> bool:
    if user is None or not user.active or user.invited:
        return False
    return user.role in _ALLOWED[action]


class Forbidden(Exception):
    def __init__(self, action: Action) -> None:
        super().__init__(f"not allowed: {action}")
        self.action = action


def ensure(user: User | None, action: Action) -> None:
    if not can(user, action):
        raise Forbidden(action)
