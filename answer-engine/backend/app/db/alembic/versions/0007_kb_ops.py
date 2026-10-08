"""Pinecone outbox kb_ops (build step 7).

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-08 18:24:23.505087
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
        "kb_ops",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("op", sa.Enum("upsert", "delete", name="kb_op_kind"), nullable=False),
        sa.Column("namespace", sa.String(length=50), nullable=False),
        sa.Column("record_ids", postgresql.ARRAY(sa.String(length=100)), nullable=False),
        sa.Column("file_id", sa.Uuid(), nullable=True),
        sa.Column("state", sa.Enum("pending", "done", name="kb_op_state"), nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "next_attempt_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("last_error", sa.Text(), nullable=True),
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
            ["file_id"], ["files.id"], name=op.f("fk_kb_ops_file_id_files"), ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_kb_ops")),
        sa.UniqueConstraint("seq", name=op.f("uq_kb_ops_seq")),
    )
    op.create_index("ix_kb_ops_file_id", "kb_ops", ["file_id"], unique=False)
    op.create_index(
        "ix_kb_ops_pending",
        "kb_ops",
        ["seq"],
        unique=False,
        postgresql_where=sa.text("state = 'pending'"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_kb_ops_pending", table_name="kb_ops", postgresql_where=sa.text("state = 'pending'")
    )
    op.drop_index("ix_kb_ops_file_id", table_name="kb_ops")
    op.drop_table("kb_ops")
    for enum_name in ("kb_op_state", "kb_op_kind"):
        sa.Enum(name=enum_name).drop(op.get_bind(), checkfirst=True)
