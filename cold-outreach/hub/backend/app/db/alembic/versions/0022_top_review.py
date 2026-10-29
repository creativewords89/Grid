"""Top Review (step 32).

A Reviewer chooses each city's Top businesses in a file handed in on Files, after its
errors are fixed and before it is added to a batch: `submissions.tops` (by city) and
`topped_at` (every city that is on has a Top: the file is ready and locked).

Revision ID: 0022
Revises: 0021
Create Date: 2026-10-29 23:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0022"
down_revision: str | None = "0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'reviewer'")
    op.add_column(
        "submissions",
        sa.Column(
            "tops", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
    )
    op.add_column("submissions", sa.Column("topped_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("submissions", "topped_at")
    op.drop_column("submissions", "tops")
    # Postgres can't drop one value of a type: reviewers become viewers and the type is made
    # again without it.
    op.execute("ALTER TABLE users ALTER COLUMN role TYPE text")
    op.execute("UPDATE users SET role = 'viewer' WHERE role = 'reviewer'")
    op.execute("DROP TYPE user_role")
    op.execute("CREATE TYPE user_role AS ENUM ('owner', 'admin', 'viewer', 'collector')")
    op.execute("ALTER TABLE users ALTER COLUMN role TYPE user_role USING role::user_role")
