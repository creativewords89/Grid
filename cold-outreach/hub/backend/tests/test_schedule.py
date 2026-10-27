"""When scheduled runs are due (SPEC section 6.3), including daylight-saving days."""

from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.runs import schedule

DHAKA = "Asia/Dhaka"  # UTC+6, no daylight saving
NEW_YORK = "America/New_York"


def at(text: str, zone: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=ZoneInfo(zone))


@pytest.mark.parametrize(
    ("when", "due"),
    [
        ("2026-10-27 01:59", None),  # before the run time
        ("2026-10-27 02:00", date(2026, 10, 27)),  # the window opens
        ("2026-10-27 07:59", date(2026, 10, 27)),  # still inside the 6-hour window
        ("2026-10-27 08:00", None),  # the window closed: switching on now waits for tomorrow
    ],
)
def test_the_six_hour_window(when: str, due: date | None) -> None:
    assert schedule.due_day(at(when, DHAKA), "02:00", DHAKA) == due


def test_a_window_can_cross_midnight() -> None:
    # Run time 22:00: at 01:00 the next day, the previous day's run is still due.
    assert schedule.due_day(at("2026-10-28 01:00", DHAKA), "22:00", DHAKA) == date(2026, 10, 27)
    assert schedule.due_day(at("2026-10-28 04:00", DHAKA), "22:00", DHAKA) is None


def test_the_agents_time_zone_decides() -> None:
    utc_moment = datetime(2026, 10, 26, 20, 30, tzinfo=UTC)  # 02:30 in Dhaka, 16:30 in NY

    assert schedule.due_day(utc_moment, "02:00", DHAKA) == date(2026, 10, 27)
    assert schedule.due_day(utc_moment, "02:00", NEW_YORK) is None


def test_a_run_time_in_the_spring_gap_runs_after_it() -> None:
    # 8 March 2026: New York clocks jump from 02:00 to 03:00, so 02:30 never happens.
    start = schedule.local_start(date(2026, 3, 8), "02:30", ZoneInfo(NEW_YORK))

    assert start.astimezone(UTC) == datetime(2026, 3, 8, 7, 30, tzinfo=UTC)  # 03:30 EDT
    assert schedule.due_day(start, "02:30", NEW_YORK) == date(2026, 3, 8)


def test_a_run_time_in_the_repeated_autumn_hour_runs_once_at_the_first() -> None:
    # 1 November 2026: the hour from 01:00 to 02:00 happens twice in New York.
    start = schedule.local_start(date(2026, 11, 1), "01:30", ZoneInfo(NEW_YORK))

    assert start.astimezone(UTC) == datetime(2026, 11, 1, 5, 30, tzinfo=UTC)  # 01:30 EDT
    an_hour_later = start + timedelta(hours=1)  # 01:30 EST, the second time round
    assert schedule.due_day(an_hour_later, "01:30", NEW_YORK) == date(2026, 11, 1)


def test_clock_change_days_are_23_and_25_hours() -> None:
    spring_start, spring_end = schedule.day_bounds(date(2026, 3, 8), NEW_YORK)
    autumn_start, autumn_end = schedule.day_bounds(date(2026, 11, 1), NEW_YORK)

    # Measured in UTC: Python subtracts two times in the same zone by wall clock.
    assert spring_end.astimezone(UTC) - spring_start.astimezone(UTC) == timedelta(hours=23)
    assert autumn_end.astimezone(UTC) - autumn_start.astimezone(UTC) == timedelta(hours=25)


@pytest.mark.parametrize(
    ("when", "done_today", "expected"),
    [
        ("2026-10-27 01:00", False, "2026-10-27 02:00"),  # later today
        ("2026-10-27 03:00", False, "2026-10-27 03:00"),  # due now
        ("2026-10-27 03:00", True, "2026-10-28 02:00"),  # today's already ran
        ("2026-10-27 09:00", False, "2026-10-28 02:00"),  # today's window closed
    ],
)
def test_next_run(when: str, done_today: bool, expected: str) -> None:
    result = schedule.next_run_at(at(when, DHAKA), "02:00", DHAKA, done_today)

    assert result == at(expected, DHAKA)
