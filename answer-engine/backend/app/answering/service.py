"""One question and its streamed answer (SPEC section 6.5).

The question is saved first. Then the stream: rewrite a follow-up into a standalone
question, search, stream Claude's answer, map its [n] citations to sources, and save the
answer. If answering fails, the question is withdrawn so it can simply be asked again.
"""

import json
import logging
import uuid
from collections.abc import Generator
from dataclasses import dataclass
from typing import Any, Literal

from anthropic.types.beta import BetaMessageParam
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from app.ai import usage as usage_log
from app.ai.usage import Usage
from app.answering.claude_answer import Answerer, Completion
from app.answering.prompts import (
    NO_ANSWER,
    REFUSED,
    ContextItem,
    cited_numbers,
    question_message,
    strip_citations,
)
from app.answering.retrieval import retrieve
from app.auth.tokens import now
from app.db.models import (
    Answer,
    AnswerKind,
    AnswerOutcome,
    Conversation,
    Message,
    MessageRole,
    UsageKind,
)
from app.kb.store import VectorStore

log = logging.getLogger(__name__)

HISTORY_MESSAGES = 10
TITLE_LENGTH = 80
BUSY = "The answer service is busy, please try again."


@dataclass(frozen=True)
class Turn:
    conversation_id: uuid.UUID
    user_id: uuid.UUID
    question_message_id: uuid.UUID
    question: str
    history: list[BetaMessageParam]
    transcript: str


def event(name: str, data: dict[str, Any]) -> str:
    return f"event: {name}\ndata: {json.dumps(data)}\n\n"


def _history(messages: list[Message]) -> list[BetaMessageParam]:
    """The last messages as Claude turns: corrected answers in place of the originals,
    without their old [n] citations, starting with the user and alternating."""
    turns: list[BetaMessageParam] = []
    for message in messages[-HISTORY_MESSAGES:]:
        role: Literal["user", "assistant"]
        if message.role == MessageRole.ASSISTANT:
            text = message.answer.current_text if message.answer else message.body
            role, text = "assistant", strip_citations(text)
        else:
            role, text = "user", message.body
        if not turns and role == "assistant":
            continue
        if turns and turns[-1]["role"] == role:
            turns[-1] = {"role": role, "content": f"{turns[-1]['content']}\n\n{text}"}
        else:
            turns.append({"role": role, "content": text})
    if turns and turns[-1]["role"] == "user":
        turns.pop()  # an unanswered question; the new one follows
    return turns


def start_turn(db: Session, conversation: Conversation, question: str) -> Turn:
    """Save the question; return what answering needs."""
    db.refresh(conversation, with_for_update=True)  # one question at a time per chat
    earlier = list(
        db.scalars(
            select(Message)
            .where(Message.conversation_id == conversation.id)
            .order_by(Message.position)
        )
    )
    position = (earlier[-1].position + 1) if earlier else 0
    message = Message(
        conversation_id=conversation.id, role=MessageRole.USER, body=question, position=position
    )
    db.add(message)
    if not earlier:
        conversation.title = (
            question if len(question) <= TITLE_LENGTH else question[: TITLE_LENGTH - 1] + "…"
        )
    conversation.last_message_at = now()
    db.commit()
    history = _history(earlier)
    transcript = "\n".join(f"{turn['role'].title()}: {turn['content']}" for turn in history)
    return Turn(conversation.id, conversation.user_id, message.id, question, history, transcript)


def _sources(items: list[ContextItem], text: str) -> list[dict[str, Any]]:
    by_number = {item.n: item for item in items}
    return [
        {
            "n": item.n,
            "kind": "doc",
            "ref_id": item.chunk_id,
            "file_id": item.file_id,
            "file_name": item.file_name,
            "label": item.label,
            "page": item.page_from,
            "sheet": item.sheet,
            "score": item.score,
        }
        for n in cited_numbers(text)
        if (item := by_number.get(n)) is not None
    ]


def answer_stream(
    bind: Engine, turn: Turn, answerer: Answerer, store: VectorStore
) -> Generator[str, None, None]:
    """Server-sent events: delta… (replace) sources done, or error."""
    with Session(bind, expire_on_commit=False) as db:
        spent = Usage()
        streamed = ""
        completion: Completion | None = None
        items: list[ContextItem] = []
        retrieval_query = turn.question
        saved = False
        pieces: Generator[str, None, Completion] | None = None
        try:
            if turn.history:
                rewritten = answerer.rewrite(turn.transcript, turn.question)
                spent.add(rewritten.model, rewritten.input_tokens, rewritten.output_tokens)
                if rewritten.stop_reason != "refusal" and rewritten.text:
                    retrieval_query = rewritten.text
            items = retrieve(db, store, retrieval_query)

            if not items:
                text = NO_ANSWER
                yield event("delta", {"text": text})
            else:
                pieces = answerer.stream(turn.history, question_message(items, turn.question))
                while True:
                    try:
                        piece = next(pieces)
                    except StopIteration as finished:
                        completion = finished.value
                        break
                    streamed += piece
                    yield event("delta", {"text": piece})
                spent.add(completion.model, completion.input_tokens, completion.output_tokens)
                text = REFUSED if completion.stop_reason == "refusal" else completion.text
                if text != streamed.strip():
                    # A fallback model took over, or the answer was declined: the saved text
                    # is the final message, so show exactly that.
                    yield event("replace", {"text": text})
        except GeneratorExit:
            # The person closed the page mid-answer: keep what was said so far.
            if streamed and not saved:
                _save(
                    db, turn, retrieval_query, streamed, items, completion, spent, "client_closed"
                )
            raise
        except Exception:
            log.exception("answering failed")
            question = db.get(Message, turn.question_message_id)
            if question is not None:
                db.delete(question)  # withdrawn, so asking again starts cleanly
                db.commit()
            yield event("error", {"message": BUSY})
            return

        answer = _save(db, turn, retrieval_query, text, items, completion, spent, None)
        saved = True
        yield event("sources", {"sources": answer.sources})
        yield event(
            "done",
            {
                "answer_id": str(answer.id),
                "outcome": answer.outcome.value if answer.outcome else None,
                "stop_reason": answer.stop_reason,
            },
        )


def _save(
    db: Session,
    turn: Turn,
    retrieval_query: str,
    text: str,
    items: list[ContextItem],
    completion: Completion | None,
    spent: Usage,
    stop_override: str | None,
) -> Answer:
    no_answer = not items or text.strip() == NO_ANSWER
    answer = Answer(
        kind=AnswerKind.CHAT,
        asked_by=turn.user_id,
        conversation_id=turn.conversation_id,
        question=turn.question,
        retrieval_query=retrieval_query,
        original_text=text,
        current_text=text,
        sources=[] if no_answer else _sources(items, text),
        outcome=AnswerOutcome.NO_ANSWER if no_answer else None,
        model=completion.model if completion else None,
        stop_reason=stop_override or (completion.stop_reason if completion else None),
        usage={
            "requests": spent.requests,
            "input_tokens": spent.input_tokens,
            "output_tokens": spent.output_tokens,
            "cache_read_tokens": completion.cache_read_tokens if completion else 0,
            "cost_usd": round(spent.cost_usd, 6),
            "context": [item.chunk_id for item in items],
        },
    )
    db.add(answer)
    db.flush()
    position = db.scalar(
        select(func.max(Message.position)).where(Message.conversation_id == turn.conversation_id)
    )
    db.add(
        Message(
            conversation_id=turn.conversation_id,
            role=MessageRole.ASSISTANT,
            body=text,
            answer_id=answer.id,
            position=(position or 0) + 1,
        )
    )
    conversation = db.get(Conversation, turn.conversation_id)
    if conversation is not None:
        conversation.last_message_at = now()
    usage_log.record(db, turn.user_id, UsageKind.ANSWER, spent)
    db.commit()
    if completion and completion.cache_read_tokens:
        log.info("answer read %s tokens from the prompt cache", completion.cache_read_tokens)
    return answer
