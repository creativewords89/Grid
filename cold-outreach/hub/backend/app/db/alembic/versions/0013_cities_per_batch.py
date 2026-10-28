"""Cities per batch (step 15).

The City + Niche lists become each batch's cities: a list goes into every batch that has
leads in that city and niche, keeping on or off and its limit. Downgrading joins them back
into one list per City + Niche, on when it was on in every batch.

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-28 08:00:00.000000
"""

import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("lists", sa.Column("batch_id", sa.Uuid(), nullable=True))
    op.drop_index("uq_lists_city_niche", table_name="lists")  # a city is now in many batches
    conn = op.get_bind()
    lists = conn.execute(sa.text("SELECT city, niche, active, daily_limit FROM lists")).all()
    for city, niche, active, daily_limit in lists:
        batches = conn.execute(
            sa.text(
                "SELECT DISTINCT batch_id FROM leads WHERE batch_id IS NOT NULL "
                "AND lower(city) = lower(:city) AND lower(niche) = lower(:niche)"
            ),
            {"city": city, "niche": niche},
        ).scalars()
        for batch_id in batches:
            conn.execute(
                sa.text(
                    "INSERT INTO lists (id, batch_id, city, niche, active, daily_limit) "
                    "VALUES (:id, :batch, :city, :niche, :active, :limit)"
                ),
                {
                    "id": uuid.uuid4(),
                    "batch": batch_id,
                    "city": city,
                    "niche": niche,
                    "active": active,
                    "limit": daily_limit,
                },
            )
    conn.execute(sa.text("DELETE FROM lists WHERE batch_id IS NULL"))
    op.alter_column("lists", "batch_id", nullable=False)
    op.create_index(
        "uq_lists_batch_city", "lists", ["batch_id", sa.literal_column("lower(city)")], unique=True
    )
    op.create_foreign_key(
        op.f("fk_lists_batch_id_batches"),
        "lists",
        "batches",
        ["batch_id"],
        ["id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    conn = op.get_bind()
    joined = conn.execute(
        sa.text(
            "SELECT min(city), min(niche), bool_and(active), min(daily_limit) FROM lists "
            "GROUP BY lower(city), lower(niche)"
        )
    ).all()
    op.drop_constraint(op.f("fk_lists_batch_id_batches"), "lists", type_="foreignkey")
    op.drop_index("uq_lists_batch_city", table_name="lists")
    conn.execute(sa.text("DELETE FROM lists"))
    op.drop_column("lists", "batch_id")
    for city, niche, active, daily_limit in joined:
        conn.execute(
            sa.text(
                "INSERT INTO lists (id, city, niche, active, daily_limit) "
                "VALUES (:id, :city, :niche, :active, :limit)"
            ),
            {
                "id": uuid.uuid4(),
                "city": city,
                "niche": niche,
                "active": active,
                "limit": daily_limit,
            },
        )
    op.create_index("uq_lists_city_niche", "lists", ["city", "niche"], unique=True)
