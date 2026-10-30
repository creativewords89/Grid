"""Test runs (step 50): an agent tried on a few leads, its report kept in the run.

Revision ID: 0031
Revises: 0030
Create Date: 2026-11-03 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0031"
down_revision: str | None = "0030"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE run_trigger ADD VALUE IF NOT EXISTS 'test'")
    op.add_column("runs", sa.Column("test", postgresql.JSONB(astext_type=sa.Text())))


def downgrade() -> None:
    op.execute("DELETE FROM runs WHERE trigger = 'test'")
    op.drop_column("runs", "test")
