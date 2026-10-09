"""`/api/reviews`: the web Review Queue (SPEC sections 6.7 and 7.6), for Owners and
Reviewers. It uses the same review functions as the Telegram bot."""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, StringConstraints
from sqlalchemy import func, select

from app.api.answer_log import Person
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.db.models import UNDECIDED, Review, ReviewState, User
from app.errors import ApiError
from app.permissions import Action, ensure
from app.reviews import service
from app.reviews.service import Decision, ReviewError

router = APIRouter(prefix="/reviews", tags=["reviews"])


class ReviewRow(BaseModel):
    id: uuid.UUID
    number: int
    reason: str
    reason_label: str
    state: str
    created_at: datetime
    question: str
    kind: str
    asked_by: Person | None
    claimed_by: Person | None
    answer_id: uuid.UUID


class ReviewNote(BaseModel):
    kind: str
    author: Person | None
    body: str
    created_at: datetime


class ReviewDetail(ReviewRow):
    original_text: str
    current_text: str
    sources: list[dict[str, Any]]
    confidence: int | None
    explanation: str
    unsupported_claims: list[str]
    no_answer: bool
    notes: list[ReviewNote]
    decided_by: Person | None
    decided_at: datetime | None
    final_text: str | None
    note: str | None
    mine: bool


class DecideIn(Strict):
    action: Literal["approve", "edit", "reject", "no_answer", "needs_info"]
    text: Annotated[str, StringConstraints(max_length=20000)] | None = None
    note: Annotated[str, StringConstraints(max_length=2000)] | None = None


class CountOut(BaseModel):
    waiting: int


def _people(db: Db, *ids: uuid.UUID | None) -> dict[uuid.UUID, Person]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    rows = db.execute(select(User.id, User.name).where(User.id.in_(wanted))).all()
    return {r.id: Person(id=r.id, name=r.name) for r in rows}


def _row(review: Review, people: dict[uuid.UUID, Person]) -> dict[str, Any]:
    answer = review.answer
    return {
        "id": review.id,
        "number": review.number,
        "reason": review.reason.value,
        "reason_label": service.reason_label(review),
        "state": review.state.value,
        "created_at": review.created_at,
        "question": answer.question,
        "kind": answer.kind.value,
        "asked_by": people.get(answer.asked_by) if answer.asked_by else None,
        "claimed_by": people.get(review.claimed_by) if review.claimed_by else None,
        "answer_id": answer.id,
    }


def _raise(error: ReviewError) -> ApiError:
    return ApiError(error.status, error.code, error.message)


@router.get("", response_model=list[ReviewRow])
def list_reviews(
    me: CurrentUser, db: Db, show: Literal["waiting", "mine", "decided"] = "waiting"
) -> list[ReviewRow]:
    """Waiting reviews oldest first; or mine; or the last 100 decided."""
    ensure(me, Action.DECIDE_REVIEW)
    query = select(Review)
    if show == "decided":
        query = query.where(Review.state.not_in(UNDECIDED)).order_by(Review.decided_at.desc())
    elif show == "mine":
        query = query.where(Review.state.in_(UNDECIDED), Review.claimed_by == me.id)
        query = query.order_by(Review.created_at)
    else:
        query = query.where(Review.state.in_(UNDECIDED)).order_by(Review.created_at)
    reviews = db.scalars(query.limit(100)).all()
    people = _people(db, *[r.answer.asked_by for r in reviews], *[r.claimed_by for r in reviews])
    return [ReviewRow(**_row(r, people)) for r in reviews]


@router.get("/count", response_model=CountOut)
def count(me: CurrentUser, db: Db) -> CountOut:
    """For the badge in the sidebar: reviews waiting on reviewers (not on the asker)."""
    ensure(me, Action.DECIDE_REVIEW)
    waiting = db.scalar(
        select(func.count())
        .select_from(Review)
        .where(Review.state.in_([ReviewState.OPEN, ReviewState.CLAIMED]))
    )
    return CountOut(waiting=waiting or 0)


def detail(db: Db, review: Review, me: User) -> ReviewDetail:
    answer = review.answer
    authors = [n.author_id for n in review.messages]
    people = _people(db, answer.asked_by, review.claimed_by, review.decided_by, *authors)
    parts = answer.confidence_parts or {}
    return ReviewDetail(
        **_row(review, people),
        original_text=answer.original_text,
        current_text=answer.current_text,
        sources=answer.sources,
        confidence=answer.confidence,
        explanation=service.explanation(review),
        unsupported_claims=list(parts.get("unsupported_claims", [])),
        no_answer=answer.outcome is not None and answer.outcome.value == "no_answer",
        notes=[
            ReviewNote(
                kind=n.kind.value,
                author=people.get(n.author_id) if n.author_id else None,
                body=n.body,
                created_at=n.created_at,
            )
            for n in review.messages
        ],
        decided_by=people.get(review.decided_by) if review.decided_by else None,
        decided_at=review.decided_at,
        final_text=review.final_text,
        note=review.note,
        mine=review.claimed_by == me.id,
    )


def _get(db: Db, review_id: uuid.UUID) -> Review:
    review = db.get(Review, review_id)
    if review is None:
        raise ApiError(404, "not_found", "That review doesn't exist.")
    return review


@router.get("/{review_id}", response_model=ReviewDetail)
def get_review(review_id: uuid.UUID, me: CurrentUser, db: Db) -> ReviewDetail:
    ensure(me, Action.DECIDE_REVIEW)
    return detail(db, _get(db, review_id), me)


@router.post("/{review_id}/claim", response_model=ReviewDetail)
def claim(review_id: uuid.UUID, me: CurrentUser, db: Db) -> ReviewDetail:
    ensure(me, Action.DECIDE_REVIEW)
    try:
        review = service.claim(db, review_id, me)
    except ReviewError as error:
        raise _raise(error) from None
    db.commit()
    return detail(db, review, me)


@router.post("/{review_id}/release", response_model=ReviewDetail)
def release(review_id: uuid.UUID, me: CurrentUser, db: Db) -> ReviewDetail:
    ensure(me, Action.DECIDE_REVIEW)
    try:
        review = service.release(db, review_id, me)
    except ReviewError as error:
        raise _raise(error) from None
    db.commit()
    return detail(db, review, me)


@router.post("/{review_id}/decide", response_model=ReviewDetail)
def decide(review_id: uuid.UUID, body: DecideIn, me: CurrentUser, db: Db) -> ReviewDetail:
    ensure(me, Action.DECIDE_REVIEW)
    try:
        review = service.decide(db, review_id, me, Decision(body.action, body.text, body.note))
    except ReviewError as error:
        db.rollback()
        raise _raise(error) from None
    db.commit()
    db.refresh(review)
    return detail(db, review, me)
