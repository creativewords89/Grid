"""Each city's businesses kept for Top Review (step 41).

A file's cities keep their businesses (`file_cities.items`), made once when the file is
sent on to Top Review, so Top Review never reads the file or all its businesses again. The
cities of files already sent on get theirs now. No file is checked again.

Revision ID: 0029
Revises: 0028
Create Date: 2026-11-01 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0029"
down_revision: str | None = "0028"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "file_cities",
        sa.Column(
            "items", postgresql.JSONB(astext_type=sa.Text()), server_default="[]", nullable=False
        ),
    )
    op.execute(
        """
        UPDATE file_cities fc SET items = COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'key', lead->'rows'->>0,
                'rows', lead->'rows',
                'values', lead->'values',
                'extra', COALESCE(lead->'extra', '{}'::jsonb)
            ))
            FROM submissions s, jsonb_array_elements(s.leads) AS lead
            WHERE s.id = fc.submission_id
              AND jsonb_array_length(COALESCE(lead->'rows', '[]'::jsonb)) > 0
              AND lower(trim(COALESCE(lead->'values'->>'city', ''))) = fc.key
        ), '[]'::jsonb)
        FROM submissions sub
        WHERE sub.id = fc.submission_id AND sub.sent_at IS NOT NULL
          AND fc.moved_at IS NULL AND fc.muted = ''
        """
    )


def downgrade() -> None:
    op.drop_column("file_cities", "items")
