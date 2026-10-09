"""`/api/answers/{id}/…`: what the person who asked can do with an answer (SPEC section 8)."""

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, StringConstraints

from app.api.conversations import store_dep
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.db.models import Answer
from app.errors import ApiError
from app.kb.store import VectorStore
from app.permissions import Action, can, ensure
from app.reviews import service as reviews
from app.reviews.service import Decision, ReviewError

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


class ReplyIn(Strict):
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]


class ReplyOut(BaseModel):
    status: str


@router.post("/{answer_id}/needs-info-reply", response_model=ReplyOut)
def needs_info_reply(answer_id: uuid.UUID, body: ReplyIn, me: CurrentUser, db: Db) -> ReplyOut:
    """The asker answers a reviewer's question; the review goes back to the reviewer."""
    answer = get_answer(db, answer_id)
    if not can(me, Action.ANSWER_NEEDS_INFO, answer):
        raise ApiError(404, "not_found", "That answer doesn't exist.")
    try:
        reviews.asker_reply(db, answer, me, body.text)
    except ReviewError as error:
        raise ApiError(error.status, error.code, error.message) from None
    db.commit()
    return ReplyOut(status=answer.status.value)


class AdminReviewIn(Strict):
    action: Literal["approve", "edit", "reject", "no_answer"]
    text: Annotated[str, StringConstraints(max_length=20000)] | None = None
    note: Annotated[str, StringConstraints(max_length=2000)] | None = None
    verified_choice: Annotated[str, StringConstraints(max_length=60)] | None = None


class AdminReviewOut(BaseModel):
    status: str
    current_text: str
    review_number: int


@router.post("/{answer_id}/admin-review", response_model=AdminReviewOut)
def admin_review(
    answer_id: uuid.UUID,
    body: AdminReviewIn,
    me: CurrentUser,
    db: Db,
    store: Annotated[VectorStore | None, Depends(store_dep)],
) -> AdminReviewOut:
    """The Owner approves, corrects or rejects any answer, high or low (SPEC 6.7, 7.5)."""
    ensure(me, Action.ADMIN_REVIEW)
    answer = get_answer(db, answer_id)
    decision = Decision(body.action, body.text, body.note, verified_choice=body.verified_choice)
    try:
        done = reviews.admin_decide(db, answer, me, decision, store)
    except ReviewError as error:
        db.rollback()
        raise ApiError(error.status, error.code, error.message, details=error.details) from None
    db.commit()
    return AdminReviewOut(
        status=answer.status.value,
        current_text=answer.current_text,
        review_number=done.review.number,
    )
