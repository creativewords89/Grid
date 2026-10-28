"""The jobs the Hub knows before any agent connects (SPEC step 24), in the order of PLAN.md
sections 4 and 7, and the standard steps a batch can start from."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Task

# (key, name). An agent's manifest may name a job that isn't here: it is added then.
BUILT_IN: list[tuple[str, str]] = [
    ("gbp-audit", "GBP Audit"),
    ("website-audit", "Website Audit"),
    ("social-audit", "Social Audit"),
    ("opportunity", "Opportunity Finder"),
    ("email-writer", "Email Writer"),
    ("sending", "Sending and Follow-up"),
    ("reply", "Reply"),
]

# The standard steps: (job key, the job keys it needs first in the batch).
STANDARD: list[tuple[str, list[str]]] = [
    ("gbp-audit", []),
    ("website-audit", []),
    ("opportunity", ["gbp-audit", "website-audit"]),
    ("email-writer", ["opportunity"]),
]


def ensure_built_in(db: Session) -> None:
    """Add the built-in jobs that are missing. A job already there keeps its name."""
    have = set(db.scalars(select(Task.key)))
    for key, name in BUILT_IN:
        if key not in have:
            db.add(Task(key=key, name=name))
    db.flush()
