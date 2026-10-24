"""Verified answers and their versions; delivered/seen times on answers (build step 11).

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-09 03:42:03.510880
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "verified_answers",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("answer", sa.Text(), nullable=False),
        sa.Column(
            "status",
            sa.Enum("active", "disabled", "expired", name="verified_status"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "origin",
            sa.Enum("review", "admin", "marketing", name="verified_origin"),
            nullable=False,
        ),
        sa.Column("origin_answer_id", sa.Uuid(), nullable=True),
        sa.Column(
            "source_file_ids", postgresql.ARRAY(sa.Uuid()), server_default="{}", nullable=False
        ),
        sa.Column("needs_check", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("needs_check_reason", sa.Text(), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("approved_by", sa.Uuid(), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
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
            ["approved_by"],
            ["users.id"],
            name=op.f("fk_verified_answers_approved_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
            name=op.f("fk_verified_answers_created_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["origin_answer_id"],
            ["answers.id"],
            name=op.f("fk_verified_answers_origin_answer_id_answers"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_verified_answers")),
    )
    op.create_index(
        "ix_verified_answers_origin_answer", "verified_answers", ["origin_answer_id"], unique=False
    )
    op.create_index(
        "ix_verified_answers_sources",
        "verified_answers",
        ["source_file_ids"],
        unique=False,
        postgresql_using="gin",
    )
    op.create_table(
        "verified_answer_versions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("verified_answer_id", sa.Uuid(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("answer", sa.Text(), nullable=False),
        sa.Column("changed_by", sa.Uuid(), nullable=True),
        sa.Column(
            "at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["changed_by"],
            ["users.id"],
            name=op.f("fk_verified_answer_versions_changed_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["verified_answer_id"],
            ["verified_answers.id"],
            name=op.f("fk_verified_answer_versions_verified_answer_id_verified_answers"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_verified_answer_versions")),
        sa.UniqueConstraint("verified_answer_id", "version", name="uq_verified_versions"),
    )
    op.add_column("answers", sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("answers", sa.Column("seen_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("answers", "seen_at")
    op.drop_column("answers", "delivered_at")
    op.drop_table("verified_answer_versions")
    op.drop_index(
        "ix_verified_answers_sources", table_name="verified_answers", postgresql_using="gin"
    )
    op.drop_index("ix_verified_answers_origin_answer", table_name="verified_answers")
    op.drop_table("verified_answers")
    for enum_name in ("verified_origin", "verified_status"):
        sa.Enum(name=enum_name).drop(op.get_bind(), checkfirst=True)
