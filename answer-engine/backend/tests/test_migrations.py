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


def test_existing_facebook_threads_become_the_first_set(fresh_database_url: str) -> None:
    """Step 29: the threads answered before keep their verified answers' keys (prefix fb)."""
    cfg = alembic_config(fresh_database_url)
    command.upgrade(cfg, "0019")
    engine = create_engine(fresh_database_url)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO fb_posts (id, row, question) VALUES (gen_random_uuid(), 1, 'Q?');"
                    "INSERT INTO fb_threads (id, key, title, rows) "
                    "VALUES (gen_random_uuid(), 's1', 'Q?', '{1}')"
                )
            )
        command.upgrade(cfg, "head")
        with engine.connect() as conn:
            name, prefix, sid = conn.execute(
                text("SELECT name, prefix, id FROM question_sets")
            ).one()
            assert (name, prefix) == ("Facebook group", "fb")
            posts = conn.execute(text("SELECT set_id FROM fb_posts")).scalars().all()
            threads = conn.execute(text("SELECT set_id FROM fb_threads")).scalars().all()
            assert posts == threads == [sid]
    finally:
        engine.dispose()


def test_verified_answers_take_their_threads_topics(fresh_database_url: str) -> None:
    """Step 30: answers approved in the Question Bank get their thread's topic."""
    cfg = alembic_config(fresh_database_url)
    command.upgrade(cfg, "0020")
    engine = create_engine(fresh_database_url)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO question_sets (id, name, prefix) "
                    "VALUES ('00000000-0000-0000-0000-000000000001', 'FB', 'fb');"
                    "INSERT INTO fb_threads (id, set_id, key, title, topic, subtopic) "
                    "VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000001', "
                    "'s1', 'Q?', 'GBP', 'Reviews');"
                    "INSERT INTO verified_answers (id, question, answer, status, origin, "
                    "version, answer_group, import_key) VALUES "
                    "(gen_random_uuid(), 'Q?', 'A.', 'active', 'facebook', 1, 'fb:s1', 'fb:s1:1'),"
                    "(gen_random_uuid(), 'Other?', 'B.', 'active', 'admin', 1, NULL, NULL)"
                )
            )
        command.upgrade(cfg, "head")
        with engine.connect() as conn:
            rows = conn.execute(
                text("SELECT topic, subtopic FROM verified_answers ORDER BY question")
            ).all()
            assert [tuple(r) for r in rows] == [("", ""), ("GBP", "Reviews")]
    finally:
        engine.dispose()
