"""Brand voice: examples and each platform's style guide and writing rules (build step 24).

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-28 10:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

EMOJIS = postgresql.ENUM("none", "one", "any", name="voice_emojis", create_type=False)
LINKS = postgresql.ENUM("never", "when_asked", "allowed", name="voice_links", create_type=False)


def upgrade() -> None:
    op.create_table(
        "voice_examples",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("platform_id", sa.Uuid(), nullable=False),
        sa.Column("source", sa.Enum("file", "posted", name="voice_source"), nullable=False),
        sa.Column(
            "state",
            sa.Enum("suggested", "active", "dismissed", name="voice_state"),
            nullable=False,
        ),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("answer", sa.Text(), nullable=False),
        sa.Column("community", sa.String(length=200), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("enabled", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("starred", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("corrected", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("thread_message_id", sa.Uuid(), nullable=True),
        sa.Column("used_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("decided_by", sa.Uuid(), nullable=True),
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
            ["created_by"],
            ["users.id"],
            name=op.f("fk_voice_examples_created_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["decided_by"],
            ["users.id"],
            name=op.f("fk_voice_examples_decided_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["platform_id"],
            ["platforms.id"],
            name=op.f("fk_voice_examples_platform_id_platforms"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["thread_message_id"],
            ["thread_messages.id"],
            name=op.f("fk_voice_examples_thread_message_id_thread_messages"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_voice_examples")),
        sa.UniqueConstraint("thread_message_id", name=op.f("uq_voice_examples_thread_message_id")),
    )
    op.create_index("ix_voice_examples_platform_state", "voice_examples", ["platform_id", "state"])

    bind = op.get_bind()
    EMOJIS.create(bind, checkfirst=True)
    LINKS.create(bind, checkfirst=True)
    op.add_column(
        "platforms", sa.Column("voice_guide", sa.Text(), server_default="", nullable=False)
    )
    op.add_column(
        "platforms",
        sa.Column("voice_guide_edited", sa.Boolean(), server_default="false", nullable=False),
    )
    op.add_column(
        "platforms", sa.Column("voice_guide_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("platforms", sa.Column("voice_max_words", sa.Integer(), nullable=True))
    op.add_column(
        "platforms", sa.Column("voice_emojis", EMOJIS, server_default="one", nullable=False)
    )
    op.add_column(
        "platforms", sa.Column("voice_links", LINKS, server_default="when_asked", nullable=False)
    )
    op.add_column(
        "platforms",
        sa.Column(
            "voice_banned",
            postgresql.ARRAY(sa.String(length=100)),
            server_default="{}",
            nullable=False,
        ),
    )
    op.add_column("platforms", sa.Column("voice_file_name", sa.String(length=255), nullable=True))
    op.add_column(
        "platforms", sa.Column("voice_file_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("platforms", sa.Column("voice_file_by", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_platforms_voice_file_by_users"),
        "platforms",
        "users",
        ["voice_file_by"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("fk_platforms_voice_file_by_users"), "platforms", type_="foreignkey")
    for column in (
        "voice_file_by",
        "voice_file_at",
        "voice_file_name",
        "voice_banned",
        "voice_links",
        "voice_emojis",
        "voice_max_words",
        "voice_guide_at",
        "voice_guide_edited",
        "voice_guide",
    ):
        op.drop_column("platforms", column)
    op.drop_index("ix_voice_examples_platform_state", table_name="voice_examples")
    op.drop_table("voice_examples")
    for enum_name in ("voice_source", "voice_state", "voice_emojis", "voice_links"):
        sa.Enum(name=enum_name).drop(op.get_bind(), checkfirst=True)
