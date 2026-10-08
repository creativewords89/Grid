"""Original uploads on disk under random names (SPEC section 2)."""

import hashlib
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from app.auth.tokens import now
from app.config import get_settings

CHUNK = 1024 * 1024


class TooLarge(ValueError):
    pass


@dataclass
class Received:
    temp_path: Path
    size: int
    sha256: str


def root() -> Path:
    return Path(get_settings().upload_dir)


def absolute(storage_path: str) -> Path:
    path = (root() / storage_path).resolve()
    if not path.is_relative_to(root().resolve()):  # never leave the upload folder
        raise ValueError("bad storage path")
    return path


def receive(stream: BinaryIO, max_bytes: int) -> Received:
    """Copy an upload into a temporary file, hashing it, refusing anything over max_bytes."""
    tmp_dir = root() / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    temp_path = tmp_dir / uuid.uuid4().hex
    digest = hashlib.sha256()
    size = 0
    try:
        with temp_path.open("wb") as out:
            while chunk := stream.read(CHUNK):
                size += len(chunk)
                if size > max_bytes:
                    raise TooLarge
                digest.update(chunk)
                out.write(chunk)
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise
    return Received(temp_path, size, digest.hexdigest())


def keep(received: Received) -> str:
    """Move a received upload to its permanent place; returns the relative storage path."""
    today = now()
    relative = Path(f"{today:%Y}") / f"{today:%m}" / uuid.uuid4().hex
    target = root() / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(received.temp_path, target)
    return relative.as_posix()


def remove(storage_path: str) -> None:
    absolute(storage_path).unlink(missing_ok=True)
