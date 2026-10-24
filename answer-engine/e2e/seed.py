"""Make a fresh database for the end-to-end tests, with two people and a review group.

Run by serve.sh from the backend folder: PYTHONPATH=. uv run python ../e2e/seed.py
DATABASE_URL names the database to (re)create; the server's user must be allowed to
create databases.
"""

import os

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app import settings_store
from app.auth.passwords import hash_password
from app.db.models import Role, User

OWNER = ("olivia@example.com", "Olivia", "olivia owner passphrase")
REVIEWER = ("ali@example.com", "Ali", "ali reviewer passphrase")
REVIEWER_TELEGRAM_ID = 5001
GROUP = -100777


def main() -> None:
    url = make_url(os.environ["DATABASE_URL"])
    name = url.database
    assert name and name.endswith("_e2e"), "refusing to reset a database not named *_e2e"
    admin = create_engine(url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    admin.dispose()

    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", url.render_as_string(hide_password=False))
    command.upgrade(config, "head")

    with Session(create_engine(url)) as db:
        db.add(
            User(
                email=OWNER[0],
                name=OWNER[1],
                role=Role.OWNER,
                password_hash=hash_password(OWNER[2]),
            )
        )
        db.add(
            User(
                email=REVIEWER[0],
                name=REVIEWER[1],
                role=Role.REVIEWER,
                password_hash=hash_password(REVIEWER[2]),
                telegram_user_id=REVIEWER_TELEGRAM_ID,
            )
        )
        settings_store.put(db, "telegram_group_chat_id", GROUP)
        settings_store.put(db, "telegram_seen_chats", [{"id": GROUP, "title": "GR reviewers"}])
        db.commit()
    print(f"e2e database {name} ready")


if __name__ == "__main__":
    main()
