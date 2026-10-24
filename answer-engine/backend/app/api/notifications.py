"""`/api/notifications`: the bell (SPEC section 6.11), and the "Stop these emails" link."""

import html
import uuid
from datetime import datetime

from fastapi import APIRouter, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy import func, select, update

from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.auth.tokens import now
from app.db.models import Notification, NotifyChannel, User
from app.notifications.service import check_stop_token

router = APIRouter(prefix="/notifications", tags=["notifications"])


class NotificationOut(BaseModel):
    id: uuid.UUID
    kind: str
    title: str
    body: str
    link: str | None
    created_at: datetime
    read_at: datetime | None


class NotificationList(BaseModel):
    unread: int
    items: list[NotificationOut]


class ReadIn(Strict):
    ids: list[uuid.UUID] | None = None  # None: mark everything read


def unread_count(db: Db, user: User) -> int:
    return (
        db.scalar(
            select(func.count())
            .select_from(Notification)
            .where(Notification.user_id == user.id, Notification.read_at.is_(None))
        )
        or 0
    )


def out(note: Notification) -> NotificationOut:
    return NotificationOut(
        id=note.id,
        kind=note.kind,
        title=note.title,
        body=note.body,
        link=note.link,
        created_at=note.created_at,
        read_at=note.read_at,
    )


@router.get("", response_model=NotificationList)
def list_notifications(
    me: CurrentUser, db: Db, limit: int = Query(default=30, ge=1, le=100)
) -> NotificationList:
    """Your own notifications, newest first. Everyone sees only their own."""
    notes = db.scalars(
        select(Notification)
        .where(Notification.user_id == me.id)
        .order_by(Notification.created_at.desc())
        .limit(limit)
    ).all()
    return NotificationList(unread=unread_count(db, me), items=[out(n) for n in notes])


@router.post("/read", response_model=NotificationList)
def mark_read(body: ReadIn, me: CurrentUser, db: Db) -> NotificationList:
    query = update(Notification).where(
        Notification.user_id == me.id, Notification.read_at.is_(None)
    )
    if body.ids is not None:
        query = query.where(Notification.id.in_(body.ids))
    db.execute(query.values(read_at=now()))
    db.commit()
    return list_notifications(me, db, limit=30)


# --- "Stop these emails": works without signing in, from the email itself --------------------


def _page(title: str, message: str, form: str = "", status: int = 200) -> HTMLResponse:
    body = (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width, initial-scale=1'>"
        f"<title>{html.escape(title)}</title></head>"
        "<body>"
        f"<h1>{html.escape(title)}</h1><p>{html.escape(message)}</p>{form}</body></html>"
    )
    return HTMLResponse(body, status_code=status)


def _who(db: Db, u: str, t: str) -> User | None:
    try:
        user_id = uuid.UUID(u)
    except ValueError:
        return None
    if not check_stop_token(user_id, t):
        return None
    return db.get(User, user_id)


@router.get("/stop-emails", response_class=HTMLResponse, include_in_schema=False)
def stop_emails_page(db: Db, u: str = "", t: str = "") -> HTMLResponse:
    """A page with one button. The change happens on the button press (a POST), so mail
    scanners that open links can't switch emails off by themselves."""
    user = _who(db, u, t)
    if user is None:
        return _page("This link doesn't work", "Change your emails on your Profile.", status=403)
    form = (
        f"<form method='post' action='/api/notifications/stop-emails?u={html.escape(u)}"
        f"&amp;t={html.escape(t)}'><button type='submit'>Stop these emails</button></form>"
    )
    return _page(
        "Stop notification emails?",
        f"{user.name}, you'll still see every notification in the Answer Engine.",
        form,
    )


@router.post("/stop-emails", response_class=HTMLResponse, include_in_schema=False)
def stop_emails(db: Db, u: str = "", t: str = "") -> HTMLResponse:
    user = _who(db, u, t)
    if user is None:
        return _page("This link doesn't work", "Change your emails on your Profile.", status=403)
    if user.notify_channel == NotifyChannel.EMAIL:
        user.notify_channel = NotifyChannel.IN_APP
        db.commit()
    return _page(
        "Done",
        "You won't get notification emails any more. You can turn them back on on your Profile.",
    )
