"""Reviews and the messages between reviewers and askers (build step 10).

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-09 03:18:34.077991
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "reviews",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("number", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("answer_id", sa.Uuid(), nullable=False),
        sa.Column(
            "reason",
            sa.Enum("low_confidence", "no_answer", "admin", "flag", name="review_reason"),
            nullable=False,
        ),
        sa.Column(
            "state",
            sa.Enum(
                "open",
                "claimed",
                "needs_info",
                "approved",
                "edited",
                "rejected",
                "cancelled",
                name="review_state",
            ),
            nullable=False,
        ),
        sa.Column("claimed_by", sa.Uuid(), nullable=True),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("decided_by", sa.Uuid(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("final_text", sa.Text(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("telegram_message_id", sa.BigInteger(), nullable=True),
        sa.Column("prompt_message_id", sa.BigInteger(), nullable=True),
        sa.Column("prompt_action", sa.String(length=20), nullable=True),
        sa.Column("reminded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("escalated_at", sa.DateTime(timezone=True), nullable=True),
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
            name=op.f("fk_reviews_answer_id_answers"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["claimed_by"],
            ["users.id"],
            name=op.f("fk_reviews_claimed_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["decided_by"],
            ["users.id"],
            name=op.f("fk_reviews_decided_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_reviews")),
        sa.UniqueConstraint("number", name=op.f("uq_reviews_number")),
    )
    op.create_index("ix_reviews_answer_id", "reviews", ["answer_id"], unique=False)
    op.create_index("ix_reviews_state_created", "reviews", ["state", "created_at"], unique=False)
    op.create_index(
        "uq_reviews_answer_undecided",
        "reviews",
        ["answer_id"],
        unique=True,
        postgresql_where=sa.text("state IN ('open', 'claimed', 'needs_info')"),
    )
    op.create_table(
        "review_messages",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("review_id", sa.Uuid(), nullable=False),
        sa.Column("author_id", sa.Uuid(), nullable=True),
        sa.Column(
            "kind",
            sa.Enum(
                "question_to_asker", "asker_reply", "reviewer_note", name="review_message_kind"
            ),
            nullable=False,
        ),
        sa.Column("body", sa.Text(), nullable=False),
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
            ["author_id"],
            ["users.id"],
            name=op.f("fk_review_messages_author_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["review_id"],
            ["reviews.id"],
            name=op.f("fk_review_messages_review_id_reviews"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_review_messages")),
    )
    op.create_index("ix_review_messages_review_id", "review_messages", ["review_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_review_messages_review_id", table_name="review_messages")
    op.drop_table("review_messages")
    op.drop_index(
        "uq_reviews_answer_undecided",
        table_name="reviews",
        postgresql_where=sa.text("state IN ('open', 'claimed', 'needs_info')"),
    )
    op.drop_index("ix_reviews_state_created", table_name="reviews")
    op.drop_index("ix_reviews_answer_id", table_name="reviews")
    op.drop_table("reviews")
    for enum_name in ("review_message_kind", "review_state", "review_reason"):
        sa.Enum(name=enum_name).drop(op.get_bind(), checkfirst=True)
