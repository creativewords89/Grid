"""Leads kept in the Hub, no Google Sheet or Drive (step 11).

Each lead's row from the lead files and the agents' results are stored with it; files the
agents save (reports) are listed in `lead_files`. The Google connection's saved values and
last test are removed. Rows already written to a Master Sheet are not read back: they come
back when their files are added again.

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-28 02:38:44.062829
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "lead_files",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("lead_id", sa.String(length=12), nullable=False),
        sa.Column("agent_key", sa.String(length=40), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("content_type", sa.String(length=80), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["lead_id"],
            ["leads.lead_id"],
            name=op.f("fk_lead_files_lead_id_leads"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_lead_files")),
    )
    op.create_index(
        "uq_lead_files_lead_agent_name", "lead_files", ["lead_id", "agent_key", "name"], unique=True
    )
    op.add_column(
        "leads",
        sa.Column(
            "data", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
    )
    op.add_column(
        "leads",
        sa.Column(
            "results", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
    )
    op.execute(
        "UPDATE settings SET value = value - 'google_service_account' - 'google_sheet_url' "
        "- 'google_drive_folder_url' WHERE key = 'connections' AND jsonb_typeof(value) = 'object'"
    )
    op.execute(
        "UPDATE settings SET value = value - 'google' "
        "WHERE key = 'connection_tests' AND jsonb_typeof(value) = 'object'"
    )


def downgrade() -> None:
    op.drop_column("leads", "results")
    op.drop_column("leads", "data")
    op.drop_index("uq_lead_files_lead_agent_name", table_name="lead_files")
    op.drop_table("lead_files")
