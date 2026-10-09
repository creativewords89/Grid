"""`/api/answer-log`: every answer the engine gave (SPEC section 7.5). Owners and
Reviewers can read it; only Owners can act on answers from it (build step 11)."""

import uuid
from datetime import UTC, date, datetime, time, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import ColumnElement, and_, func, or_, select

from app.answering.confidence import explain
from app.answering.gaps import group
from app.api.answers import get_answer
from app.auth.deps import CurrentUser, Db
from app.auth.tokens import now
from app.db.models import Answer, AnswerKind, AnswerOutcome, AnswerStatus, User
from app.permissions import Action, can, ensure

router = APIRouter(prefix="/answer-log", tags=["answer-log"])

PAGE_SIZE = 50
GAP_DAYS = 90


class Person(BaseModel):
    id: uuid.UUID
    name: str


class LogRow(BaseModel):
    id: uuid.UUID
    created_at: datetime
    asked_by: Person | None
    kind: str
    question: str
    confidence: int | None
    outcome: str | None
    status: str
    flagged: bool
    feedback: str | None
    source_count: int


class Stats(BaseModel):
    answers_this_month: int
    high_pct: int | None
    corrected_pct: int | None
    avg_review_minutes: int | None


class LogPage(BaseModel):
    items: list[LogRow]
    total: int
    page: int
    page_size: int
    stats: Stats
    people: list[Person]
    can_review: bool


class LogDetail(LogRow):
    retrieval_query: str
    original_text: str
    current_text: str
    sources: list[dict[str, Any]]
    confidence_parts: dict[str, Any] | None
    explanation: str
    flag_note: str | None
    model: str | None
    stop_reason: str | None
    cost_usd: float
    conversation_id: uuid.UUID | None
    can_review: bool


class GapOut(BaseModel):
    question: str
    count: int
    last_asked_at: datetime | None
    answer_ids: list[str]
    examples: list[str]


def _people(db: Db, ids: set[uuid.UUID]) -> dict[uuid.UUID, Person]:
    if not ids:
        return {}
    rows = db.execute(select(User.id, User.name).where(User.id.in_(ids))).all()
    return {row.id: Person(id=row.id, name=row.name) for row in rows}


def _row(answer: Answer, people: dict[uuid.UUID, Person]) -> dict[str, Any]:
    return {
        "id": answer.id,
        "created_at": answer.created_at,
        "asked_by": people.get(answer.asked_by) if answer.asked_by else None,
        "kind": answer.kind.value,
        "question": answer.question,
        "confidence": answer.confidence,
        "outcome": answer.outcome.value if answer.outcome else None,
        "status": answer.status.value,
        "flagged": answer.flagged,
        "feedback": answer.feedback,
        "source_count": len(answer.sources),
    }


def _month_start() -> datetime:
    today = now()
    return today.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _stats(db: Db) -> Stats:
    month = Answer.created_at >= _month_start()
    total = db.scalar(select(func.count()).select_from(Answer).where(month)) or 0
    scored = (
        db.scalar(
            select(func.count())
            .select_from(Answer)
            .where(month, Answer.outcome.in_([AnswerOutcome.HIGH, AnswerOutcome.LOW]))
        )
        or 0
    )
    high = (
        db.scalar(
            select(func.count())
            .select_from(Answer)
            .where(month, Answer.outcome == AnswerOutcome.HIGH)
        )
        or 0
    )
    corrected = (
        db.scalar(
            select(func.count())
            .select_from(Answer)
            .where(
                month,
                Answer.status.in_([AnswerStatus.CORRECTED, AnswerStatus.WRONG_NO_ANSWER]),
            )
        )
        or 0
    )
    return Stats(
        answers_this_month=total,
        high_pct=round(100 * high / scored) if scored else None,
        corrected_pct=round(100 * corrected / total) if total else None,
        avg_review_minutes=review_minutes(db),
    )


def review_minutes(db: Db) -> int | None:
    """Average time from question to review decision this month (reviews: build step 10)."""
    return None


@router.get("", response_model=LogPage)
def answer_log(
    me: CurrentUser,
    db: Db,
    outcome: Literal["high", "low", "no_answer", "unscored"] | None = None,
    status: AnswerStatus | None = None,
    flagged: bool | None = None,
    kind: AnswerKind | None = None,
    person: uuid.UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    q: Annotated[str, Query(max_length=200)] = "",
    page: Annotated[int, Query(ge=1)] = 1,
) -> LogPage:
    ensure(me, Action.VIEW_ANSWER_LOG)
    where: list[ColumnElement[bool]] = []
    if outcome == "unscored":
        where.append(Answer.outcome.is_(None))
    elif outcome:
        where.append(Answer.outcome == AnswerOutcome(outcome))
    if status:
        where.append(Answer.status == status)
    if flagged is not None:
        where.append(Answer.flagged.is_(flagged))
    if kind:
        where.append(Answer.kind == kind)
    if person:
        where.append(Answer.asked_by == person)
    if date_from:
        where.append(Answer.created_at >= datetime.combine(date_from, time.min, tzinfo=UTC))
    if date_to:
        end = datetime.combine(date_to + timedelta(days=1), time.min, tzinfo=UTC)
        where.append(Answer.created_at < end)
    if q.strip():
        pattern = (
            "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        )
        where.append(or_(Answer.question.ilike(pattern), Answer.current_text.ilike(pattern)))
    condition = and_(*where) if where else None
    count_query = select(func.count()).select_from(Answer)
    list_query = select(Answer).order_by(Answer.created_at.desc())
    if condition is not None:
        count_query = count_query.where(condition)
        list_query = list_query.where(condition)
    total = db.scalar(count_query) or 0
    answers = db.scalars(list_query.limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE)).all()

    askers = set(db.scalars(select(Answer.asked_by).where(Answer.asked_by.is_not(None)).distinct()))
    people = _people(db, {a for a in askers if a is not None})
    return LogPage(
        items=[LogRow(**_row(a, people)) for a in answers],
        total=total,
        page=page,
        page_size=PAGE_SIZE,
        stats=_stats(db),
        people=sorted(people.values(), key=lambda p: p.name.lower()),
        can_review=can(me, Action.ADMIN_REVIEW),
    )


@router.get("/gaps", response_model=list[GapOut])
def gaps(me: CurrentUser, db: Db) -> list[GapOut]:
    """Questions with no answer, or where the team knows no answer, from the last 90 days."""
    ensure(me, Action.VIEW_ANSWER_LOG)
    since = now() - timedelta(days=GAP_DAYS)
    rows = db.execute(
        select(Answer.id, Answer.question, Answer.created_at)
        .where(
            Answer.created_at >= since,
            or_(
                Answer.outcome == AnswerOutcome.NO_ANSWER,
                Answer.status == AnswerStatus.WRONG_NO_ANSWER,
            ),
        )
        .order_by(Answer.created_at.desc())
        .limit(2000)
    ).all()
    return [
        GapOut(
            question=g.question,
            count=g.count,
            last_asked_at=g.last_asked_at,
            answer_ids=g.answer_ids,
            examples=g.examples,
        )
        for g in group((str(r.id), r.question, r.created_at) for r in rows)
    ]


@router.get("/{answer_id}", response_model=LogDetail)
def answer_detail(answer_id: uuid.UUID, me: CurrentUser, db: Db) -> LogDetail:
    ensure(me, Action.VIEW_ANSWER_LOG)
    answer = get_answer(db, answer_id)
    people = _people(db, {answer.asked_by} if answer.asked_by else set())
    return LogDetail(
        **_row(answer, people),
        retrieval_query=answer.retrieval_query,
        original_text=answer.original_text,
        current_text=answer.current_text,
        sources=answer.sources,
        confidence_parts=answer.confidence_parts,
        explanation=explain(answer.confidence_parts),
        flag_note=answer.flag_note,
        model=answer.model,
        stop_reason=answer.stop_reason,
        cost_usd=float(answer.usage.get("cost_usd", 0)),
        conversation_id=answer.conversation_id,
        can_review=can(me, Action.ADMIN_REVIEW),
    )
