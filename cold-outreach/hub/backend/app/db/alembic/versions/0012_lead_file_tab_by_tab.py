"""The lead file tab by tab (step 14).

Imports keep every row of the file by tab (`sheet`), and leads keep the file's other
columns under their header (`extra`). Files saved before this show their counts only.

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-28 07:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "imports",
        sa.Column(
            "sheet", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
    )
    op.add_column(
        "leads",
        sa.Column(
            "extra", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
    )


def downgrade() -> None:
    op.drop_column("leads", "extra")
    op.drop_column("imports", "sheet")
