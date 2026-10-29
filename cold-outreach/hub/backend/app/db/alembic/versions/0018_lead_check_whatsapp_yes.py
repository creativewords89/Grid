"""Lead Check: WhatsApp is Yes or empty (after step 27).

WhatsApp says whether the lead's Phone number has WhatsApp: "Yes", or empty when it hasn't.
A phone number or "No" there is a problem. Saved checks are cleared: every lead is checked
again under the new rule the first time its batch is looked at.

Revision ID: 0018
Revises: 0017
Create Date: 2026-10-29 15:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute('UPDATE leads SET "check" = NULL')


def downgrade() -> None:
    op.execute('UPDATE leads SET "check" = NULL')
