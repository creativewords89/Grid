"""Alerts: what was raised and sent, and each person's email choice (step 8).

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-27 14:21:40.366630
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "alerts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=40), nullable=False),
        sa.Column("dedupe_key", sa.String(length=200), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("body", sa.String(length=4000), nullable=False),
        sa.Column("audience", sa.String(length=10), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "emailed_to",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
        sa.Column("telegram_sent", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("error", sa.String(length=500), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_alerts")),
    )
    op.create_index(
        "ix_alerts_dedupe_key_created_at", "alerts", ["dedupe_key", "created_at"], unique=False
    )
    op.create_index("ix_alerts_sent_at", "alerts", ["sent_at"], unique=False)
    op.add_column(
        "users", sa.Column("alert_email", sa.Boolean(), server_default="true", nullable=False)
    )


def downgrade() -> None:
    op.drop_column("users", "alert_email")
    op.drop_index("ix_alerts_sent_at", table_name="alerts")
    op.drop_index("ix_alerts_dedupe_key_created_at", table_name="alerts")
    op.drop_table("alerts")
