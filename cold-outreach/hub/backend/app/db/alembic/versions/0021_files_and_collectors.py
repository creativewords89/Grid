"""Files and Collectors (step 31).

The external team that collects leads signs in as a Collector: they see only the Files
screen and their own files. A file handed in there (`submissions`) is checked by Lead Check,
revised until it is ready, then added to a batch by an Owner or Admin, once.

Revision ID: 0021
Revises: 0020
Create Date: 2026-10-29 22:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'collector'")
    op.create_table(
        "submissions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("file_name", sa.String(length=255), nullable=False),
        sa.Column("niche", sa.String(length=80), nullable=False),
        sa.Column("uploaded_by", sa.Uuid(), nullable=True),
        sa.Column("content", sa.LargeBinary(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("businesses", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "check", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column(
            "problems",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
        sa.Column("import_id", sa.Uuid(), nullable=True),
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
            ["import_id"],
            ["imports.id"],
            name=op.f("fk_submissions_import_id_imports"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["uploaded_by"],
            ["users.id"],
            name=op.f("fk_submissions_uploaded_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_submissions")),
    )
    op.create_index(op.f("ix_submissions_sha256"), "submissions", ["sha256"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_submissions_sha256"), table_name="submissions")
    op.drop_table("submissions")
    # Postgres can't drop one value of a type: collectors become viewers and the type is
    # made again without it.
    op.execute("ALTER TABLE users ALTER COLUMN role TYPE text")
    op.execute("UPDATE users SET role = 'viewer' WHERE role = 'collector'")
    op.execute("DROP TYPE user_role")
    op.execute("CREATE TYPE user_role AS ENUM ('owner', 'admin', 'viewer')")
    op.execute("ALTER TABLE users ALTER COLUMN role TYPE user_role USING role::user_role")
