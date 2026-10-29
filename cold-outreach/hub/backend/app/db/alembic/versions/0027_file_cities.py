"""Cities go on to their niche's batch (step 39).

Each file's cities are kept (`file_cities`): muted when another file of the niche or its
batch has the city, with their Top, ready since and when they went on to the batch. Each
niche has one batch, named after it, made when its first city comes, so the batches made
before are deleted with their leads, files, agents' results and tasks (the files handed in,
niches, benchmarks, agents and people stay). A file's Tops move to its cities (those with a
Top are ready from now); the files are checked again, against each other. Files' batch names
and numbers per niche go.

Revision ID: 0027
Revises: 0026
Create Date: 2026-10-31 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0027"
down_revision: str | None = "0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "file_cities",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("submission_id", sa.Uuid(), nullable=False),
        sa.Column("key", sa.String(length=120), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("businesses", sa.Integer(), server_default="0", nullable=False),
        sa.Column("muted", sa.String(length=300), server_default="", nullable=False),
        sa.Column(
            "tops", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False
        ),
        sa.Column("topped_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("moved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("import_id", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(["submission_id"], ["submissions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["import_id"], ["imports.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("uq_file_cities_file_key", "file_cities", ["submission_id", "key"], unique=True)
    op.create_index("ix_file_cities_key", "file_cities", ["key"])
    op.execute(
        """
        INSERT INTO file_cities (id, submission_id, key, name, businesses, tops, topped_at)
        SELECT gen_random_uuid(), s.id, left(c.key, 120),
            left(COALESCE(c.value->>'name', c.key), 120),
            COALESCE((c.value->>'businesses')::int, 0),
            COALESCE(s.tops->c.key, '[]'::jsonb),
            CASE WHEN jsonb_array_length(COALESCE(s.tops->c.key, '[]'::jsonb)) > 0
                THEN now() END
        FROM submissions s, jsonb_each(COALESCE(s."check"->'cities', '{}'::jsonb)) AS c
        WHERE s.state = 'checked'
        """
    )
    # The batches made before, and all that is in them.
    op.execute("DELETE FROM do_not_contact WHERE reason = 'top'")
    op.execute("DELETE FROM lead_bot_shares")
    op.execute("DELETE FROM lead_files")
    op.execute("DELETE FROM leads")
    op.execute("UPDATE submissions SET import_id = NULL")
    op.execute("DELETE FROM imports")
    op.execute("DELETE FROM lists")
    op.execute("DELETE FROM batch_tasks")
    op.execute("DELETE FROM batches")
    op.drop_column("submissions", "import_id")
    op.drop_column("submissions", "tops")
    op.drop_column("submissions", "topped_at")
    op.drop_column("submissions", "batch_name")
    op.drop_column("niches", "files")
    # Checked again: against each other's cities and businesses.
    op.execute("UPDATE submissions SET state = 'checking', progress = 0, claimed_at = NULL")


def downgrade() -> None:
    op.add_column("niches", sa.Column("files", sa.Integer(), server_default="0", nullable=False))
    op.add_column(
        "submissions",
        sa.Column("batch_name", sa.String(length=120), server_default="", nullable=False),
    )
    op.add_column("submissions", sa.Column("topped_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "submissions",
        sa.Column(
            "tops", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
    )
    op.add_column("submissions", sa.Column("import_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_submissions_import_id_imports"),
        "submissions",
        "imports",
        ["import_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.execute(
        """
        UPDATE submissions s SET tops = found.tops FROM (
            SELECT submission_id, jsonb_object_agg(key, tops) AS tops
            FROM file_cities GROUP BY submission_id
        ) AS found WHERE s.id = found.submission_id
        """
    )
    op.drop_index("ix_file_cities_key", table_name="file_cities")
    op.drop_index("uq_file_cities_file_key", table_name="file_cities")
    op.drop_table("file_cities")
