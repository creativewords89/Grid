"""File IDs (step 35).

Each file handed in on Files has a number, and each of its businesses a File ID
(F<number>-0001…) that it keeps through fixes, like a Lead ID. Files handed in before are
numbered in the order they came and checked again, to give their businesses their IDs.

Revision ID: 0024
Revises: 0023
Create Date: 2026-10-30 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0024"
down_revision: str | None = "0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("submissions", sa.Column("number", sa.Integer(), nullable=True))
    op.execute(
        """
        UPDATE submissions SET number = numbered.n
        FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM submissions)
            AS numbered
        WHERE submissions.id = numbered.id
        """
    )
    op.alter_column("submissions", "number", nullable=False)
    op.create_unique_constraint(op.f("uq_submissions_number"), "submissions", ["number"])
    op.execute("UPDATE submissions SET state = 'checking', progress = 0, claimed_at = NULL")


def downgrade() -> None:
    op.drop_constraint(op.f("uq_submissions_number"), "submissions", type_="unique")
    op.drop_column("submissions", "number")
