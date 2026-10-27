"""GBP benchmarks and Website Standards (step 7).

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-27 14:13:15.985842
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "gbp_benchmarks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("city", sa.String(length=120), nullable=False),
        sa.Column("niche", sa.String(length=80), nullable=False),
        sa.Column("additional_categories", sa.Numeric(precision=10, scale=2), nullable=True),
        sa.Column("services", sa.Numeric(precision=10, scale=2), nullable=True),
        sa.Column("photos", sa.Numeric(precision=10, scale=2), nullable=True),
        sa.Column("posts_90_days", sa.Numeric(precision=10, scale=2), nullable=True),
        sa.Column("description_length", sa.Numeric(precision=10, scale=2), nullable=True),
        sa.Column("reviews", sa.Numeric(precision=10, scale=2), nullable=True),
        sa.Column("rating", sa.Numeric(precision=4, scale=2), nullable=True),
        sa.Column("review_reply_pct", sa.Numeric(precision=5, scale=2), nullable=True),
        sa.Column(
            "reference_businesses", sa.String(length=1000), server_default="", nullable=False
        ),
        sa.Column("updated_by", sa.Uuid(), nullable=True),
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
            ["updated_by"],
            ["users.id"],
            name=op.f("fk_gbp_benchmarks_updated_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_gbp_benchmarks")),
    )
    op.create_index(
        "uq_gbp_benchmarks_city_niche", "gbp_benchmarks", ["city", "niche"], unique=True
    )
    op.create_table(
        "website_standards",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("niche", sa.String(length=80), nullable=False),
        sa.Column("version", sa.Integer(), nullable=True),
        sa.Column("standard", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("edited_by", sa.Uuid(), nullable=True),
        sa.Column(
            "edited_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("locked_by", sa.Uuid(), nullable=True),
        sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["edited_by"],
            ["users.id"],
            name=op.f("fk_website_standards_edited_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["locked_by"],
            ["users.id"],
            name=op.f("fk_website_standards_locked_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_website_standards")),
    )
    op.create_index(
        "uq_website_standards_niche_version", "website_standards", ["niche", "version"], unique=True
    )
    op.create_index(
        "uq_website_standards_one_draft",
        "website_standards",
        ["niche"],
        unique=True,
        postgresql_where=sa.text("version IS NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_website_standards_one_draft",
        table_name="website_standards",
        postgresql_where=sa.text("version IS NULL"),
    )
    op.drop_index("uq_website_standards_niche_version", table_name="website_standards")
    op.drop_table("website_standards")
    op.drop_index("uq_gbp_benchmarks_city_niche", table_name="gbp_benchmarks")
    op.drop_table("gbp_benchmarks")
