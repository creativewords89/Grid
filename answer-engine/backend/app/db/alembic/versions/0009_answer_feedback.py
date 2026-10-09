"""👍 / 👎 feedback on answers (build step 9).

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-09 09:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("answers", sa.Column("feedback", sa.String(length=4), nullable=True))
    op.create_index("ix_answers_outcome", "answers", ["outcome"])


def downgrade() -> None:
    op.drop_index("ix_answers_outcome", table_name="answers")
    op.drop_column("answers", "feedback")
