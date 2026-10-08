"""Chunks and files.warning (build step 4).

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-08 15:16:47.284564
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "chunks",
        sa.Column("id", sa.String(length=100), nullable=False),
        sa.Column("file_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("page_from", sa.Integer(), nullable=True),
        sa.Column("page_to", sa.Integer(), nullable=True),
        sa.Column("sheet", sa.String(length=255), nullable=True),
        sa.Column("heading", sa.Text(), nullable=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("token_count", sa.Integer(), nullable=False),
        sa.Column("from_ocr", sa.Boolean(), server_default="false", nullable=False),
        sa.ForeignKeyConstraint(
            ["file_id"], ["files.id"], name=op.f("fk_chunks_file_id_files"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_chunks")),
    )
    op.create_index("ix_chunks_file_id_position", "chunks", ["file_id", "position"], unique=False)
    op.add_column("files", sa.Column("warning", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("files", "warning")
    op.drop_index("ix_chunks_file_id_position", table_name="chunks")
    op.drop_table("chunks")
