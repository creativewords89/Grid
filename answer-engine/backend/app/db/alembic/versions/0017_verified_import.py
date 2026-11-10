"""verified_answers: importing from a file, several answers to one question (step 26).

Revision ID: 0017
Revises: 0016
Create Date: 2026-11-10 12:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TYPE verified_origin ADD VALUE IF NOT EXISTS 'import'")
    for name in ("applies_when", "also_asked", "answer_group", "import_key"):
        op.add_column("verified_answers", sa.Column(name, sa.Text(), nullable=True))
    op.create_index(
        "uq_verified_answers_import_key",
        "verified_answers",
        ["import_key"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL AND import_key IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_verified_answers_import_key", table_name="verified_answers")
    for name in ("import_key", "answer_group", "also_asked", "applies_when"):
        op.drop_column("verified_answers", name)
    # Postgres can't drop one value from an enum: imported answers become "admin" ones and
    # the type is made again without "import".
    op.execute("UPDATE verified_answers SET origin = 'admin' WHERE origin = 'import'")
    op.execute("ALTER TYPE verified_origin RENAME TO verified_origin_old")
    op.execute("CREATE TYPE verified_origin AS ENUM ('review', 'admin', 'marketing')")
    op.execute(
        "ALTER TABLE verified_answers ALTER COLUMN origin TYPE verified_origin "
        "USING origin::text::verified_origin"
    )
    op.execute("DROP TYPE verified_origin_old")
