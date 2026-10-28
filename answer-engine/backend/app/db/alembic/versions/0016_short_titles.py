"""threads.title_auto: short conversation titles written with the first draft.

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-28 12:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "threads",
        sa.Column("title_auto", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    # Long titles copied from the question get a short one with their next draft.
    op.execute("UPDATE threads SET title_auto = true WHERE length(title) > 60")


def downgrade() -> None:
    op.drop_column("threads", "title_auto")
