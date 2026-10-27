"""Run stop requests: who pressed Stop, and when (step 5).

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-27 13:49:04.792435
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("runs", sa.Column("stop_requested_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("runs", sa.Column("stop_requested_by", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_runs_stop_requested_by_users"),
        "runs",
        "users",
        ["stop_requested_by"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("fk_runs_stop_requested_by_users"), "runs", type_="foreignkey")
    op.drop_column("runs", "stop_requested_by")
    op.drop_column("runs", "stop_requested_at")
