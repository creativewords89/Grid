"""Every permission rule of SPEC section 3, in one place.

Every endpoint calls `can(user, action, obj)` (or `ensure`, which raises a 403). Rules that
depend on who owns something take an object with `owner_ids`: the ids of the people the
row counts as "theirs" (uploader, asker, thread creator or poster).
"""

import enum
import uuid
from collections.abc import Collection
from typing import Protocol

from app.db.models import Role, User


class Owned(Protocol):
    @property
    def owner_ids(self) -> Collection[uuid.UUID]: ...


class Action(enum.StrEnum):
    ASK = "ask"  # ask questions, see own conversations
    VIEW_OTHERS_CONVERSATIONS = "view_others_conversations"
    GIVE_FEEDBACK = "give_feedback"  # 👍 / 👎 on an answer they received (obj required)
    UPLOAD_FILE = "upload_file"  # incl. a new version
    DELETE_FILE = "delete_file"  # obj required
    MANAGE_TRASH = "manage_trash"  # restore / delete forever
    DOWNLOAD_FILE = "download_file"
    DECIDE_REVIEW = "decide_review"  # approve / edit / reject / needs more info
    ANSWER_NEEDS_INFO = "answer_needs_info"  # obj required (the asker's answer)
    VIEW_ANSWER_LOG = "view_answer_log"
    ADMIN_REVIEW = "admin_review"  # review any answer from the Answer Log
    VIEW_VERIFIED = "view_verified"
    MANAGE_VERIFIED = "manage_verified"  # edit / disable / expiry / delete
    WORK_THREADS = "work_threads"  # create, add replies, draft, mark as posted
    CLOSE_THREAD = "close_thread"  # close / reopen, obj required
    DELETE_THREAD = "delete_thread"
    MANAGE_USERS = "manage_users"
    MANAGE_SETTINGS = "manage_settings"
    MANAGE_KB = "manage_kb"  # rebuild the index, see sync status
    VIEW_USAGE = "view_usage"
    EDIT_OWN_PROFILE = "edit_own_profile"


_ALL = frozenset(Role)
_STAFF = frozenset({Role.OWNER, Role.REVIEWER})
_OWNER = frozenset({Role.OWNER})

# Roles allowed on any object. Roles left out may still act on their own objects when the
# action is listed in _OWN_ONLY.
_ANY: dict[Action, frozenset[Role]] = {
    Action.ASK: _ALL,
    Action.VIEW_OTHERS_CONVERSATIONS: _OWNER,
    Action.GIVE_FEEDBACK: frozenset(),
    Action.UPLOAD_FILE: _ALL,
    Action.DELETE_FILE: _STAFF,
    Action.MANAGE_TRASH: _OWNER,
    Action.DOWNLOAD_FILE: _ALL,
    Action.DECIDE_REVIEW: _STAFF,
    Action.ANSWER_NEEDS_INFO: _STAFF,
    Action.VIEW_ANSWER_LOG: _STAFF,
    Action.ADMIN_REVIEW: _OWNER,
    Action.VIEW_VERIFIED: _ALL,
    Action.MANAGE_VERIFIED: _STAFF,
    Action.WORK_THREADS: _ALL,
    Action.CLOSE_THREAD: _STAFF,
    Action.DELETE_THREAD: _OWNER,
    Action.MANAGE_USERS: _OWNER,
    Action.MANAGE_SETTINGS: _OWNER,
    Action.MANAGE_KB: _OWNER,
    Action.VIEW_USAGE: _OWNER,
    Action.EDIT_OWN_PROFILE: _ALL,
}

# Roles allowed only on objects they own.
_OWN_ONLY: dict[Action, frozenset[Role]] = {
    Action.GIVE_FEEDBACK: _ALL,
    Action.DELETE_FILE: frozenset({Role.USER}),
    Action.ANSWER_NEEDS_INFO: frozenset({Role.USER}),
    Action.CLOSE_THREAD: frozenset({Role.USER}),
}


def can(user: User | None, action: Action, obj: Owned | None = None) -> bool:
    if user is None or not user.active or user.invited:
        return False
    if user.role in _ANY[action]:
        return True
    if user.role in _OWN_ONLY.get(action, frozenset()):
        return obj is not None and user.id in obj.owner_ids
    return False


class Forbidden(Exception):
    def __init__(self, action: Action) -> None:
        super().__init__(f"not allowed: {action}")
        self.action = action


def ensure(user: User | None, action: Action, obj: Owned | None = None) -> None:
    if not can(user, action, obj):
        raise Forbidden(action)
