"""Tasks, bots and the batch pipeline (step 12).

Each agent gets the task named after its key, and every batch it worked on gets that task
with it (every bot checks every business). Those batches start running, the rest are not
started; the running order follows the agents' old order, then the oldest batch first. The
agents' own batch lists are removed. Downgrading rebuilds them from the pipelines.

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-28 06:10:00.000000
"""

import json
import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "tasks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("key", sa.String(length=40), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("about", sa.String(length=300), server_default="", nullable=False),
        sa.Column(
            "needs", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_tasks")),
        sa.UniqueConstraint("key", name=op.f("uq_tasks_key")),
    )
    op.create_table(
        "batch_tasks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("batch_id", sa.Uuid(), nullable=False),
        sa.Column("task_id", sa.Uuid(), nullable=False),
        sa.Column("share", sa.String(length=10), server_default="all", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["batch_id"],
            ["batches.id"],
            name=op.f("fk_batch_tasks_batch_id_batches"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["task_id"],
            ["tasks.id"],
            name=op.f("fk_batch_tasks_task_id_tasks"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_batch_tasks")),
    )
    op.create_index("uq_batch_tasks", "batch_tasks", ["batch_id", "task_id"], unique=True)
    op.create_table(
        "batch_task_bots",
        sa.Column("batch_task_id", sa.Uuid(), nullable=False),
        sa.Column("agent_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), server_default="0", nullable=False),
        sa.ForeignKeyConstraint(
            ["batch_task_id"],
            ["batch_tasks.id"],
            name=op.f("fk_batch_task_bots_batch_task_id_batch_tasks"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["agent_id"],
            ["agents.id"],
            name=op.f("fk_batch_task_bots_agent_id_agents"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("batch_task_id", "agent_id", name=op.f("pk_batch_task_bots")),
    )
    op.create_table(
        "lead_bot_shares",
        sa.Column("batch_task_id", sa.Uuid(), nullable=False),
        sa.Column("lead_id", sa.String(length=12), nullable=False),
        sa.Column("agent_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["batch_task_id"],
            ["batch_tasks.id"],
            name=op.f("fk_lead_bot_shares_batch_task_id_batch_tasks"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["lead_id"],
            ["leads.lead_id"],
            name=op.f("fk_lead_bot_shares_lead_id_leads"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["agent_id"],
            ["agents.id"],
            name=op.f("fk_lead_bot_shares_agent_id_agents"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("batch_task_id", "lead_id", name=op.f("pk_lead_bot_shares")),
    )
    op.add_column(
        "batches",
        sa.Column("status", sa.String(length=20), server_default="not_started", nullable=False),
    )
    op.add_column(
        "batches", sa.Column("position", sa.Integer(), server_default="0", nullable=False)
    )
    op.add_column("agents", sa.Column("task_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_agents_task_id_tasks"), "agents", "tasks", ["task_id"], ["id"], ondelete="SET NULL"
    )
    _move_batch_lists()
    op.drop_column("agents", "batch_ids")


def _move_batch_lists() -> None:
    conn = op.get_bind()
    batches = [
        row[0] for row in conn.execute(sa.text("SELECT id FROM batches ORDER BY created_at, id"))
    ]
    known = {str(batch_id) for batch_id in batches}
    order: list[str] = []
    agents = conn.execute(
        sa.text("SELECT id, key, name, manifest, batch_ids FROM agents ORDER BY created_at, id")
    ).all()
    for agent_id, key, name, manifest, batch_ids in agents:
        task_id = uuid.uuid4()
        task_name = ((manifest or {}).get("name") or name)[:80]
        conn.execute(
            sa.text("INSERT INTO tasks (id, key, name) VALUES (:id, :key, :name)"),
            {"id": task_id, "key": key, "name": task_name},
        )
        conn.execute(
            sa.text("UPDATE agents SET task_id = :task WHERE id = :id"),
            {"task": task_id, "id": agent_id},
        )
        for batch_id in batch_ids or []:
            if batch_id not in known:
                continue
            if batch_id not in order:
                order.append(batch_id)
            slot = uuid.uuid4()
            conn.execute(
                sa.text(
                    "INSERT INTO batch_tasks (id, batch_id, task_id, share) "
                    "VALUES (:id, :batch, :task, 'all')"
                ),
                {"id": slot, "batch": batch_id, "task": task_id},
            )
            conn.execute(
                sa.text(
                    "INSERT INTO batch_task_bots (batch_task_id, agent_id, position) "
                    "VALUES (:slot, :agent, 0)"
                ),
                {"slot": slot, "agent": agent_id},
            )
    running = set(order)
    order += [str(batch_id) for batch_id in batches if str(batch_id) not in running]
    for position, batch_id in enumerate(order):
        conn.execute(
            sa.text("UPDATE batches SET position = :position, status = :status WHERE id = :id"),
            {
                "position": position,
                "status": "running" if batch_id in running else "not_started",
                "id": batch_id,
            },
        )


def downgrade() -> None:
    op.add_column(
        "agents",
        sa.Column(
            "batch_ids",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
    )
    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            "SELECT b.agent_id, t.batch_id FROM batch_task_bots b "
            "JOIN batch_tasks t ON t.id = b.batch_task_id "
            "JOIN batches c ON c.id = t.batch_id ORDER BY c.position, c.created_at"
        )
    ).all()
    lists: dict[str, list[str]] = {}
    for agent_id, batch_id in rows:
        lists.setdefault(str(agent_id), []).append(str(batch_id))
    for agent_id, batch_ids in lists.items():
        conn.execute(
            sa.text("UPDATE agents SET batch_ids = CAST(:ids AS jsonb) WHERE id = :id"),
            {"ids": json.dumps(batch_ids), "id": agent_id},
        )
    op.drop_constraint(op.f("fk_agents_task_id_tasks"), "agents", type_="foreignkey")
    op.drop_column("agents", "task_id")
    op.drop_column("batches", "position")
    op.drop_column("batches", "status")
    op.drop_table("lead_bot_shares")
    op.drop_table("batch_task_bots")
    op.drop_index("uq_batch_tasks", table_name="batch_tasks")
    op.drop_table("batch_tasks")
    op.drop_table("tasks")
