"""`/api/conversations`: the Ask screen (SPEC sections 6.5, 7.1 and 8)."""

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.answering.claude_answer import Answerer, get_answerer
from app.answering.service import answer_stream, start_turn
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.auth.tokens import now
from app.db.models import (
    Answer,
    AnswerStatus,
    Conversation,
    Message,
    TrashItem,
    TrashKind,
    User,
)
from app.errors import ApiError
from app.kb.store import VectorStore, get_store
from app.permissions import Action, ensure
from app.reviews import service as reviews

router = APIRouter(prefix="/conversations", tags=["conversations"])

NOT_SET_UP = "Answering isn't set up yet: the Owner needs to add the Claude and Pinecone API keys."


def answerer_dep() -> Answerer | None:
    return get_answerer()


def store_dep() -> VectorStore | None:
    return get_store()


class ConversationOut(BaseModel):
    id: uuid.UUID
    title: str
    last_message_at: datetime


class NeedsInfo(BaseModel):
    question: str
    asked_by: str


class AnswerOut(BaseModel):
    id: uuid.UUID
    sources: list[dict[str, Any]]
    outcome: str | None
    status: str
    stop_reason: str | None
    corrected: bool
    confidence: int | None
    feedback: str | None
    needs_info: NeedsInfo | None = None


class MessageOut(BaseModel):
    id: uuid.UUID
    role: str
    body: str
    created_at: datetime
    answer: AnswerOut | None


class ConversationDetail(ConversationOut):
    messages: list[MessageOut]


class AskIn(Strict):
    question: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)
    ]


class NewConversationIn(Strict):
    title: Annotated[str, Field(max_length=200)] = "New chat"


def _get(db: Session, conversation_id: uuid.UUID, me: User, action: Action) -> Conversation:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or conversation.deleted_at is not None:
        raise ApiError(404, "not_found", "That conversation doesn't exist.")
    mine = conversation.user_id == me.id
    if action == Action.VIEW_OTHERS_CONVERSATIONS:
        if not mine:
            ensure(me, Action.VIEW_OTHERS_CONVERSATIONS)
    elif not mine:
        raise ApiError(404, "not_found", "That conversation doesn't exist.")
    return conversation


def _needs_info(db: Session, answer: Answer) -> NeedsInfo | None:
    if answer.status != AnswerStatus.NEEDS_INFO:
        return None
    waiting = reviews.open_question(db, answer)
    if waiting is None:
        return None
    _, question = waiting
    author = db.get(User, question.author_id) if question.author_id else None
    return NeedsInfo(question=question.body, asked_by=author.name if author else "Our team")


def _message(db: Session, message: Message) -> MessageOut:
    answer = message.answer
    return MessageOut(
        id=message.id,
        role=message.role.value,
        # An assistant message shows the answer as it is now (it may have been corrected).
        body=answer.current_text if answer else message.body,
        created_at=message.created_at,
        answer=AnswerOut(
            id=answer.id,
            sources=answer.sources,
            outcome=answer.outcome.value if answer.outcome else None,
            status=answer.status.value,
            stop_reason=answer.stop_reason,
            corrected=answer.current_text != answer.original_text,
            confidence=answer.confidence,
            feedback=answer.feedback,
            needs_info=_needs_info(db, answer),
        )
        if answer
        else None,
    )


@router.get("", response_model=list[ConversationOut])
def list_conversations(me: CurrentUser, db: Db) -> list[ConversationOut]:
    ensure(me, Action.ASK)
    rows = db.scalars(
        select(Conversation)
        .where(Conversation.user_id == me.id, Conversation.deleted_at.is_(None))
        .order_by(Conversation.last_message_at.desc())
        .limit(200)
    ).all()
    return [
        ConversationOut(id=c.id, title=c.title, last_message_at=c.last_message_at) for c in rows
    ]


@router.post("", response_model=ConversationOut, status_code=201)
def create_conversation(body: NewConversationIn, me: CurrentUser, db: Db) -> ConversationOut:
    ensure(me, Action.ASK)
    conversation = Conversation(user_id=me.id, title=body.title.strip() or "New chat")
    db.add(conversation)
    db.commit()
    db.refresh(conversation)
    return ConversationOut(
        id=conversation.id, title=conversation.title, last_message_at=conversation.last_message_at
    )


@router.get("/{conversation_id}", response_model=ConversationDetail)
def get_conversation(conversation_id: uuid.UUID, me: CurrentUser, db: Db) -> ConversationDetail:
    ensure(me, Action.ASK)
    conversation = _get(db, conversation_id, me, Action.VIEW_OTHERS_CONVERSATIONS)
    messages = db.scalars(
        select(Message)
        .options(selectinload(Message.answer))
        .where(Message.conversation_id == conversation.id)
        .order_by(Message.position)
    ).all()
    return ConversationDetail(
        id=conversation.id,
        title=conversation.title,
        last_message_at=conversation.last_message_at,
        messages=[_message(db, m) for m in messages],
    )


@router.delete("/{conversation_id}", status_code=204)
def delete_conversation(conversation_id: uuid.UUID, me: CurrentUser, db: Db) -> None:
    ensure(me, Action.ASK)
    conversation = _get(db, conversation_id, me, Action.ASK)
    conversation.deleted_at = now()
    db.add(
        TrashItem(
            kind=TrashKind.CONVERSATION,
            ref_id=conversation.id,
            title=conversation.title,
            deleted_by=me.id,
            deleted_at=conversation.deleted_at,
        )
    )
    db.commit()


@router.post("/{conversation_id}/ask")
def ask(
    conversation_id: uuid.UUID,
    body: AskIn,
    me: CurrentUser,
    db: Db,
    answerer: Annotated[Answerer | None, Depends(answerer_dep)],
    store: Annotated[VectorStore | None, Depends(store_dep)],
) -> StreamingResponse:
    """Streams server-sent events: `delta` {text}… then `sources`, `done` (or `error`)."""
    ensure(me, Action.ASK)
    conversation = _get(db, conversation_id, me, Action.ASK)
    if answerer is None or store is None:
        raise ApiError(503, "not_configured", NOT_SET_UP)
    turn = start_turn(db, conversation, body.question)
    return StreamingResponse(
        answer_stream(db.get_bind(), turn, answerer, store),  # type: ignore[arg-type]
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
