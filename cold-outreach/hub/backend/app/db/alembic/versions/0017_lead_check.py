"""Lead Check (steps 26 and 27).

Each lead keeps what is wrong in its fields (`check`, a list of problems; NULL until it is
checked: leads saved before this are checked the first time their batch is looked at). A
file with a lead whose check has an error holds all of its leads back from the agents.

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-29 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "leads", sa.Column("check", postgresql.JSONB(astext_type=sa.Text()), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("leads", "check")
