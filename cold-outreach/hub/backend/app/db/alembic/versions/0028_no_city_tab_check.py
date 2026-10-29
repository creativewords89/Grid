"""No "City differs from the tab's name" check (after step 39).

A file's city is its City column's, so a tab named otherwise is fine: the files handed in
are checked again without that error.

Revision ID: 0028
Revises: 0027
Create Date: 2026-10-31 12:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0028"
down_revision: str | None = "0027"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("UPDATE submissions SET state = 'checking', progress = 0, claimed_at = NULL")


def downgrade() -> None:
    op.execute("UPDATE submissions SET state = 'checking', progress = 0, claimed_at = NULL")
