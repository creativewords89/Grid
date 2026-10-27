"""Every migration must apply cleanly and reverse cleanly (build step 1 onwards)."""

from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Engine, inspect, text

BACKEND = Path(__file__).resolve().parent.parent


def _alembic_config(database_url: str) -> Config:
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "app/db/alembic"))
    cfg.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))
    cfg.attributes["configure_logger"] = False
    return cfg


def _current_revision(engine: Engine) -> str | None:
    with engine.connect() as conn:
        return conn.execute(text("SELECT version_num FROM alembic_version")).scalar()


def test_single_head() -> None:
    script = ScriptDirectory.from_config(_alembic_config("postgresql+psycopg://x@y/z"))

    assert len(script.get_heads()) == 1


def test_upgrade_then_downgrade(database_url: str, engine: Engine) -> None:
    cfg = _alembic_config(database_url)
    head = ScriptDirectory.from_config(cfg).get_current_head()

    command.upgrade(cfg, "head")
    assert _current_revision(engine) == head

    command.downgrade(cfg, "base")
    assert _current_revision(engine) is None
    assert set(inspect(engine).get_table_names()) <= {"alembic_version"}

    command.upgrade(cfg, "head")
    assert _current_revision(engine) == head
