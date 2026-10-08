"""Daily Claude usage per person and kind (SPEC section 9.5)."""

import uuid
from dataclasses import dataclass

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.ai.pricing import cost_usd
from app.auth.tokens import now
from app.db.models import UsageDaily, UsageKind


@dataclass
class Usage:
    requests: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0

    def add(self, model: str, input_tokens: int, output_tokens: int) -> None:
        self.requests += 1
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens
        self.cost_usd += cost_usd(model, input_tokens, output_tokens)


def record(db: Session, user_id: uuid.UUID | None, kind: UsageKind, usage: Usage) -> None:
    if not usage.requests:
        return
    stmt = insert(UsageDaily).values(
        date=now().date(),
        user_id=user_id,
        kind=kind,
        requests=usage.requests,
        tokens_in=usage.input_tokens,
        tokens_out=usage.output_tokens,
        cost_usd=usage.cost_usd,
    )
    db.execute(
        stmt.on_conflict_do_update(
            index_elements=[UsageDaily.date, UsageDaily.user_id, UsageDaily.kind],
            set_={
                "requests": UsageDaily.requests + stmt.excluded.requests,
                "tokens_in": UsageDaily.tokens_in + stmt.excluded.tokens_in,
                "tokens_out": UsageDaily.tokens_out + stmt.excluded.tokens_out,
                "cost_usd": UsageDaily.cost_usd + stmt.excluded.cost_usd,
            },
        )
    )
