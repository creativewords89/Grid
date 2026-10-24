"""`GET /api/updates?since=`: what changed for this person (SPEC section 2, "Live updates").

The app polls it every 15 seconds while its tab is visible. It answers with a new cursor
and only small facts; the screens reload what they show when something they show changed.
"""

import uuid
from datetime import datetime

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import func, select

from app.api.notifications import NotificationOut, out, unread_count
from app.auth.deps import CurrentUser, Db
from app.auth.tokens import now
from app.db.models import Answer, Notification, Review, ReviewState, StoredFile
from app.permissions import Action, can

router = APIRouter(tags=["updates"])


class ChangedAnswer(BaseModel):
    id: uuid.UUID
    conversation_id: uuid.UUID | None
    status: str


class UpdatesOut(BaseModel):
    cursor: datetime
    answers: list[ChangedAnswer]
    notifications: list[NotificationOut]
    unread: int
    files_changed: bool
    reviews_waiting: int | None


@router.get("/updates", response_model=UpdatesOut)
def updates(me: CurrentUser, db: Db, since: datetime | None = None) -> UpdatesOut:
    cursor = now()
    answers: list[ChangedAnswer] = []
    new_notes: list[NotificationOut] = []
    files_changed = False
    if since is not None:
        changed = db.scalars(
            select(Answer)
            .where(Answer.asked_by == me.id, Answer.updated_at > since)
            .order_by(Answer.updated_at)
            .limit(50)
        ).all()
        answers = [
            ChangedAnswer(id=a.id, conversation_id=a.conversation_id, status=a.status.value)
            for a in changed
        ]
        new_notes = [
            out(n)
            for n in db.scalars(
                select(Notification)
                .where(Notification.user_id == me.id, Notification.created_at > since)
                .order_by(Notification.created_at.desc())
                .limit(20)
            )
        ]
        files_changed = bool(
            db.scalar(select(StoredFile.id).where(StoredFile.updated_at > since).limit(1))
        )
    waiting = None
    if can(me, Action.DECIDE_REVIEW):
        waiting = (
            db.scalar(
                select(func.count())
                .select_from(Review)
                .where(Review.state.in_([ReviewState.OPEN, ReviewState.CLAIMED]))
            )
            or 0
        )
    return UpdatesOut(
        cursor=cursor,
        answers=answers,
        notifications=new_notes,
        unread=unread_count(db, me),
        files_changed=files_changed,
        reviews_waiting=waiting,
    )
