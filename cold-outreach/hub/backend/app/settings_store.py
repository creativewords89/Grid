"""Values kept in the `settings` table, with their defaults (SPEC section 5)."""

from typing import Any

from sqlalchemy.orm import Session

from app.db.models import Setting

DEFAULTS: dict[str, Any] = {
    # Keys and accounts from the Connections screen, each value encrypted
    # (`app/connections.py`).
    "connections": {},
    # The last Test result per connection: {group: {ok, message, at}}.
    "connection_tests": {},
    # The most all agents together may spend in a day, in the Hub's time zone (SPEC 6.3).
    "daily_total_budget_usd": "20.00",
    # The Hub's own time zone: "today" for the total budget and the Overview.
    "time_zone": "Asia/Dhaka",
    # Alerts (SPEC section 6.6).
    "alerts_telegram": True,  # send alerts to the Telegram group
    "daily_summary": True,  # a morning summary in the Telegram group
    "daily_summary_time": "08:00",  # in the Hub's time zone
    "low_balance_usd": "10.00",  # DataForSEO balance that raises an alert
    # Bookkeeping for the scheduler's once-a-day jobs.
    "last_summary_date": None,
    "last_balance_check_date": None,
    "last_backup_check_date": None,
}


def get(db: Session, key: str) -> Any:
    row = db.get(Setting, key)
    return row.value if row is not None else DEFAULTS[key]


def put(db: Session, key: str, value: Any) -> None:
    """Store a value in the current transaction (the caller commits and audits)."""
    row = db.get(Setting, key)
    if row is None:
        db.add(Setting(key=key, value=value))
    else:
        row.value = value
