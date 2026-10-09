"""Server commands: `python -m app.cli create-owner --email … --name …` (SPEC section 13.4)."""

import argparse
import getpass
import sys

from email_validator import EmailNotValidError, validate_email
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.passwords import hash_password, password_problem
from app.db.models import Role, User
from app.db.session import get_engine


def _read_password(from_stdin: bool, email: str) -> str:
    if from_stdin:
        password = sys.stdin.readline().rstrip("\n")
    else:
        password = getpass.getpass("Password: ")
        if getpass.getpass("Repeat password: ") != password:
            raise SystemExit("The passwords don't match.")
    problem = password_problem(password, email)
    if problem:
        raise SystemExit(problem)
    return password


def create_owner(email: str, name: str, password_from_stdin: bool) -> None:
    try:
        email = validate_email(email.strip(), check_deliverability=False).normalized.lower()
    except EmailNotValidError as exc:
        raise SystemExit(f"Invalid email: {exc}") from exc
    name = name.strip()
    if not name:
        raise SystemExit("Name is required.")
    with Session(get_engine()) as db:
        if db.scalar(select(User.id).where(User.email == email)) is not None:
            raise SystemExit(f"{email} already has an account.")
        password = _read_password(password_from_stdin, email)
        db.add(User(email=email, name=name, role=Role.OWNER, password_hash=hash_password(password)))
        db.commit()
    print(f"Owner {name} <{email}> created. They can sign in now.")


def setup_pinecone() -> None:
    from app.config import get_settings
    from app.kb.store import PineconeStore

    settings = get_settings()
    if not settings.pinecone_api_key:
        raise SystemExit("Set PINECONE_API_KEY in .env first.")
    store = PineconeStore(settings.pinecone_api_key, settings.pinecone_index)
    print(
        store.ensure_index(
            settings.pinecone_cloud, settings.pinecone_region, settings.pinecone_embed_model
        )
    )
    print("Optional: put that host in .env as PINECONE_HOST.")
    print("Next: Settings → Knowledge base → Rebuild sends every document to it.")


def setup_telegram() -> None:
    """Point Telegram at our webhook, with the secret it must send (SPEC section 6.7)."""
    from app import settings_store
    from app.config import get_settings
    from app.reviews.telegram import TelegramError, get_telegram

    settings = get_settings()
    telegram = get_telegram()
    if telegram is None:
        raise SystemExit("Set TELEGRAM_BOT_TOKEN in .env first.")
    if len(settings.telegram_webhook_secret) < 16:
        raise SystemExit("Set TELEGRAM_WEBHOOK_SECRET in .env to a random value (16+ characters).")
    if not settings.app_url.startswith("https://"):
        raise SystemExit("APP_URL must be the https:// address of the Answer Engine.")
    url = settings.link("/api/telegram/webhook")
    try:
        telegram.set_webhook(url, settings.telegram_webhook_secret)
        username = telegram.bot_username()
    except TelegramError as error:
        raise SystemExit(str(error)) from None
    with Session(get_engine()) as db:
        settings_store.put(db, "telegram_bot_username", username)
        db.commit()
    print(f"Webhook set to {url} for @{username}.")
    print("Next: add the bot to your private review group, then choose the group in")
    print("Settings → Reviews (Detect group).")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    commands = parser.add_subparsers(dest="command", required=True)
    owner = commands.add_parser("create-owner", help="create an Owner account")
    owner.add_argument("--email", required=True)
    owner.add_argument("--name", required=True)
    owner.add_argument(
        "--password-stdin", action="store_true", help="read the password from standard input"
    )
    commands.add_parser("setup-pinecone", help="create the Pinecone index if it doesn't exist")
    commands.add_parser("setup-telegram", help="register the review bot's webhook")
    args = parser.parse_args(argv)
    if args.command == "create-owner":
        create_owner(args.email, args.name, args.password_stdin)
    elif args.command == "setup-pinecone":
        setup_pinecone()
    elif args.command == "setup-telegram":
        setup_telegram()


if __name__ == "__main__":
    main()
