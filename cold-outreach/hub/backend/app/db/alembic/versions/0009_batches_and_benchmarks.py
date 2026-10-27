"""Batches and named benchmarks (step 10).

Each niche's GBP benchmarks (averaged over its cities) and Website Standard (the latest
locked version, else the draft) become "<Niche> Benchmark 1". Leads and imports from before
batches go into "Batch 1 · <Niche>", which uses that benchmark when there is one.
Downgrading drops batches and benchmarks; the old tables come back empty.

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-27 18:24:09.409617
"""

import json
import uuid
from collections.abc import Sequence
from decimal import Decimal
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "benchmarks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("niche", sa.String(length=80), nullable=False),
        sa.Column(
            "gbp", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column(
            "website", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("updated_by", sa.Uuid(), nullable=True),
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
        sa.ForeignKeyConstraint(
            ["updated_by"],
            ["users.id"],
            name=op.f("fk_benchmarks_updated_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_benchmarks")),
    )
    op.create_index(
        "uq_benchmarks_name", "benchmarks", [sa.literal_column("lower(name)")], unique=True
    )
    op.create_table(
        "batches",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("niche", sa.String(length=80), nullable=False),
        sa.Column("benchmark_id", sa.Uuid(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
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
        sa.ForeignKeyConstraint(
            ["benchmark_id"],
            ["benchmarks.id"],
            name=op.f("fk_batches_benchmark_id_benchmarks"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
            name=op.f("fk_batches_created_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_batches")),
    )
    op.create_index("uq_batches_name", "batches", [sa.literal_column("lower(name)")], unique=True)
    op.add_column(
        "agents",
        sa.Column(
            "batch_ids",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="[]",
            nullable=False,
        ),
    )
    op.add_column("imports", sa.Column("batch_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_imports_batch_id_batches"),
        "imports",
        "batches",
        ["batch_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.add_column("leads", sa.Column("batch_id", sa.Uuid(), nullable=True))
    op.create_index("ix_leads_batch_id", "leads", ["batch_id"], unique=False)
    op.create_foreign_key(
        op.f("fk_leads_batch_id_batches"),
        "leads",
        "batches",
        ["batch_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    _move_data(op.get_bind())
    op.drop_index(op.f("uq_gbp_benchmarks_city_niche"), table_name="gbp_benchmarks")
    op.drop_table("gbp_benchmarks")
    op.drop_index(op.f("uq_website_standards_niche_version"), table_name="website_standards")
    op.drop_index(
        op.f("uq_website_standards_one_draft"),
        table_name="website_standards",
        postgresql_where="(version IS NULL)",
    )
    op.drop_table("website_standards")


GBP_FIELDS = (
    "additional_categories",
    "services",
    "photos",
    "posts_90_days",
    "description_length",
    "reviews",
    "rating",
    "review_reply_pct",
)


def _move_data(conn: sa.Connection) -> None:
    def rows(sql: str) -> list[Any]:
        return list(conn.execute(sa.text(sql)).mappings())

    spelling: dict[str, str] = {}  # lower-case niche -> the first spelling seen

    def niche(name: str) -> str:
        return spelling.setdefault(name.lower(), name)

    standards: dict[str, dict[str, Any]] = {}
    for row in rows(
        "SELECT niche, standard FROM website_standards ORDER BY version DESC NULLS LAST"
    ):
        standards.setdefault(niche(row["niche"]).lower(), row["standard"])
    gbp_rows: dict[str, list[Any]] = {}
    for row in rows("SELECT * FROM gbp_benchmarks ORDER BY niche, city"):
        gbp_rows.setdefault(niche(row["niche"]).lower(), []).append(row)

    benchmark_of: dict[str, uuid.UUID] = {}
    for key in sorted(set(standards) | set(gbp_rows)):
        gbp: dict[str, float] = {}
        for name in GBP_FIELDS:
            values = [Decimal(r[name]) for r in gbp_rows.get(key, []) if r[name] is not None]
            if values:
                gbp[name] = round(float(sum(values) / len(values)), 2)
        benchmark_of[key] = uuid.uuid4()
        conn.execute(
            sa.text(
                "INSERT INTO benchmarks (id, name, niche, gbp, website) "
                "VALUES (:id, :name, :niche, CAST(:gbp AS jsonb), CAST(:website AS jsonb))"
            ),
            {
                "id": benchmark_of[key],
                "name": f"{spelling[key]} Benchmark 1",
                "niche": spelling[key],
                "gbp": json.dumps(gbp),
                "website": json.dumps(standards.get(key, {})),
            },
        )

    lead_niches = rows("SELECT DISTINCT niche FROM leads UNION SELECT DISTINCT niche FROM imports")
    for key in sorted({niche(r["niche"]).lower() for r in lead_niches}):
        batch_id = uuid.uuid4()
        conn.execute(
            sa.text(
                "INSERT INTO batches (id, name, niche, benchmark_id) "
                "VALUES (:id, :name, :niche, :benchmark)"
            ),
            {
                "id": batch_id,
                "name": f"Batch 1 · {spelling[key]}",
                "niche": spelling[key],
                "benchmark": benchmark_of.get(key),
            },
        )
        params = {"id": batch_id, "key": key}
        conn.execute(sa.text("UPDATE leads SET batch_id = :id WHERE lower(niche) = :key"), params)
        conn.execute(sa.text("UPDATE imports SET batch_id = :id WHERE lower(niche) = :key"), params)


def downgrade() -> None:
    op.drop_constraint(op.f("fk_leads_batch_id_batches"), "leads", type_="foreignkey")
    op.drop_index("ix_leads_batch_id", table_name="leads")
    op.drop_column("leads", "batch_id")
    op.drop_constraint(op.f("fk_imports_batch_id_batches"), "imports", type_="foreignkey")
    op.drop_column("imports", "batch_id")
    op.drop_column("agents", "batch_ids")
    op.create_table(
        "website_standards",
        sa.Column("id", sa.UUID(), autoincrement=False, nullable=False),
        sa.Column("niche", sa.VARCHAR(length=80), autoincrement=False, nullable=False),
        sa.Column("version", sa.INTEGER(), autoincrement=False, nullable=True),
        sa.Column(
            "standard", postgresql.JSONB(astext_type=sa.Text()), autoincrement=False, nullable=False
        ),
        sa.Column("edited_by", sa.UUID(), autoincrement=False, nullable=True),
        sa.Column(
            "edited_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            autoincrement=False,
            nullable=False,
        ),
        sa.Column("locked_by", sa.UUID(), autoincrement=False, nullable=True),
        sa.Column(
            "locked_at", postgresql.TIMESTAMP(timezone=True), autoincrement=False, nullable=True
        ),
        sa.ForeignKeyConstraint(
            ["edited_by"],
            ["users.id"],
            name=op.f("fk_website_standards_edited_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["locked_by"],
            ["users.id"],
            name=op.f("fk_website_standards_locked_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_website_standards")),
    )
    op.create_index(
        op.f("uq_website_standards_one_draft"),
        "website_standards",
        ["niche"],
        unique=True,
        postgresql_where="(version IS NULL)",
    )
    op.create_index(
        op.f("uq_website_standards_niche_version"),
        "website_standards",
        ["niche", "version"],
        unique=True,
    )
    op.create_table(
        "gbp_benchmarks",
        sa.Column("id", sa.UUID(), autoincrement=False, nullable=False),
        sa.Column("city", sa.VARCHAR(length=120), autoincrement=False, nullable=False),
        sa.Column("niche", sa.VARCHAR(length=80), autoincrement=False, nullable=False),
        sa.Column(
            "additional_categories",
            sa.NUMERIC(precision=10, scale=2),
            autoincrement=False,
            nullable=True,
        ),
        sa.Column(
            "services", sa.NUMERIC(precision=10, scale=2), autoincrement=False, nullable=True
        ),
        sa.Column("photos", sa.NUMERIC(precision=10, scale=2), autoincrement=False, nullable=True),
        sa.Column(
            "posts_90_days", sa.NUMERIC(precision=10, scale=2), autoincrement=False, nullable=True
        ),
        sa.Column(
            "description_length",
            sa.NUMERIC(precision=10, scale=2),
            autoincrement=False,
            nullable=True,
        ),
        sa.Column("reviews", sa.NUMERIC(precision=10, scale=2), autoincrement=False, nullable=True),
        sa.Column("rating", sa.NUMERIC(precision=4, scale=2), autoincrement=False, nullable=True),
        sa.Column(
            "review_reply_pct", sa.NUMERIC(precision=5, scale=2), autoincrement=False, nullable=True
        ),
        sa.Column(
            "reference_businesses",
            sa.VARCHAR(length=1000),
            server_default=sa.text("''::character varying"),
            autoincrement=False,
            nullable=False,
        ),
        sa.Column("updated_by", sa.UUID(), autoincrement=False, nullable=True),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            autoincrement=False,
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            autoincrement=False,
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["updated_by"],
            ["users.id"],
            name=op.f("fk_gbp_benchmarks_updated_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_gbp_benchmarks")),
    )
    op.create_index(
        op.f("uq_gbp_benchmarks_city_niche"), "gbp_benchmarks", ["city", "niche"], unique=True
    )
    op.drop_index("uq_batches_name", table_name="batches")
    op.drop_table("batches")
    op.drop_index("uq_benchmarks_name", table_name="benchmarks")
    op.drop_table("benchmarks")
