"""Every problem an error, and the Final check (step 36).

Lead Check's warnings (no business name, no GBP link, a made-up email, a column missing or
given twice, a City that isn't the tab's) are errors now: saved checks are cleared, so every
lead is checked again the first time its batch is looked at, and the files handed in are
checked again. A file without errors waits in its Final check for an hour (or until its
sender sends it on) before Top Review: `clean_since` and `sent_at`. Files already past it
count as sent.

Revision ID: 0025
Revises: 0024
Create Date: 2026-10-30 14:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0025"
down_revision: str | None = "0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "submissions", sa.Column("clean_since", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("submissions", sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True))
    op.execute(
        """
        UPDATE submissions SET sent_at = now(), clean_since = now()
        WHERE state = 'checked' AND COALESCE((("check"->>'errors')::int), 0) = 0
        """
    )
    op.execute("UPDATE submissions SET state = 'checking', progress = 0, claimed_at = NULL")
    op.execute('UPDATE leads SET "check" = NULL')


def downgrade() -> None:
    op.drop_column("submissions", "sent_at")
    op.drop_column("submissions", "clean_since")
    op.execute('UPDATE leads SET "check" = NULL')
