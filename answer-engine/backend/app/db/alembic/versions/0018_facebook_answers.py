"""Facebook answers: the group's posts and the threads answered from them (step 27).

Revision ID: 0018
Revises: 0017
Create Date: 2026-11-11 12:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

STATUS = postgresql.ENUM("todo", "draft", "approved", "skipped", name="fb_status")


def _stamps() -> list[sa.Column]:  # type: ignore[type-arg]
    return [
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
    ]


def upgrade() -> None:
    op.execute("ALTER TYPE verified_origin ADD VALUE IF NOT EXISTS 'facebook'")
    op.create_table(
        "fb_posts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("row", sa.Integer(), nullable=False, unique=True),
        sa.Column("url", sa.Text(), nullable=False, server_default=""),
        sa.Column("author", sa.Text()),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False, server_default=""),
        sa.Column("note", sa.Text()),
        sa.Column("pinned", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("comments", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("picked", postgresql.JSONB(), nullable=False, server_default="[]"),
        *_stamps(),
    )
    op.create_table(
        "fb_threads",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("key", sa.Text(), nullable=False, unique=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("topic", sa.Text(), nullable=False, server_default=""),
        sa.Column("subtopic", sa.Text(), nullable=False, server_default=""),
        sa.Column("rows", postgresql.ARRAY(sa.Integer()), nullable=False, server_default="{}"),
        sa.Column("noise", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("talk", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("similar", sa.Text()),
        sa.Column("answer_title", sa.Text()),
        sa.Column("answers", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("status", STATUS, nullable=False, server_default="todo"),
        sa.Column("answered_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("answered_at", sa.DateTime(timezone=True)),
        *_stamps(),
    )
    op.create_index("ix_fb_threads_similar", "fb_threads", ["similar"])


def downgrade() -> None:
    op.drop_index("ix_fb_threads_similar", table_name="fb_threads")
    op.drop_table("fb_threads")
    op.drop_table("fb_posts")
    STATUS.drop(op.get_bind(), checkfirst=True)
    op.execute("UPDATE verified_answers SET origin = 'admin' WHERE origin = 'facebook'")
    op.execute("ALTER TYPE verified_origin RENAME TO verified_origin_old")
    op.execute("CREATE TYPE verified_origin AS ENUM ('review', 'admin', 'marketing', 'import')")
    op.execute(
        "ALTER TABLE verified_answers ALTER COLUMN origin TYPE verified_origin "
        "USING origin::text::verified_origin"
    )
    op.execute("DROP TYPE verified_origin_old")
