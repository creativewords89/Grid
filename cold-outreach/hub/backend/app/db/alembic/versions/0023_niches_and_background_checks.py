"""Niches, and files checked in the background (step 33).

`niches`: the niches files, batches and benchmarks are for, started from those already
used. Files handed in are checked by the scheduler's file checker, with their progress
(`state`, `progress`, `error`, `claimed_at`), and keep each business for the Files table
(`leads`). Files handed in before are checked again, to fill it.

Revision ID: 0023
Revises: 0022
Create Date: 2026-10-30 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0023"
down_revision: str | None = "0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "niches",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
            name=op.f("fk_niches_created_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_niches")),
    )
    op.create_index("uq_niches_name", "niches", [sa.literal_column("lower(name)")], unique=True)
    op.execute(
        """
        INSERT INTO niches (id, name)
        SELECT gen_random_uuid(), MIN(name) FROM (
            SELECT trim(niche) AS name FROM benchmarks
            UNION ALL SELECT trim(niche) FROM batches
            UNION ALL SELECT trim(niche) FROM submissions
        ) used
        WHERE name <> ''
        GROUP BY lower(name)
        """
    )
    op.add_column(
        "submissions",
        sa.Column("state", sa.String(length=20), server_default="checked", nullable=False),
    )
    op.add_column(
        "submissions", sa.Column("progress", sa.Integer(), server_default="100", nullable=False)
    )
    op.add_column("submissions", sa.Column("error", sa.String(length=500), nullable=True))
    op.add_column("submissions", sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "submissions",
        sa.Column(
            "leads", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False
        ),
    )
    op.execute("UPDATE submissions SET state = 'checking', progress = 0")


def downgrade() -> None:
    op.drop_column("submissions", "leads")
    op.drop_column("submissions", "claimed_at")
    op.drop_column("submissions", "error")
    op.drop_column("submissions", "progress")
    op.drop_column("submissions", "state")
    op.drop_index("uq_niches_name", table_name="niches")
    op.drop_table("niches")
