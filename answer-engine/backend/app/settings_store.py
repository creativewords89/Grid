"""Settings with their defaults (SPEC section 10). The Owner edits most of them in Settings
(`app/api/settings.py` lists which); the rest keep their defaults."""

from typing import Any

from sqlalchemy.orm import Session

from app.db.models import Setting

DEFAULTS: dict[str, Any] = {
    "max_upload_mb": 50,
    "max_batch_files": 20,
    "trash_days": 30,
    # Answering (SPEC section 6.5)
    "docs_top_k": 20,
    "rerank_top_n": 8,
    "min_relevance": 0.20,
    "rerank_model": "bge-reranker-v2-m3",
    # Confidence (SPEC section 6.6)
    "confidence_threshold": 75,
    "confidence_weights": {"retrieval": 0.4, "support": 0.6},
    # Verified answers (SPEC sections 6.5 and 6.9)
    "verified_match": 0.90,
    "verified_top_k": 3,
    # Reviews (SPEC section 6.7)
    "review_reminder_hours": 4,
    "review_escalation_hours": 24,
    "telegram_group_chat_id": None,
    "telegram_bot_username": "",
    "telegram_seen_chats": [],
    # Marketing (SPEC section 6.10)
    "thread_auto_close_days": 14,
    # Limits and answering (SPEC sections 7.8, 9.1 and 9.5). A model of None uses the
    # server's .env setting.
    "questions_per_user_per_day": 200,
    "monthly_cost_alert_usd": 100,
    "answer_model": None,
    "rewrite_model": None,
    "check_model": None,
    "answer_effort": "medium",
    # API keys and connection details from Settings → Connections, encrypted
    # (`app/connections.py`).
    "connections": {},
}


def get(db: Session, key: str) -> Any:
    row = db.get(Setting, key)
    return row.value if row is not None else DEFAULTS[key]


def get_int(db: Session, key: str) -> int:
    return int(get(db, key))


def get_float(db: Session, key: str) -> float:
    return float(get(db, key))


def put(db: Session, key: str, value: Any) -> None:
    """Store a value in the current transaction (the caller commits and audits)."""
    row = db.get(Setting, key)
    if row is None:
        db.add(Setting(key=key, value=value))
    else:
        row.value = value


def get_dict(db: Session, key: str) -> dict[str, Any]:
    value = get(db, key)
    return dict(value) if isinstance(value, dict) else dict(DEFAULTS[key])
