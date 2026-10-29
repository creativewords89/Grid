"""Every permission rule of SPEC section 3, in one place.

Every endpoint calls `can(user, action)` (or `ensure`, which raises a 403). No Hub rule
depends on who owns a row, so the role alone decides, except on the Files screen: a
Collector sees and changes only the files they handed in (checked in `app/api/submissions`).
A Reviewer has Top Review only (`app/api/review`), and sends ready cities to their batch.
"""

import enum

from app.db.models import Role, User


class Action(enum.StrEnum):
    VIEW_HUB = "view_hub"  # Overview, Runs, Agents, Batches, Benchmarks, Leads and export
    IMPORT_LEADS = "import_leads"  # make batches, upload and confirm files
    RUN_BATCHES = "run_batches"  # a batch's tasks and bots, Start/Pause, running order
    EDIT_LEADS = "edit_leads"  # change a lead's email, phone, website, Top, notes; delete it
    OPERATE_AGENTS = "operate_agents"  # switch on/off, Run now, Stop
    CONFIGURE_AGENTS = "configure_agents"  # limit, run time, budget and settings
    EDIT_BENCHMARKS = "edit_benchmarks"  # make, change and delete benchmarks
    MANAGE_CONNECTIONS = "manage_connections"  # see or change keys and accounts
    MANAGE_TOTAL_BUDGET = "manage_total_budget"
    MANAGE_AGENT_TOKENS = "manage_agent_tokens"  # add an agent, show or replace its token
    MANAGE_USERS = "manage_users"
    VIEW_HISTORY = "view_history"
    EDIT_OWN_PROFILE = "edit_own_profile"  # own profile, password, alert channels
    # The Files screen (step 31): hand in a lead file, see its problems, upload a revision.
    SUBMIT_FILES = "submit_files"
    VIEW_ALL_FILES = "view_all_files"  # every file handed in, not just one's own
    # Delete a file sent on to Top Review; unmute a muted city of a file (step 39).
    USE_FILES = "use_files"
    # Top Review (step 32): choose each city's Top businesses in a file before it is used.
    REVIEW_TOPS = "review_tops"
    ADD_NICHES = "add_niches"  # add a niche (step 33), when handing in a file
    # Send a file's ready cities to their batch now (step 39); a Collector, their own file's.
    SEND_TO_BATCH = "send_to_batch"
    MANAGE_NICHES = "manage_niches"  # rename or delete a niche


_ALL = frozenset(Role)
# Everyone but the outside teams (Collectors and Reviewers).
_TEAM = frozenset({Role.OWNER, Role.ADMIN, Role.VIEWER})
_STAFF = frozenset({Role.OWNER, Role.ADMIN})
_OWNER = frozenset({Role.OWNER})

_ALLOWED: dict[Action, frozenset[Role]] = {
    Action.VIEW_HUB: _TEAM,
    Action.IMPORT_LEADS: _STAFF,
    Action.RUN_BATCHES: _STAFF,
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
    Action.SUBMIT_FILES: frozenset({Role.OWNER, Role.ADMIN, Role.COLLECTOR}),
    Action.VIEW_ALL_FILES: _TEAM,
    Action.USE_FILES: _STAFF,
    Action.REVIEW_TOPS: frozenset({Role.OWNER, Role.ADMIN, Role.REVIEWER}),
    Action.ADD_NICHES: frozenset({Role.OWNER, Role.ADMIN, Role.COLLECTOR}),
    Action.SEND_TO_BATCH: frozenset({Role.OWNER, Role.ADMIN, Role.COLLECTOR, Role.REVIEWER}),
    Action.MANAGE_NICHES: _STAFF,
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
