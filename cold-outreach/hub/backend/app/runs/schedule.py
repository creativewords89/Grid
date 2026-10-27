"""When runs are due (SPEC section 6.3). Pure functions over times, so the edge cases
(time zones, daylight saving) are easy to test.

An agent's scheduled run is due on a local day once its run time has passed, until
CATCH_UP after it, if it hasn't had a scheduled run that local day. The window means
switching an agent on in the afternoon doesn't start a run at once: the first one comes at
the next run time. If the Hub was down for the whole window, that day is skipped.
"""

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

CATCH_UP = timedelta(hours=6)


def parse_run_time(value: str) -> time:
    hours, minutes = value.split(":")
    return time(int(hours), int(minutes))


def local_start(day: date, run_time: str, zone: ZoneInfo) -> datetime:
    """The moment the run time comes round on `day`, as an aware datetime.

    A run time inside a daylight-saving gap (02:30 when clocks jump from 02:00 to 03:00) is
    read with the offset from before the jump, so it lands an hour later (03:30). In a
    repeated hour (clocks going back) the first of the two moments is used.
    """
    naive = datetime.combine(day, parse_run_time(run_time))
    aware = naive.replace(tzinfo=zone, fold=0)
    # Round-tripping through UTC shows whether the wall-clock time exists that day.
    back = aware.astimezone(ZoneInfo("UTC")).astimezone(zone)
    if back.replace(tzinfo=None) != naive:  # inside a gap
        return back
    return aware


def due_day(now: datetime, run_time: str, time_zone: str) -> date | None:
    """The local day whose run is due at `now`, or None when no window is open."""
    zone = ZoneInfo(time_zone)
    today = now.astimezone(zone).date()
    for day in (today, today - timedelta(days=1)):  # a window can cross midnight
        start = local_start(day, run_time, zone)
        if start <= now < start + CATCH_UP:
            return day
    return None


def day_bounds(day: date, time_zone: str) -> tuple[datetime, datetime]:
    """Start and end of a local calendar day (23 or 25 hours long on clock-change days)."""
    zone = ZoneInfo(time_zone)
    start = datetime.combine(day, time(0), tzinfo=zone)
    end = datetime.combine(day + timedelta(days=1), time(0), tzinfo=zone)
    return start, end


def today_bounds(now: datetime, time_zone: str) -> tuple[datetime, datetime]:
    return day_bounds(now.astimezone(ZoneInfo(time_zone)).date(), time_zone)


def next_run_at(now: datetime, run_time: str, time_zone: str, done_today: bool) -> datetime:
    """When the next scheduled run will start (for the screen)."""
    zone = ZoneInfo(time_zone)
    day = due_day(now, run_time, time_zone)
    if day is not None and not done_today:
        return now  # due now: the scheduler queues it within a minute
    today = now.astimezone(zone).date()
    for offset in range(3):
        start = local_start(today + timedelta(days=offset), run_time, zone)
        if start > now and (offset > 0 or not done_today):
            return start
    return local_start(today + timedelta(days=3), run_time, zone)  # pragma: no cover
