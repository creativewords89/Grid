"""Lead Check: reviews written in thousands are an error (after step 29).

"1.4k" is never changed by the Hub: it is marked as an error until the file is fixed (1400)
and added again. Saved checks are cleared: every lead is checked again under this rule the
first time its batch is looked at.

Revision ID: 0020
Revises: 0019
Create Date: 2026-10-29 20:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute('UPDATE leads SET "check" = NULL')


def downgrade() -> None:
    op.execute('UPDATE leads SET "check" = NULL')
