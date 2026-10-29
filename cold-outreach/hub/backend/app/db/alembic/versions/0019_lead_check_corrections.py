"""Lead Check corrections (after step 28).

An empty phone and a long business name are normal (no warning); reviews may be written as
1.4k (1,400); WhatsApp Yes without a phone, an empty address and an address that doesn't
name the City column's city are errors. Saved checks are cleared: every lead is checked
again under these rules the first time its batch is looked at.

Revision ID: 0019
Revises: 0018
Create Date: 2026-10-29 18:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute('UPDATE leads SET "check" = NULL')


def downgrade() -> None:
    op.execute('UPDATE leads SET "check" = NULL')
