"""Owner-editable settings with their defaults (SPEC section 10). The Settings screen that
edits them arrives in build step 14; until then the defaults apply."""

from typing import Any

from sqlalchemy.orm import Session

from app.db.models import Setting

DEFAULTS: dict[str, Any] = {
    "max_upload_mb": 50,
    "max_batch_files": 20,
    "trash_days": 30,
}


def get(db: Session, key: str) -> Any:
    row = db.get(Setting, key)
    return row.value if row is not None else DEFAULTS[key]


def get_int(db: Session, key: str) -> int:
    return int(get(db, key))
