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
