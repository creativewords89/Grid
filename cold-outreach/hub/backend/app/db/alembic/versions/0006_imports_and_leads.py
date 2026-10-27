"""Imports and leads: uploaded files, the Lead ID registry, lists, do-not-contact (step 6).

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-27 14:01:14.594304
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "do_not_contact",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=10), nullable=False),
        sa.Column("value", sa.String(length=500), nullable=False),
        sa.Column("reason", sa.String(length=20), nullable=False),
        sa.Column("lead_id", sa.String(length=12), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_do_not_contact")),
    )
    op.create_index("ix_do_not_contact_lead_id", "do_not_contact", ["lead_id"], unique=False)
    op.create_index(
        "uq_do_not_contact_kind_value_reason",
        "do_not_contact",
        ["kind", "value", "reason"],
        unique=True,
    )
    op.create_table(
        "lists",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("city", sa.String(length=120), nullable=False),
        sa.Column("niche", sa.String(length=80), nullable=False),
        sa.Column("active", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("daily_limit", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_lists")),
    )
    op.create_index("uq_lists_city_niche", "lists", ["city", "niche"], unique=True)
    op.create_table(
        "imports",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("file_name", sa.String(length=255), nullable=False),
        sa.Column("niche", sa.String(length=80), nullable=False),
        sa.Column("uploaded_by", sa.Uuid(), nullable=True),
        sa.Column(
            "status",
            sa.Enum("preview", "confirmed", "failed", "discarded", name="import_status"),
            nullable=False,
        ),
        sa.Column(
            "counts", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column(
            "preview", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column(
            "rows", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False
        ),
        sa.Column("error", sa.String(length=500), nullable=True),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["uploaded_by"],
            ["users.id"],
            name=op.f("fk_imports_uploaded_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_imports")),
    )
    op.create_table(
        "leads",
        sa.Column("lead_id", sa.String(length=12), nullable=False),
        sa.Column("niche", sa.String(length=80), nullable=False),
        sa.Column("city", sa.String(length=120), nullable=False),
        sa.Column("business_name", sa.String(length=255), nullable=False),
        sa.Column("level", sa.String(length=20), server_default="", nullable=False),
        sa.Column("gbp_link", sa.String(length=500), server_default="", nullable=False),
        sa.Column("phone_digits", sa.String(length=20), server_default="", nullable=False),
        sa.Column("name_address", sa.String(length=600), server_default="", nullable=False),
        sa.Column("website_domain", sa.String(length=255), server_default="", nullable=False),
        sa.Column(
            "emails", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False
        ),
        sa.Column("first_import_id", sa.Uuid(), nullable=True),
        sa.Column("last_import_id", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["first_import_id"],
            ["imports.id"],
            name=op.f("fk_leads_first_import_id_imports"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["last_import_id"],
            ["imports.id"],
            name=op.f("fk_leads_last_import_id_imports"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("lead_id", name=op.f("pk_leads")),
    )
    op.create_index("ix_leads_gbp_link", "leads", ["gbp_link"], unique=False)
    op.create_index("ix_leads_name_address", "leads", ["name_address"], unique=False)
    op.create_index("ix_leads_niche_city", "leads", ["niche", "city"], unique=False)
    op.create_index("ix_leads_phone_digits", "leads", ["phone_digits"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_leads_phone_digits", table_name="leads")
    op.drop_index("ix_leads_niche_city", table_name="leads")
    op.drop_index("ix_leads_name_address", table_name="leads")
    op.drop_index("ix_leads_gbp_link", table_name="leads")
    op.drop_table("leads")
    op.drop_table("imports")
    op.drop_index("uq_lists_city_niche", table_name="lists")
    op.drop_table("lists")
    op.drop_index("uq_do_not_contact_kind_value_reason", table_name="do_not_contact")
    op.drop_index("ix_do_not_contact_lead_id", table_name="do_not_contact")
    op.drop_table("do_not_contact")
    sa.Enum(name="import_status").drop(op.get_bind(), checkfirst=True)
