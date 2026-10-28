"""Tasks made in the batch (step 18).

A batch's task gets its own name and what it needs first (the jobs of the batch's other
tasks it waits for), copied from its job; jobs keep only their key and name. Downgrading
gives each job the needs of the batches that use it, joined.

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-28 12:00:00.000000
"""

import json
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "batch_tasks", sa.Column("name", sa.String(length=80), server_default="", nullable=False)
    )
    op.add_column(
        "batch_tasks",
        sa.Column(
            "needs", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False
        ),
    )
    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            "SELECT b.id, b.batch_id, t.name, t.needs FROM batch_tasks b "
            "JOIN tasks t ON t.id = b.task_id"
        )
    ).all()
    present: dict[str, set[str]] = {}
    for batch_id, key in conn.execute(
        sa.text("SELECT b.batch_id, t.key FROM batch_tasks b JOIN tasks t ON t.id = b.task_id")
    ):
        present.setdefault(str(batch_id), set()).add(key)
    for slot_id, batch_id, name, needs in rows:
        kept = [key for key in needs or [] if key in present.get(str(batch_id), set())]
        conn.execute(
            sa.text(
                "UPDATE batch_tasks SET name = :name, needs = CAST(:needs AS jsonb) WHERE id = :id"
            ),
            {"name": name, "needs": json.dumps(kept), "id": slot_id},
        )
    op.drop_column("tasks", "needs")
    op.drop_column("tasks", "about")


def downgrade() -> None:
    op.add_column(
        "tasks", sa.Column("about", sa.String(length=300), server_default="", nullable=False)
    )
    op.add_column(
        "tasks",
        sa.Column(
            "needs", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False
        ),
    )
    conn = op.get_bind()
    joined: dict[str, list[str]] = {}
    for task_id, needs in conn.execute(sa.text("SELECT task_id, needs FROM batch_tasks")):
        bucket = joined.setdefault(str(task_id), [])
        bucket.extend(key for key in needs or [] if key not in bucket)
    for task_id, needs in joined.items():
        conn.execute(
            sa.text("UPDATE tasks SET needs = CAST(:needs AS jsonb) WHERE id = :id"),
            {"needs": json.dumps(needs), "id": task_id},
        )
    op.drop_column("batch_tasks", "needs")
    op.drop_column("batch_tasks", "name")
