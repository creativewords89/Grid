"""Marketing threads, platforms and communities (build step 13).

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-22 19:38:28.149311
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Trigram similarity finds a Facebook post pasted again under another ID (SPEC 6.10).
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.create_table(
        "platforms",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("slug", sa.String(length=40), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default="true", nullable=False),
        sa.Column(
            "parser",
            sa.Enum("reddit", "facebook", "generic", name="platform_parser"),
            nullable=False,
        ),
        sa.Column("hosts", postgresql.ARRAY(sa.String()), server_default="{}", nullable=False),
        sa.Column("style_prompt", sa.Text(), nullable=False),
        sa.Column("disclosure_line", sa.Text(), nullable=True),
        sa.Column("position", sa.Integer(), nullable=False),
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
        sa.PrimaryKeyConstraint("id", name=op.f("pk_platforms")),
        sa.UniqueConstraint("slug", name=op.f("uq_platforms_slug")),
    )
    op.create_table(
        "communities",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("platform_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False),
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
            ["platform_id"],
            ["platforms.id"],
            name=op.f("fk_communities_platform_id_platforms"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_communities")),
        sa.UniqueConstraint("platform_id", "name", name="uq_communities_platform_name"),
    )
    op.create_table(
        "threads",
        sa.Column("id", sa.String(length=120), nullable=False),
        sa.Column("platform_id", sa.Uuid(), nullable=False),
        sa.Column("community", sa.String(length=200), nullable=True),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("original_url", sa.Text(), nullable=False),
        sa.Column(
            "status",
            sa.Enum(
                "waiting_for_us",
                "in_review",
                "ready_to_post",
                "waiting_for_them",
                "closed",
                name="thread_status",
            ),
            nullable=False,
        ),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column(
            "last_activity_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "close_reason", sa.Enum("manual", "inactive", name="close_reason"), nullable=True
        ),
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
            ["created_by"],
            ["users.id"],
            name=op.f("fk_threads_created_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["platform_id"], ["platforms.id"], name=op.f("fk_threads_platform_id_platforms")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_threads")),
    )
    op.create_index(
        "ix_threads_status_activity", "threads", ["status", "last_activity_at"], unique=False
    )
    op.create_table(
        "thread_messages",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("thread_id", sa.String(length=120), nullable=False),
        sa.Column("parent_id", sa.Uuid(), nullable=True),
        sa.Column("author", sa.Enum("them", "us", name="message_author"), nullable=False),
        sa.Column("author_name", sa.String(length=120), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("external_url", sa.Text(), nullable=True),
        sa.Column("external_comment_id", sa.String(length=120), nullable=True),
        sa.Column("answer_id", sa.Uuid(), nullable=True),
        sa.Column(
            "state",
            sa.Enum("draft", "in_review", "ready", "posted", "discarded", name="draft_state"),
            nullable=True,
        ),
        sa.Column("posted_by", sa.Uuid(), nullable=True),
        sa.Column("posted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
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
            ["answer_id"],
            ["answers.id"],
            name=op.f("fk_thread_messages_answer_id_answers"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
            name=op.f("fk_thread_messages_created_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["parent_id"],
            ["thread_messages.id"],
            name=op.f("fk_thread_messages_parent_id_thread_messages"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["posted_by"],
            ["users.id"],
            name=op.f("fk_thread_messages_posted_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["thread_id"],
            ["threads.id"],
            name=op.f("fk_thread_messages_thread_id_threads"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_thread_messages")),
    )
    op.create_index("ix_thread_messages_answer", "thread_messages", ["answer_id"], unique=False)
    op.create_index(
        "ix_thread_messages_thread", "thread_messages", ["thread_id", "created_at"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_thread_messages_thread", table_name="thread_messages")
    op.drop_index("ix_thread_messages_answer", table_name="thread_messages")
    op.drop_table("thread_messages")
    op.drop_index("ix_threads_status_activity", table_name="threads")
    op.drop_table("threads")
    op.drop_table("communities")
    op.drop_table("platforms")
    for enum_name in (
        "draft_state",
        "message_author",
        "close_reason",
        "thread_status",
        "platform_parser",
    ):
        sa.Enum(name=enum_name).drop(op.get_bind(), checkfirst=True)
