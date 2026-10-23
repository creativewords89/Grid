"""threads.person: who asked, so Facebook threads can be found by name (build step 17).

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-23 09:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("threads", sa.Column("person", sa.String(length=120), nullable=True))
    # Existing threads: the name given with their first message.
    op.execute(
        """
        UPDATE threads SET person = first.author_name
        FROM (
            SELECT DISTINCT ON (thread_id) thread_id, author_name
            FROM thread_messages WHERE author = 'them'
            ORDER BY thread_id, created_at
        ) AS first
        WHERE first.thread_id = threads.id AND first.author_name IS NOT NULL
        """
    )


def downgrade() -> None:
    op.drop_column("threads", "person")
