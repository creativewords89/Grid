"""Small cities muted (step 16).

A batch's city with fewer than 10 businesses is switched off by the Hub unless a person
switched it by hand. Cities that were off stay off, as if set by hand; the others follow the
rule.

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-28 09:20:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "lists",
        sa.Column("set_by_hand", sa.Boolean(), server_default="false", nullable=False),
    )
    op.execute("UPDATE lists SET set_by_hand = true WHERE active = false")
    op.execute(
        "UPDATE lists SET active = false WHERE set_by_hand = false AND ("
        "SELECT count(*) FROM leads WHERE leads.batch_id = lists.batch_id "
        "AND lower(leads.city) = lower(lists.city)) < 10"
    )


def downgrade() -> None:
    op.drop_column("lists", "set_by_hand")
