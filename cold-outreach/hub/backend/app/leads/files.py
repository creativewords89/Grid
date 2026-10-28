"""Files agents save for leads, such as audit reports (SPEC section 6.4).

The bytes are kept on disk under REPORTS_DIR, at `<lead_id>/<file id>`: neither part comes
from what the agent sent, so a name can't reach outside the folder. The backup service
archives the folder with the database.
"""

import re
import uuid
from pathlib import Path

from app.config import get_settings

MAX_BYTES = 20 * 1024 * 1024
# Only kinds a browser won't run: they are always downloaded, never shown inline.
CONTENT_TYPES = {
    "application/pdf": ".pdf",
    "application/json": ".json",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "text/csv": ".csv",
}
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")


def root() -> Path:
    return Path(get_settings().reports_dir)


def path_of(lead_id: str, file_id: uuid.UUID) -> Path:
    if not re.fullmatch(r"L-\d{6,9}", lead_id):
        raise ValueError("not a Lead ID")
    return root() / lead_id / str(file_id)


def write(lead_id: str, file_id: uuid.UUID, content: bytes) -> None:
    target = path_of(lead_id, file_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(".part")
    partial.write_bytes(content)
    partial.replace(target)


def remove(lead_id: str, file_id: uuid.UUID) -> None:
    path_of(lead_id, file_id).unlink(missing_ok=True)
