"""files.sheet_count (build step 5).

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-08 15:33:13.263118
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("files", sa.Column("sheet_count", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("files", "sheet_count")
