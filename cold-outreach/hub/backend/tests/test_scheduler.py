import threading

import pytest
from sqlalchemy import Engine, create_engine

from app import scheduler


def test_tick_reaches_the_database(engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(scheduler, "get_engine", lambda: engine)

    assert scheduler.tick() is True


def test_tick_survives_an_unreachable_database(monkeypatch: pytest.MonkeyPatch) -> None:
    dead = create_engine(
        "postgresql+psycopg://nobody:nothing@127.0.0.1:1/none",
        connect_args={"connect_timeout": 1},
    )
    monkeypatch.setattr(scheduler, "get_engine", lambda: dead)

    assert scheduler.tick() is False


def test_run_ticks_until_stopped(monkeypatch: pytest.MonkeyPatch) -> None:
    stop = threading.Event()
    ticks: list[int] = []

    def fake_tick() -> bool:
        ticks.append(1)
        stop.set()  # the first pass asks the loop to end
        return True

    monkeypatch.setattr(scheduler, "tick", fake_tick)
    monkeypatch.setattr(scheduler, "check_files", lambda stop: None)

    scheduler.run(stop)

    assert ticks == [1]
