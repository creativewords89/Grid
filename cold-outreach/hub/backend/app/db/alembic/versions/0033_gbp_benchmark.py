"""The GBP part of a benchmark keeps what an agency can improve (step 53): the right primary
categories, the standard GBP services (new), photos and posts in 90 days. Additional
categories, description length, reviews, rating, review replies and the services named in
the description go. The Website Standard is unchanged.

Revision ID: 0033
Revises: 0032
Create Date: 2026-11-05 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0033"
down_revision: str | None = "0032"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

GONE = (
    "additional_categories",
    "description_length",
    "reviews",
    "rating",
    "review_reply_pct",
    "services_in_description",
)


def upgrade() -> None:
    for key in GONE:
        op.execute(sa.text("UPDATE benchmarks SET gbp = gbp - :key").bindparams(key=key))


def downgrade() -> None:
    pass
