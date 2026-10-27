"""Every migration must apply and reverse cleanly, and match the models."""

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text

from app.db import models  # noqa: F401  (registers every table)
from app.db.base import Base
from tests.conftest import alembic_config


def test_single_head() -> None:
    script = ScriptDirectory.from_config(alembic_config("postgresql+psycopg://x@y/z"))

    assert len(script.get_heads()) == 1


def test_upgrade_then_downgrade(fresh_database_url: str) -> None:
    cfg = alembic_config(fresh_database_url)
    head = ScriptDirectory.from_config(cfg).get_current_head()
    engine = create_engine(fresh_database_url)

    def revision() -> str | None:
        with engine.connect() as conn:
            return conn.execute(text("SELECT version_num FROM alembic_version")).scalar()

    try:
        command.upgrade(cfg, "head")
        assert revision() == head

        command.downgrade(cfg, "base")
        assert revision() is None
        assert set(inspect(engine).get_table_names()) <= {"alembic_version"}
        with engine.connect() as conn:
            leftover_types = conn.execute(text("SELECT typname FROM pg_type WHERE typtype = 'e'"))
            assert leftover_types.scalars().all() == []

        command.upgrade(cfg, "head")
        assert revision() == head
    finally:
        engine.dispose()


def test_migrations_match_models(fresh_database_url: str) -> None:
    command.upgrade(alembic_config(fresh_database_url), "head")
    engine = create_engine(fresh_database_url)
    try:
        with engine.connect() as conn:
            diff = compare_metadata(MigrationContext.configure(conn), Base.metadata)
    finally:
        engine.dispose()

    assert diff == []


def test_benchmarks_and_leads_move_into_named_benchmarks_and_batches(
    fresh_database_url: str,
) -> None:
    """Step 10: city benchmarks are averaged per niche, the latest locked standard wins over
    a draft, and leads from before batches go into "Batch 1 · <Niche>"."""
    cfg = alembic_config(fresh_database_url)
    command.upgrade(cfg, "0008")
    engine = create_engine(fresh_database_url)
    try:
        with engine.begin() as conn:
            for sql in (
                "INSERT INTO gbp_benchmarks (id, city, niche, photos, rating) VALUES "
                "(gen_random_uuid(), 'Dallas', 'Cleaning', 100, 4.8), "
                "(gen_random_uuid(), 'Tulsa', 'cleaning', 50, NULL)",
                "INSERT INTO website_standards (id, niche, version, standard) VALUES "
                "(gen_random_uuid(), 'Cleaning', 1, '{\"v\": 1}'), "
                "(gen_random_uuid(), 'Cleaning', 2, '{\"v\": 2}'), "
                "(gen_random_uuid(), 'Cleaning', NULL, '{\"v\": \"draft\"}')",
                "INSERT INTO leads (lead_id, niche, city, business_name) VALUES "
                "('L-000001', 'CLEANING', 'Tulsa', 'A'), ('L-000002', 'Plumbing', 'Tulsa', 'B')",
            ):
                conn.execute(text(sql))
        command.upgrade(cfg, "head")
        with engine.connect() as conn:
            benchmarks = conn.execute(text("SELECT name, gbp, website FROM benchmarks")).all()
            batches = conn.execute(
                text(
                    "SELECT l.lead_id, b.name, m.name FROM leads l JOIN batches b "
                    "ON b.id = l.batch_id LEFT JOIN benchmarks m ON m.id = b.benchmark_id "
                    "ORDER BY l.lead_id"
                )
            ).all()
    finally:
        engine.dispose()

    assert benchmarks == [("Cleaning Benchmark 1", {"photos": 75.0, "rating": 4.8}, {"v": 2})]
    assert batches == [
        ("L-000001", "Batch 1 · Cleaning", "Cleaning Benchmark 1"),
        ("L-000002", "Batch 1 · Plumbing", None),
    ]
