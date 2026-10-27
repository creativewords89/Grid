"""Password hashing (Argon2id) and the password rules of SPEC section 4."""

from functools import lru_cache
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

MIN_LENGTH = 10
MAX_LENGTH = 256

_hasher = PasswordHasher()  # Argon2id with the library's recommended parameters

# Verified when the email is unknown, so a wrong email takes as long as a wrong password.
_DUMMY_HASH = _hasher.hash("dummy password that never matches")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


@lru_cache
def _common_passwords() -> frozenset[str]:
    path = Path(__file__).with_name("common-passwords.txt")
    lines = path.read_text(encoding="utf-8").splitlines()
    return frozenset(line.strip().lower() for line in lines if line and not line.startswith("#"))


def password_problem(password: str, email: str = "") -> str | None:
    """A sentence explaining why the password is refused, or None when it is fine."""
    if len(password) < MIN_LENGTH:
        return f"Use at least {MIN_LENGTH} characters."
    if len(password) > MAX_LENGTH:
        return f"Use at most {MAX_LENGTH} characters."
    lowered = password.lower()
    if lowered in _common_passwords():
        return "That password is too common. Choose something harder to guess."
    local_part = email.split("@", 1)[0].lower()
    if local_part and lowered in (local_part, email.lower()):
        return "Don't use your email address as your password."
    return None
