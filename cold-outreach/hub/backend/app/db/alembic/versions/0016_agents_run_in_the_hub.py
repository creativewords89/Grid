"""Agents that run in the Hub (step 25).

An agent made in the Hub from a built-in kind (`kind`, e.g. "demo") is run by the Hub's
`agents` service: no token to copy, nothing to start on the server. Agents added the old way
(a token and a container of their own) keep `kind` empty.

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-29 09:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("agents", sa.Column("kind", sa.String(length=40), nullable=True))


def downgrade() -> None:
    op.drop_column("agents", "kind")
