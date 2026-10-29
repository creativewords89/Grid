"""Batch names for files (step 38).

Each file handed in is for the batch named after its niche and a number ("Cleaning 01"),
counted per niche (`niches.files`) so a number is never given twice. Files already handed in
are named in the order they came.

Revision ID: 0026
Revises: 0025
Create Date: 2026-10-30 16:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0026"
down_revision: str | None = "0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("niches", sa.Column("files", sa.Integer(), server_default="0", nullable=False))
    op.add_column(
        "submissions",
        sa.Column("batch_name", sa.String(length=120), server_default="", nullable=False),
    )
    op.execute(
        """
        INSERT INTO niches (id, name)
        SELECT gen_random_uuid(), MIN(trim(niche)) FROM submissions
        WHERE lower(trim(niche)) NOT IN (SELECT lower(name) FROM niches)
        GROUP BY lower(trim(niche))
        """
    )
    op.execute(
        """
        UPDATE submissions SET batch_name = numbered.niche || ' ' || lpad(numbered.n::text, 2, '0')
        FROM (
            SELECT id, trim(niche) AS niche,
                row_number() OVER (PARTITION BY lower(trim(niche)) ORDER BY number) AS n
            FROM submissions
        ) AS numbered
        WHERE submissions.id = numbered.id
        """
    )
    op.execute(
        """
        UPDATE niches SET files = counted.n
        FROM (SELECT lower(trim(niche)) AS key, count(*) AS n FROM submissions GROUP BY 1)
            AS counted
        WHERE lower(niches.name) = counted.key
        """
    )


def downgrade() -> None:
    op.drop_column("submissions", "batch_name")
    op.drop_column("niches", "files")
