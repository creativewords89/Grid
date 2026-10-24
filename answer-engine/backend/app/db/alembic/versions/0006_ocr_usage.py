"""OCR progress and usage_daily (build step 6).

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-08 16:59:29.388260
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "usage_daily",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column(
            "kind", sa.Enum("answer", "check", "ocr", "draft", name="usage_kind"), nullable=False
        ),
        sa.Column("requests", sa.Integer(), nullable=False),
        sa.Column("tokens_in", sa.BigInteger(), nullable=False),
        sa.Column("tokens_out", sa.BigInteger(), nullable=False),
        sa.Column("cost_usd", sa.Numeric(precision=12, scale=6, asdecimal=False), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_usage_daily_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_usage_daily")),
        sa.UniqueConstraint(
            "date", "user_id", "kind", name="uq_usage_daily_day", postgresql_nulls_not_distinct=True
        ),
    )
    op.add_column("files", sa.Column("progress_done", sa.Integer(), nullable=True))
    op.add_column("files", sa.Column("progress_total", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("files", "progress_total")
    op.drop_column("files", "progress_done")
    op.drop_table("usage_daily")
    sa.Enum(name="usage_kind").drop(op.get_bind(), checkfirst=True)
