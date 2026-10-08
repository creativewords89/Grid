import pytest

from app.auth.passwords import hash_password, needs_rehash, password_problem, verify_password


def test_hash_is_argon2id_and_verifies() -> None:
    hashed = hash_password("a perfectly fine passphrase")

    assert hashed.startswith("$argon2id$")
    assert verify_password(hashed, "a perfectly fine passphrase")
    assert not verify_password(hashed, "a perfectly fine passphrasE")
    assert not needs_rehash(hashed)


def test_missing_or_broken_hash_never_verifies() -> None:
    assert not verify_password(None, "anything at all")
    assert not verify_password("not-a-hash", "anything at all")


@pytest.mark.parametrize(
    ("password", "problem"),
    [
        ("short", "Use at least 10 characters."),
        ("x" * 257, "Use at most 256 characters."),
        ("1234567890", "That password is too common. Choose something harder to guess."),
        ("Qwertyuiop", "That password is too common. Choose something harder to guess."),
        ("Password123", "That password is too common. Choose something harder to guess."),
        ("sara.ahmed", "Don't use your email address as your password."),
        ("Sara.Ahmed@example.com", "Don't use your email address as your password."),
    ],
)
def test_refused_passwords(password: str, problem: str) -> None:
    assert password_problem(password, "sara.ahmed@example.com") == problem


def test_good_password_passes() -> None:
    assert password_problem("blue kettle on mondays", "sara@example.com") is None
