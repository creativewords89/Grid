"""Question Bank sets: Facebook answers becomes the Question Bank, with many sets (step 29).

Existing posts and threads become the first set, "Facebook group", whose prefix stays `fb`
so the verified answers already approved keep their import keys. API keys with the
`facebook` scope get `question_bank`.

Revision ID: 0020
Revises: 0019
Create Date: 2026-11-11 18:00:00
"""

import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FIRST = "Facebook group"


def upgrade() -> None:
    op.create_table(
        "question_sets",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.Text(), nullable=False, unique=True),
        sa.Column("source", sa.Text(), nullable=False, server_default=""),
        sa.Column("url", sa.Text(), nullable=False, server_default=""),
        sa.Column("prefix", sa.Text(), nullable=False, unique=True),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL")),
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
    )
    for table in ("fb_posts", "fb_threads"):
        op.add_column(
            table,
            sa.Column("set_id", sa.Uuid(), sa.ForeignKey("question_sets.id", ondelete="CASCADE")),
        )
        op.create_index(f"ix_{table}_set_id", table, ["set_id"])

    bind = op.get_bind()
    has_rows = bind.execute(
        sa.text("SELECT EXISTS (SELECT 1 FROM fb_threads) OR EXISTS (SELECT 1 FROM fb_posts)")
    ).scalar()
    if has_rows:
        first = uuid.uuid4()
        bind.execute(
            sa.text(
                "INSERT INTO question_sets (id, name, source, prefix) "
                "VALUES (:id, :name, 'Facebook group', 'fb')"
            ),
            {"id": first, "name": FIRST},
        )
        bind.execute(sa.text("UPDATE fb_posts SET set_id = :id"), {"id": first})
        bind.execute(sa.text("UPDATE fb_threads SET set_id = :id"), {"id": first})

    for table in ("fb_posts", "fb_threads"):
        op.alter_column(table, "set_id", nullable=False)
    op.drop_constraint("uq_fb_posts_row", "fb_posts", type_="unique")
    op.drop_constraint("uq_fb_threads_key", "fb_threads", type_="unique")
    op.create_unique_constraint("uq_fb_posts_set_row", "fb_posts", ["set_id", "row"])
    op.create_unique_constraint("uq_fb_threads_set_key", "fb_threads", ["set_id", "key"])
    op.execute("UPDATE api_keys SET scopes = array_replace(scopes, 'facebook', 'question_bank')")


def downgrade() -> None:
    op.execute("UPDATE api_keys SET scopes = array_replace(scopes, 'question_bank', 'facebook')")
    # Only the first set fits the old one-set tables: the others are removed.
    op.execute(
        "DELETE FROM question_sets WHERE id NOT IN "
        "(SELECT id FROM question_sets WHERE prefix = 'fb')"
    )
    op.drop_constraint("uq_fb_threads_set_key", "fb_threads", type_="unique")
    op.drop_constraint("uq_fb_posts_set_row", "fb_posts", type_="unique")
    op.create_unique_constraint("uq_fb_threads_key", "fb_threads", ["key"])
    op.create_unique_constraint("uq_fb_posts_row", "fb_posts", ["row"])
    for table in ("fb_posts", "fb_threads"):
        op.drop_index(f"ix_{table}_set_id", table_name=table)
        op.drop_column(table, "set_id")
    op.drop_table("question_sets")
