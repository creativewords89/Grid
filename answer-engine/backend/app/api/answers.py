"""`/api/answers/{id}/…`: what the person who asked can do with an answer (SPEC section 8)."""

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter
from pydantic import BaseModel, StringConstraints

from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.db.models import Answer
from app.errors import ApiError
from app.permissions import Action, can

router = APIRouter(prefix="/answers", tags=["answers"])


class FeedbackIn(Strict):
    value: Literal["up", "down", "none"]
    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)] | None = None


class FeedbackOut(BaseModel):
    feedback: str | None
    flagged: bool


def get_answer(db: Db, answer_id: uuid.UUID) -> Answer:
    answer = db.get(Answer, answer_id)
    if answer is None:
        raise ApiError(404, "not_found", "That answer doesn't exist.")
    return answer


@router.post("/{answer_id}/feedback", response_model=FeedbackOut)
def feedback(answer_id: uuid.UUID, body: FeedbackIn, me: CurrentUser, db: Db) -> FeedbackOut:
    """👍 / 👎 on an answer the person received. 👎 flags it for the Owner (SPEC 6.7)."""
    answer = get_answer(db, answer_id)
    if not can(me, Action.GIVE_FEEDBACK, answer):
        # Someone else's answer looks like a missing one: ids aren't secret, answers are.
        raise ApiError(404, "not_found", "That answer doesn't exist.")
    answer.feedback = None if body.value == "none" else body.value
    answer.flagged = body.value == "down"
    answer.flag_note = (body.note or None) if body.value == "down" else None
    db.commit()
    return FeedbackOut(feedback=answer.feedback, flagged=answer.flagged)
