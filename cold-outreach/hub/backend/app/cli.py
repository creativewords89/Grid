"""Server commands (SPEC section 4):

python -m app.cli setup-code                              the code for the first Owner
python -m app.cli create-owner --email … --name …         an Owner without the website
"""

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


def setup_code() -> None:
    from app.api.setup import needed
    from app.api.setup import setup_code as code

    with Session(get_engine()) as db:
        if not needed(db):
            raise SystemExit("The Owner account already exists: sign in on the website.")
    print(f"Setup code: {code()}")
    print("Open the website and enter it on the Create the Owner account page.")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    commands = parser.add_subparsers(dest="command", required=True)
    owner = commands.add_parser("create-owner", help="create an Owner account")
    owner.add_argument("--email", required=True)
    owner.add_argument("--name", required=True)
    owner.add_argument(
        "--password-stdin", action="store_true", help="read the password from standard input"
    )
    commands.add_parser("setup-code", help="show the code for creating the first Owner online")
    args = parser.parse_args(argv)
    if args.command == "create-owner":
        create_owner(args.email, args.name, args.password_stdin)
    elif args.command == "setup-code":
        setup_code()


if __name__ == "__main__":
    main()
