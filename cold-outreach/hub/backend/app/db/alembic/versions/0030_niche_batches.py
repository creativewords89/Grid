"""Every niche of the files has its batch (step 47).

A niche's batch is now made when its first file is handed in, so Files, Top Review and
Batches show the same niches. The niches of the files handed in so far get theirs now
(named after the niche, with its benchmark when it has exactly one), and a batch no file
of its niche is left for, without leads or saved files and never started, goes.

Revision ID: 0030
Revises: 0029
Create Date: 2026-11-02 10:00:00.000000
"""

import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0030"
down_revision: str | None = "0029"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    db = op.get_bind()
    db.execute(
        sa.text(
            """
            DELETE FROM imports i USING batches b
            WHERE i.batch_id = b.id AND i.status IN ('failed', 'discarded')
              AND b.status = 'not_started'
              AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.batch_id = b.id)
              AND NOT EXISTS (SELECT 1 FROM imports k WHERE k.batch_id = b.id
                              AND k.status IN ('confirmed', 'preview'))
              AND NOT EXISTS (SELECT 1 FROM submissions s
                              WHERE lower(trim(s.niche)) = lower(trim(b.niche)))
            """
        )
    )
    db.execute(
        sa.text(
            """
            DELETE FROM batches b
            WHERE b.status = 'not_started'
              AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.batch_id = b.id)
              AND NOT EXISTS (SELECT 1 FROM imports k WHERE k.batch_id = b.id)
              AND NOT EXISTS (SELECT 1 FROM submissions s
                              WHERE lower(trim(s.niche)) = lower(trim(b.niche)))
            """
        )
    )
    niches = db.execute(
        sa.text(
            """
            SELECT min(trim(s.niche)) FROM submissions s
            WHERE NOT EXISTS (SELECT 1 FROM batches b
                              WHERE lower(trim(b.niche)) = lower(trim(s.niche)))
            GROUP BY lower(trim(s.niche))
            ORDER BY 1
            """
        )
    ).scalars()
    for niche in list(niches):
        benchmarks = list(
            db.execute(
                sa.text("SELECT id FROM benchmarks WHERE lower(trim(niche)) = lower(:niche)"),
                {"niche": niche},
            ).scalars()
        )
        name = niche
        taken = db.execute(
            sa.text("SELECT 1 FROM batches WHERE lower(name) = lower(:name)"), {"name": name}
        ).first()
        if taken is not None:
            name = f"{niche} batch"
        db.execute(
            sa.text(
                """
                INSERT INTO batches (id, name, niche, benchmark_id, status, position,
                                     created_at, updated_at)
                VALUES (:id, :name, :niche, :benchmark, 'not_started',
                        COALESCE((SELECT max(position) FROM batches), 0) + 1, now(), now())
                """
            ),
            {
                "id": uuid.uuid4(),
                "name": name,
                "niche": niche,
                "benchmark": benchmarks[0] if len(benchmarks) == 1 else None,
            },
        )


def downgrade() -> None:
    pass
