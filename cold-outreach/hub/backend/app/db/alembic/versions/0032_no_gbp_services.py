"""GBP services leave the plan (asked for after step 51): a benchmark's GBP part no longer
has a number of services. The Website Standard's services stay.

Revision ID: 0032
Revises: 0031
Create Date: 2026-11-04 10:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0032"
down_revision: str | None = "0031"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("UPDATE benchmarks SET gbp = gbp - 'services' WHERE gbp ? 'services'")


def downgrade() -> None:
    pass
