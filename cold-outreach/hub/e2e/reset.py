"""Make a fresh, empty database for the end-to-end tests and save the setup code for the
first Owner, so the tests start where a new install starts.

Run by serve.sh from the backend folder: PYTHONPATH=. uv run python ../e2e/reset.py <file>
DATABASE_URL names the database to (re)create; its user must be allowed to create databases.
"""

import os
import sys

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from app.api.setup import setup_code


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

    with open(sys.argv[1], "w", encoding="utf-8") as file:
        file.write(setup_code())


if __name__ == "__main__":
    main()
