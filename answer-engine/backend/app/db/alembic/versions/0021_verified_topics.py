"""Topics on verified answers, to group the Verified Answers page (step 30).

Answers approved in the Question Bank take their thread's topic and subtopic.

Revision ID: 0021
Revises: 0020
Create Date: 2026-11-12 12:00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "verified_answers", sa.Column("topic", sa.Text(), nullable=False, server_default="")
    )
    op.add_column(
        "verified_answers", sa.Column("subtopic", sa.Text(), nullable=False, server_default="")
    )
    op.execute(
        "UPDATE verified_answers v SET topic = left(t.topic, 100), "
        "subtopic = left(t.subtopic, 100) "
        "FROM fb_threads t JOIN question_sets s ON s.id = t.set_id "
        "WHERE v.answer_group = s.prefix || ':' || t.key"
    )


def downgrade() -> None:
    op.drop_column("verified_answers", "subtopic")
    op.drop_column("verified_answers", "topic")
