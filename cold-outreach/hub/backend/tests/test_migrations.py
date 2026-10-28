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


def test_the_google_connection_is_removed(fresh_database_url: str) -> None:
    """Step 11: leads are kept in the Hub, so the Google values and last test go."""
    cfg = alembic_config(fresh_database_url)
    command.upgrade(cfg, "0009")
    engine = create_engine(fresh_database_url)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO settings (key, value) VALUES "
                    '(\'connections\', \'{"google_sheet_url": "x", "smtp_host": "y"}\'), '
                    "('connection_tests', '{\"google\": {}, \"email\": {}}')"
                )
            )
        command.upgrade(cfg, "head")
        with engine.connect() as conn:
            rows = conn.execute(text("SELECT key, value FROM settings")).all()
        values = {key: value for key, value in rows}
    finally:
        engine.dispose()

    assert values == {"connections": {"smtp_host": "y"}, "connection_tests": {"email": {}}}


def test_agents_batch_lists_become_pipelines(fresh_database_url: str) -> None:
    """Step 12: each agent gets the task named after its key and the batches it worked on
    get that task with it; those batches run first, the rest are not started."""
    cfg = alembic_config(fresh_database_url)
    command.upgrade(cfg, "0010")
    engine = create_engine(fresh_database_url)
    a, b, c = (
        "00000000-0000-0000-0000-00000000000a",
        "00000000-0000-0000-0000-00000000000b",
        "00000000-0000-0000-0000-00000000000c",
    )
    try:
        with engine.begin() as conn:
            for n, batch in enumerate((a, b, c)):
                conn.execute(
                    text(
                        "INSERT INTO batches (id, name, niche, created_at) "
                        "VALUES (:id, :name, 'Cleaning', now() + make_interval(secs => :n))"
                    ),
                    {"id": batch, "name": f"Batch {n}", "n": n},
                )
            conn.execute(
                text(
                    "INSERT INTO agents (id, key, name, token_hash, batch_ids) VALUES "
                    "('00000000-0000-0000-0000-000000000001', 'gbp-audit', 'GBP audit', 'h', "
                    "CAST(:ids AS jsonb))"
                ),
                {"ids": f'["{c}", "{a}", "00000000-0000-0000-0000-0000000000ff"]'},
            )
        command.upgrade(cfg, "head")
        with engine.connect() as conn:
            tasks = conn.execute(text("SELECT key, name FROM tasks")).all()
            batches = conn.execute(
                text("SELECT name, status, position FROM batches ORDER BY position")
            ).all()
            bots = conn.execute(
                text(
                    "SELECT b.name FROM batch_task_bots x JOIN batch_tasks t ON t.id = "
                    "x.batch_task_id JOIN batches b ON b.id = t.batch_id ORDER BY b.position"
                )
            ).all()
        command.downgrade(cfg, "0010")
        with engine.connect() as conn:
            back = conn.execute(text("SELECT batch_ids FROM agents")).scalar()
    finally:
        engine.dispose()

    assert tasks == [("gbp-audit", "GBP audit")]
    assert batches == [
        ("Batch 2", "running", 0),
        ("Batch 0", "running", 1),
        ("Batch 1", "not_started", 2),
    ]
    assert bots == [("Batch 2",), ("Batch 0",)]
    assert back == [c, a]


def test_city_niche_lists_go_into_each_batch_with_leads_there(fresh_database_url: str) -> None:
    """Step 15: cities are switched per batch; a list keeps its on or off in each batch."""
    cfg = alembic_config(fresh_database_url)
    command.upgrade(cfg, "0012")
    engine = create_engine(fresh_database_url)
    one, two = "00000000-0000-0000-0000-00000000000a", "00000000-0000-0000-0000-00000000000b"
    try:
        with engine.begin() as conn:
            for batch, name in ((one, "One"), (two, "Two")):
                conn.execute(
                    text("INSERT INTO batches (id, name, niche) VALUES (:id, :n, 'Cleaning')"),
                    {"id": batch, "n": name},
                )
            for lead_id, batch, city in (
                ("L-000001", one, "Tulsa"),
                ("L-000002", two, "tulsa"),
                ("L-000003", two, "Dallas"),
            ):
                conn.execute(
                    text(
                        "INSERT INTO leads (lead_id, batch_id, niche, city, business_name) "
                        "VALUES (:id, :batch, 'Cleaning', :city, 'X')"
                    ),
                    {"id": lead_id, "batch": batch, "city": city},
                )
            conn.execute(
                text(
                    "INSERT INTO lists (id, city, niche, active) VALUES "
                    "('00000000-0000-0000-0000-000000000001', 'Tulsa', 'Cleaning', false), "
                    "('00000000-0000-0000-0000-000000000002', 'Dallas', 'Cleaning', true), "
                    "('00000000-0000-0000-0000-000000000003', 'Austin', 'Cleaning', true)"
                )
            )
        command.upgrade(cfg, "0013")
        with engine.connect() as conn:
            moved = conn.execute(
                text(
                    "SELECT b.name, l.city, l.active FROM lists l JOIN batches b "
                    "ON b.id = l.batch_id ORDER BY b.name, l.city"
                )
            ).all()
        command.downgrade(cfg, "0012")
        with engine.connect() as conn:
            back = conn.execute(text("SELECT city, active FROM lists ORDER BY city")).all()
    finally:
        engine.dispose()

    assert moved == [("One", "Tulsa", False), ("Two", "Dallas", True), ("Two", "Tulsa", False)]
    assert back == [("Dallas", True), ("Tulsa", False)]


def test_small_cities_are_muted_unless_switched_off_by_hand(fresh_database_url: str) -> None:
    """Step 16: cities that were off stay off (as if set by hand); the rest follow the
    fewer-than-10 rule."""
    cfg = alembic_config(fresh_database_url)
    command.upgrade(cfg, "0013")
    engine = create_engine(fresh_database_url)
    batch = "00000000-0000-0000-0000-00000000000a"
    try:
        with engine.begin() as conn:
            conn.execute(
                text("INSERT INTO batches (id, name, niche) VALUES (:id, 'One', 'Cleaning')"),
                {"id": batch},
            )
            for n in range(12):
                city = "Big" if n < 10 else "Small"
                conn.execute(
                    text(
                        "INSERT INTO leads (lead_id, batch_id, niche, city, business_name) "
                        "VALUES (:id, :batch, 'Cleaning', :city, 'X')"
                    ),
                    {"id": f"L-{n:06d}", "batch": batch, "city": city},
                )
            for n, (city, active) in enumerate((("Big", True), ("Small", True), ("Off", False))):
                conn.execute(
                    text(
                        "INSERT INTO lists (id, batch_id, city, niche, active) "
                        "VALUES (:id, :batch, :city, 'Cleaning', :active)"
                    ),
                    {
                        "id": f"00000000-0000-0000-0000-00000000000{n}",
                        "batch": batch,
                        "city": city,
                        "active": active,
                    },
                )
        command.upgrade(cfg, "0014")
        with engine.connect() as conn:
            rows = conn.execute(
                text("SELECT city, active, set_by_hand FROM lists ORDER BY city")
            ).all()
    finally:
        engine.dispose()

    assert rows == [("Big", True, False), ("Off", False, True), ("Small", False, False)]


def test_each_jobs_needs_move_into_the_batches_that_use_it(fresh_database_url: str) -> None:
    """Step 18: a batch's task gets its job's name and the needs of it this batch has."""
    cfg = alembic_config(fresh_database_url)
    command.upgrade(cfg, "0014")
    engine = create_engine(fresh_database_url)
    one, two = "00000000-0000-0000-0000-00000000000a", "00000000-0000-0000-0000-00000000000b"
    gbp, web, opp = (
        "00000000-0000-0000-0000-000000000001",
        "00000000-0000-0000-0000-000000000002",
        "00000000-0000-0000-0000-000000000003",
    )
    try:
        with engine.begin() as conn:
            for batch, name in ((one, "One"), (two, "Two")):
                conn.execute(
                    text("INSERT INTO batches (id, name, niche) VALUES (:id, :n, 'Cleaning')"),
                    {"id": batch, "n": name},
                )
            for task, key, name, needs in (
                (gbp, "gbp-audit", "GBP Audit", "[]"),
                (web, "website-audit", "Website Audit", "[]"),
                (opp, "opportunity", "Opportunity Finder", '["gbp-audit", "website-audit"]'),
            ):
                conn.execute(
                    text(
                        "INSERT INTO tasks (id, key, name, needs) "
                        "VALUES (:id, :key, :name, CAST(:needs AS jsonb))"
                    ),
                    {"id": task, "key": key, "name": name, "needs": needs},
                )
            for n, (batch, task) in enumerate(
                ((one, gbp), (one, web), (one, opp), (two, gbp), (two, opp))
            ):
                conn.execute(
                    text("INSERT INTO batch_tasks (id, batch_id, task_id) VALUES (:id, :b, :t)"),
                    {"id": f"00000000-0000-0000-0000-0000000001{n:02d}", "b": batch, "t": task},
                )
        command.upgrade(cfg, "0015")
        with engine.connect() as conn:
            moved = conn.execute(
                text(
                    "SELECT b.name, t.name, t.needs FROM batch_tasks t "
                    "JOIN batches b ON b.id = t.batch_id ORDER BY b.name, t.name"
                )
            ).all()
            columns = {c["name"] for c in inspect(conn).get_columns("tasks")}
        command.downgrade(cfg, "0014")
    finally:
        engine.dispose()

    assert moved == [
        ("One", "GBP Audit", []),
        ("One", "Opportunity Finder", ["gbp-audit", "website-audit"]),
        ("One", "Website Audit", []),
        ("Two", "GBP Audit", []),
        ("Two", "Opportunity Finder", ["gbp-audit"]),  # Two has no Website Audit
    ]
    assert "needs" not in columns and "about" not in columns
